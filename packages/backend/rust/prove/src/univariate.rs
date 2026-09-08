//! U22--U24 prover primitives for the univariate protocol.

use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::memory::HostSlice;
use libs::field_structures::FieldSerde;
use libs::frontend_artifacts::public_wire_layout::{PublicQueryKey, PublicWireLayout};
use libs::frontend_artifacts::{Instance, PlacementVariables, SetupParams};
use libs::group_structures::G1serde;
use libs::ntt_domain::init_ntt_domain_for_size;
use libs::univariate_crs::{
    UnivariateCommitmentSource, UnivariateCrs, UnivariateCrsShape, UnivariateQueryIndex,
    UnivariateTaggedQuery,
};
use libs::univariate_polynomial::{DenseUnivariatePolynomial, UnivariatePolynomialError};
use libs::univariate_proof::UnivariateProof;
use libs::univariate_relation::{DenseDomainPolynomial, StridedPolynomial, WitnessMaps};
use libs::univariate_transcript::{
    CanonicalTranscriptEncoder, UnivariateChallenges, UnivariateFiatShamirInput,
    UnivariateTranscript,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UnivariateProverError {
    #[error(transparent)]
    Polynomial(#[from] UnivariatePolynomialError),
    #[error("selector degree exceeds the arithmetic domain")]
    SelectorDegree,
    #[error("copy recursion denominator vanishes at connection-domain index {index}")]
    CopyDenominator { index: usize },
    #[error("copy recursion does not close around the connection domain")]
    CopyRecurrenceDoesNotClose,
    #[error("ICICLE NTT failed while constructing the copy relation: {0:?}")]
    Ntt(icicle_runtime::errors::eIcicleError),
    #[error("the U28 opening point is zero or belongs to an evaluation domain")]
    InvalidOpeningPoint,
    #[error("selector and compact placement artifacts do not describe the same active slots")]
    SelectorPlacementMismatch,
    #[error("public instance has {actual} values, expected {expected}")]
    PublicInstanceLength { actual: usize, expected: usize },
    #[error("public binding query ({subcircuit_id}, {local_wire_index}) is absent or duplicated")]
    InvalidPublicBindingQuery {
        subcircuit_id: usize,
        local_wire_index: usize,
    },
    #[error(
        "missing {role} U20 query for ({placement_index}, {subcircuit_id}, {local_wire_index})"
    )]
    MissingBindingQuery {
        role: &'static str,
        placement_index: usize,
        subcircuit_id: usize,
        local_wire_index: usize,
    },
    #[error("duplicate {role} witness-binding coordinate ({placement_index}, {subcircuit_id}, {local_wire_index})")]
    DuplicateBindingCoordinate {
        role: &'static str,
        placement_index: usize,
        subcircuit_id: usize,
        local_wire_index: usize,
    },
    #[error("{role} randomizer has {actual} coefficients, exceeding its U22 bound {bound}")]
    BlindingDegree {
        role: &'static str,
        actual: usize,
        bound: usize,
    },
}

/// U22 prover masks.  The caller samples these independently; this structure
/// keeps the deterministic polynomial stage separate from randomness source.
#[derive(Clone)]
pub struct ArithmeticMaskRandomizers {
    pub u: DenseUnivariatePolynomial,
    pub v: DenseUnivariatePolynomial,
    pub w: DenseUnivariatePolynomial,
    pub b: DenseUnivariatePolynomial,
}

/// U23 blinded witness maps and U24's masked arithmetic quotient.
pub struct MaskedArithmeticWitness {
    pub u_hat: DenseUnivariatePolynomial,
    pub v_hat: DenseUnivariatePolynomial,
    pub w_hat: DenseUnivariatePolynomial,
    pub b_hat: DenseUnivariatePolynomial,
    pub q_a: DenseUnivariatePolynomial,
}

/// U23/U25 connection recursion and its two exact copy quotients.
pub struct MaskedCopyRelation {
    pub r_hat: DenseUnivariatePolynomial,
    pub q_c_0: DenseUnivariatePolynomial,
    pub q_c_1: DenseUnivariatePolynomial,
}

/// One active, non-public wire value with the U20 coordinate that authenticates
/// it. The frontend-to-prover adapter constructs these only from the selected
/// local witness positions; this primitive deliberately does not infer roles
/// from placement order.
#[derive(Clone, Copy)]
pub struct TaggedWitnessValue {
    pub placement_index: usize,
    pub subcircuit_id: usize,
    pub local_wire_index: usize,
    pub value: ScalarField,
}

/// Selector-aligned active witness values and their non-public U20 terms.
/// Inactive selector slots remain `None` rather than being erased.
pub struct SelectedWitnessValues {
    pub slot_values: Vec<Option<Box<[ScalarField]>>>,
    pub interface_values: Vec<TaggedWitnessValue>,
    pub internal_values: Vec<TaggedWitnessValue>,
}

/// One public statement coordinate projected to the compressed U20 key.
#[derive(Clone, Copy)]
pub struct PublicWitnessValue {
    pub key: PublicQueryKey,
    pub value: ScalarField,
}

/// The two private binding commitments sent in the first prover message.
pub struct PrivateBindingCommitments {
    pub o_if: G1serde,
    pub o_int: G1serde,
}

/// U28 values sampled after the U25 quotient commitment is fixed.
pub struct UnivariateEvaluations {
    pub s_a: ScalarField,
    pub s_c: ScalarField,
    pub u: ScalarField,
    pub v: ScalarField,
    pub w: ScalarField,
    pub b: ScalarField,
    pub q_zeta: ScalarField,
    pub r: ScalarField,
    pub r_plus: ScalarField,
}

/// F5's eight mixed-source opening quotients and the shifted `R` quotient.
pub struct UnivariateOpeningPolynomials {
    pub pi_zeta_terms: [DenseUnivariatePolynomial; 8],
    pub pi_plus: DenseUnivariatePolynomial,
    pub evaluations: UnivariateEvaluations,
}

/// All deterministic inputs and sampled masks required by the correctness-
/// first F1--F5 prover. Artifact readers construct this only after their own
/// selector, permutation, witness, and CRS admission checks succeed.
pub struct UnivariateReferenceProvingInput<'a> {
    pub crs: &'a UnivariateCrs,
    pub selector: &'a StridedPolynomial,
    pub s_c: &'a DenseDomainPolynomial,
    pub maps: &'a WitnessMaps,
    pub interface_values: &'a [TaggedWitnessValue],
    pub internal_values: &'a [TaggedWitnessValue],
    pub randomizers: ArithmeticMaskRandomizers,
    pub recursion_randomizer: &'a DenseUnivariatePolynomial,
    pub binding_randomizer: ScalarField,
    pub fiat_shamir: UnivariateFiatShamirInput,
}

/// Serializes the U52 messages produced by the native polynomial stages into
/// the separate U54 proof family. No legacy Solidity proof field is reused.
pub fn assemble_univariate_proof(
    crs: &UnivariateCrs,
    masked: &MaskedArithmeticWitness,
    private_binding: &PrivateBindingCommitments,
    copy: &MaskedCopyRelation,
    q_hat: &DenseUnivariatePolynomial,
    openings: &UnivariateOpeningPolynomials,
    upsilon: ScalarField,
    varpi: ScalarField,
) -> Result<UnivariateProof, UnivariateProverError> {
    let commit = |source, polynomial: &DenseUnivariatePolynomial, offset| {
        crs.commit_tagged_dense_polynomial(source, polynomial.coefficients(), offset)
            .map_err(|_| UnivariateProverError::SelectorDegree)
    };
    let c_u = commit(UnivariateCommitmentSource::S0, &masked.u_hat, 0)?;
    let c_v = commit(UnivariateCommitmentSource::Sxi, &masked.v_hat, 0)?;
    let c_w = commit(UnivariateCommitmentSource::Spsi, &masked.w_hat, 0)?;
    let c_b = commit(
        UnivariateCommitmentSource::Spsi,
        &masked.b_hat,
        crs.foundation.shape.k,
    )?;
    let c_r = commit(UnivariateCommitmentSource::S0, &copy.r_hat, 0)?;
    let c_q = commit(UnivariateCommitmentSource::S0, q_hat, 0)?;
    let factors = [
        ScalarField::one(),
        varpi,
        varpi * varpi,
        varpi.pow(3),
        varpi.pow(4),
        varpi.pow(5),
        varpi.pow(6),
        varpi.pow(7),
    ];
    let sources = [
        UnivariateCommitmentSource::S0,
        UnivariateCommitmentSource::Sxi,
        UnivariateCommitmentSource::Spsi,
        UnivariateCommitmentSource::Spsi,
        UnivariateCommitmentSource::S0,
        UnivariateCommitmentSource::S0,
        UnivariateCommitmentSource::S0,
        UnivariateCommitmentSource::S0,
    ];
    let offsets = [0, 0, 0, crs.foundation.shape.k, 0, 0, 0, 0];
    let mut pi_zeta = G1serde::zero();
    for index in 0..8 {
        pi_zeta = pi_zeta
            + commit(
                sources[index],
                &openings.pi_zeta_terms[index],
                offsets[index],
            )? * factors[index];
    }
    Ok(UnivariateProof {
        protocol_schema_id: libs::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID.to_string(),
        c_u,
        c_v,
        c_w,
        c_b,
        o_if: private_binding.o_if,
        o_int: private_binding.o_int,
        c_d: c_w + c_b * upsilon,
        c_r,
        c_q,
        s_a: FieldSerde(openings.evaluations.s_a),
        s_c: FieldSerde(openings.evaluations.s_c),
        u: FieldSerde(openings.evaluations.u),
        v: FieldSerde(openings.evaluations.v),
        w: FieldSerde(openings.evaluations.w),
        b: FieldSerde(openings.evaluations.b),
        q_zeta: FieldSerde(openings.evaluations.q_zeta),
        r: FieldSerde(openings.evaluations.r),
        r_plus: FieldSerde(openings.evaluations.r_plus),
        pi_zeta,
        pi_plus: commit(UnivariateCommitmentSource::S0, &openings.pi_plus, 0)?,
    })
}

/// Runs the complete F1--F5 native reference schedule. The caller supplies
/// canonical F1 bytes; this function owns only protocol message framing and
/// the algebra that follows successful artifact admission.
pub fn prove_univariate_reference(
    input: UnivariateReferenceProvingInput<'_>,
) -> Result<(UnivariateProof, UnivariateChallenges), UnivariateProverError> {
    let shape = &input.crs.foundation.shape;
    let randomizers = input.randomizers;
    let masked =
        build_masked_arithmetic_witness(shape, input.selector, input.maps, randomizers.clone())?;
    let private = build_private_binding_commitments(
        input.crs,
        &input.crs.query_index(),
        input.interface_values,
        input.internal_values,
        &randomizers,
        input.binding_randomizer,
    )?;
    let commit = |source, polynomial: &DenseUnivariatePolynomial, offset| {
        input
            .crs
            .commit_tagged_dense_polynomial(source, polynomial.coefficients(), offset)
            .map_err(|_| UnivariateProverError::SelectorDegree)
    };
    let c_u = commit(UnivariateCommitmentSource::S0, &masked.u_hat, 0)?;
    let c_v = commit(UnivariateCommitmentSource::Sxi, &masked.v_hat, 0)?;
    let c_w = commit(UnivariateCommitmentSource::Spsi, &masked.w_hat, 0)?;
    let c_b = commit(UnivariateCommitmentSource::Spsi, &masked.b_hat, shape.k)?;
    let mut transcript = UnivariateTranscript::from_f1(input.fiat_shamir);
    transcript.append_message_block(
        1,
        &encode_g1_block("F2.a1", &[c_u, c_v, c_w, c_b, private.o_if, private.o_int]),
    );
    let upsilon = transcript.challenge(1, 0);
    let c_d = c_w + c_b * upsilon;
    transcript.append_message_block(2, &encode_g1_block("F2.a2", &[c_d]));
    let beta = transcript.challenge(2, 0);
    let gamma_c = transcript.challenge(2, 1);
    let copy = build_masked_copy_relation(
        shape,
        input.maps,
        input.s_c,
        &masked.b_hat,
        beta,
        gamma_c,
        input.recursion_randomizer,
    )?;
    let c_r = commit(UnivariateCommitmentSource::S0, &copy.r_hat, 0)?;
    transcript.append_message_block(3, &encode_g1_block("F2.a3", &[c_r]));
    let theta = transcript.challenge(3, 0);
    let q_hat = combine_quotients(shape, &masked.q_a, &copy, theta)?;
    let c_q = commit(UnivariateCommitmentSource::S0, &q_hat, 0)?;
    transcript.append_message_block(4, &encode_g1_block("F2.a4", &[c_q]));
    let zeta = transcript.zeta(shape.arithmetic_domain_size, shape.connection_domain_size);
    let openings = build_opening_polynomials(
        shape,
        input.selector,
        input.s_c,
        &masked.u_hat,
        &masked.v_hat,
        &masked.w_hat,
        &masked.b_hat,
        &copy.r_hat,
        &q_hat,
        zeta,
    )?;
    transcript.append_message_block(5, &encode_evaluations(&openings.evaluations));
    let varpi = transcript.challenge(5, 0);
    let proof = assemble_univariate_proof(
        input.crs, &masked, &private, &copy, &q_hat, &openings, upsilon, varpi,
    )?;
    transcript.append_message_block(
        6,
        &encode_g1_block("F2.a6", &[proof.pi_zeta, proof.pi_plus]),
    );
    let mu = transcript.nonzero_challenge(6, 0);
    Ok((
        proof,
        UnivariateChallenges {
            upsilon,
            beta,
            gamma_c,
            theta,
            zeta,
            varpi,
            mu,
        },
    ))
}

fn encode_g1_block(label: &str, points: &[G1serde]) -> Vec<u8> {
    let mut encoder = CanonicalTranscriptEncoder::new().u32("count", points.len() as u32);
    for (index, point) in points.iter().enumerate() {
        encoder = encoder.g1(&format!("{label}.{index}"), point);
    }
    encoder.finish()
}

fn encode_evaluations(evaluations: &UnivariateEvaluations) -> Vec<u8> {
    CanonicalTranscriptEncoder::new()
        .scalar("sA", &evaluations.s_a)
        .scalar("sC", &evaluations.s_c)
        .scalar("u", &evaluations.u)
        .scalar("v", &evaluations.v)
        .scalar("w", &evaluations.w)
        .scalar("b", &evaluations.b)
        .scalar("qZeta", &evaluations.q_zeta)
        .scalar("r", &evaluations.r)
        .scalar("rPlus", &evaluations.r_plus)
        .finish()
}

/// U25's single quotient.  The complementary vanishing factors belong to
/// the verifier's combined identity; the quotient itself is the theta-linear
/// combination of the three exact per-domain quotients.
pub fn combine_quotients(
    shape: &UnivariateCrsShape,
    q_a: &DenseUnivariatePolynomial,
    copy: &MaskedCopyRelation,
    theta: ScalarField,
) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    let m_a = complementary_factor(shape.connection_domain_size, shape.intersection_domain_size)?;
    let m_c = complementary_factor(shape.arithmetic_domain_size, shape.intersection_domain_size)?;
    Ok(q_a
        .multiply(&m_a)?
        .add(&copy.q_c_0.multiply(&m_c)?.scale(theta))
        .add(&copy.q_c_1.multiply(&m_c)?.scale(theta * theta)))
}

/// Builds U27 from explicitly classified active wire values. Query lookup is
/// exact in all three coordinates, so a value cannot be rebound to another
/// placement or library entry. The later frontend adapter owns the conversion
/// from selector-bearing synthesis output to these terms.
pub fn build_private_binding_commitments(
    crs: &UnivariateCrs,
    query_index: &UnivariateQueryIndex,
    interface_values: &[TaggedWitnessValue],
    internal_values: &[TaggedWitnessValue],
    randomizers: &ArithmeticMaskRandomizers,
    r_o: ScalarField,
) -> Result<PrivateBindingCommitments, UnivariateProverError> {
    let o_if = combine_tagged_queries(
        "interface",
        interface_values,
        &crs.eta_inv_interface_queries,
        |key| query_index.interface_index(key),
    )? + crs.delta_g1 * r_o;
    let mut o_int = combine_tagged_queries(
        "internal",
        internal_values,
        &crs.delta_inv_internal_queries,
        |key| query_index.internal_index(key),
    )? - crs.eta_g1 * r_o;
    let masks = [
        &randomizers.u,
        &randomizers.v,
        &randomizers.w,
        &randomizers.b,
    ];
    let masking_queries = [
        &crs.delta_inv_u_masking_queries,
        &crs.delta_inv_v_masking_queries,
        &crs.delta_inv_w_masking_queries,
        &crs.delta_inv_b_masking_queries,
    ];
    for (index, (randomizer, queries)) in masks.into_iter().zip(masking_queries).enumerate() {
        if randomizer.coefficients().len() > queries.len() {
            return Err(UnivariateProverError::BlindingDegree {
                role: ["U", "V", "W", "B"][index],
                actual: randomizer.coefficients().len(),
                bound: queries.len(),
            });
        }
        for (coefficient, query) in randomizer.coefficients().iter().zip(queries.iter()) {
            o_int = o_int + *query * *coefficient;
        }
    }
    Ok(PrivateBindingCommitments { o_if, o_int })
}

/// Uses the synthesizer's global-wire public projection: user values, block
/// values, then function values. Padding has no U20 query and is retained only
/// in the statement encoding, not in the binding MSM.
pub fn project_public_binding_values(
    instance: &Instance,
    setup: &SetupParams,
    layout: &PublicWireLayout,
) -> Result<Vec<PublicWitnessValue>, UnivariateProverError> {
    let values = instance
        .a_pub_user
        .iter()
        .chain(instance.a_pub_block.iter())
        .chain(instance.a_pub_function.iter())
        .map(|value| ScalarField::from_hex(value.as_ref()))
        .collect::<Vec<_>>();
    if values.len() != setup.l || layout.len() != setup.l {
        return Err(UnivariateProverError::PublicInstanceLength {
            actual: values.len(),
            expected: setup.l,
        });
    }
    Ok(values
        .into_iter()
        .enumerate()
        .filter_map(|(global_wire_index, value)| {
            layout
                .public_query_key_for_public_wire(global_wire_index)
                .map(|key| PublicWitnessValue { key, value })
        })
        .collect())
}

/// Computes U26 from the already-admitted public projection.
pub fn build_public_binding_commitment(
    crs: &UnivariateCrs,
    query_index: &UnivariateQueryIndex,
    values: &[PublicWitnessValue],
) -> Result<G1serde, UnivariateProverError> {
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    let mut result = G1serde::zero();
    for value in values {
        if !seen.insert(value.key) {
            return Err(UnivariateProverError::InvalidPublicBindingQuery {
                subcircuit_id: value.key.buffer_subcircuit_id,
                local_wire_index: value.key.local_public_wire_index,
            });
        }
        let query = query_index
            .public_index(value.key)
            .and_then(|index| crs.gamma_inv_public_queries.get(index))
            .ok_or(UnivariateProverError::InvalidPublicBindingQuery {
                subcircuit_id: value.key.buffer_subcircuit_id,
                local_wire_index: value.key.local_public_wire_index,
            })?;
        result = result + query.point * value.value;
    }
    Ok(result)
}

/// Aligns the compact synthesizer placement list with the capacity-length
/// selector before U8 and U27 consume it. The compact list is read only in
/// active-selector order; no prefix-placement convention is assumed.
pub fn select_witness_values(
    selector: &[Option<usize>],
    placements: &[PlacementVariables],
    setup: &SetupParams,
    subcircuits: &[libs::univariate_relation::UnivariateSubcircuit<'_>],
) -> Result<SelectedWitnessValues, UnivariateProverError> {
    if selector.len() != setup.s_max {
        return Err(UnivariateProverError::SelectorPlacementMismatch);
    }
    let mut cursor = 0usize;
    let mut slots = Vec::with_capacity(selector.len());
    let mut interface_values = Vec::new();
    let mut internal_values = Vec::new();
    for (placement_index, selected) in selector.iter().copied().enumerate() {
        let Some(subcircuit_id) = selected else {
            slots.push(None);
            continue;
        };
        let placement = placements
            .get(cursor)
            .ok_or(UnivariateProverError::SelectorPlacementMismatch)?;
        cursor += 1;
        if placement.subcircuitId != subcircuit_id {
            return Err(UnivariateProverError::SelectorPlacementMismatch);
        }
        let subcircuit = subcircuits
            .get(subcircuit_id)
            .ok_or(UnivariateProverError::SelectorPlacementMismatch)?;
        if placement.variables.len() != subcircuit.flatten_map.len() {
            return Err(UnivariateProverError::SelectorPlacementMismatch);
        }
        let values = placement
            .variables
            .iter()
            .map(|value| ScalarField::from_hex(value.as_ref()))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        for (local_wire_index, global_wire_index) in
            subcircuit.flatten_map.iter().copied().enumerate()
        {
            let term = TaggedWitnessValue {
                placement_index,
                subcircuit_id,
                local_wire_index,
                value: values[local_wire_index],
            };
            if global_wire_index >= setup.l && global_wire_index < setup.l_D {
                interface_values.push(term);
            } else if global_wire_index >= setup.l_D {
                internal_values.push(term);
            }
        }
        slots.push(Some(values));
    }
    if cursor != placements.len() {
        return Err(UnivariateProverError::SelectorPlacementMismatch);
    }
    Ok(SelectedWitnessValues {
        slot_values: slots,
        interface_values,
        internal_values,
    })
}

/// Builds F4's nine evaluations and F5's two opening quotients after all
/// witness and preprocessing commitments have been fixed.
#[allow(clippy::too_many_arguments)]
pub fn build_opening_polynomials(
    shape: &UnivariateCrsShape,
    selector: &StridedPolynomial,
    s_c: &DenseDomainPolynomial,
    u_hat: &DenseUnivariatePolynomial,
    v_hat: &DenseUnivariatePolynomial,
    w_hat: &DenseUnivariatePolynomial,
    b_hat: &DenseUnivariatePolynomial,
    r_hat: &DenseUnivariatePolynomial,
    q_hat: &DenseUnivariatePolynomial,
    zeta: ScalarField,
) -> Result<UnivariateOpeningPolynomials, UnivariateProverError> {
    validate_opening_point(shape, zeta)?;
    let selector = dense_selector(selector, shape.arithmetic_domain_size)?;
    let s_c = domain_polynomial(s_c)?;
    let evaluations = UnivariateEvaluations {
        s_a: selector.evaluate(zeta),
        s_c: s_c.evaluate(zeta),
        u: u_hat.evaluate(zeta),
        v: v_hat.evaluate(zeta),
        w: w_hat.evaluate(zeta),
        b: b_hat.evaluate(zeta),
        q_zeta: q_hat.evaluate(zeta),
        r: r_hat.evaluate(zeta),
        r_plus: r_hat.evaluate(shape.connection_root * zeta),
    };
    let pi_zeta_terms = [
        u_hat.ruffini(zeta).0,
        v_hat.ruffini(zeta).0,
        w_hat.ruffini(zeta).0,
        b_hat.ruffini(zeta).0,
        r_hat.ruffini(zeta).0,
        q_hat.ruffini(zeta).0,
        selector.ruffini(zeta).0,
        s_c.ruffini(zeta).0,
    ];
    let (pi_plus, r_plus_value) = r_hat
        .sub(&constant(evaluations.r_plus))
        .ruffini(shape.connection_root * zeta);
    debug_assert_eq!(r_plus_value, ScalarField::zero());
    Ok(UnivariateOpeningPolynomials {
        pi_zeta_terms,
        pi_plus,
        evaluations,
    })
}

/// Builds U23 and U24.  Exact vanishing division is an admission boundary:
/// malformed witness maps cannot become a silently truncated quotient.
pub fn build_masked_arithmetic_witness(
    shape: &UnivariateCrsShape,
    selector: &StridedPolynomial,
    maps: &WitnessMaps,
    randomizers: ArithmeticMaskRandomizers,
) -> Result<MaskedArithmeticWitness, UnivariateProverError> {
    let u_hat = blind(
        domain_polynomial(&maps.u_a)?,
        &randomizers.u,
        shape.arithmetic_domain_size,
    )?;
    let v_hat = blind(
        domain_polynomial(&maps.v_a)?,
        &randomizers.v,
        shape.arithmetic_domain_size,
    )?;
    let w_hat = blind(
        domain_polynomial(&maps.w_a)?,
        &randomizers.w,
        shape.arithmetic_domain_size,
    )?;
    let b_hat = blind(
        domain_polynomial(&maps.b_c)?,
        &randomizers.b,
        shape.connection_domain_size,
    )?;
    let selector = dense_selector(selector, shape.arithmetic_domain_size)?;
    let relation = u_hat.multiply(&v_hat)?.sub(&w_hat);
    let q_a = selector
        .multiply(&relation)?
        .divide_vanishing_exact(shape.arithmetic_domain_size)?;
    Ok(MaskedArithmeticWitness {
        u_hat,
        v_hat,
        w_hat,
        b_hat,
        q_a,
    })
}

/// Builds the blinded U15 recursion and U16 copy quotients used by U25.
pub fn build_masked_copy_relation(
    shape: &UnivariateCrsShape,
    maps: &WitnessMaps,
    s_c: &DenseDomainPolynomial,
    b_hat: &DenseUnivariatePolynomial,
    beta: ScalarField,
    gamma_c: ScalarField,
    r_r: &DenseUnivariatePolynomial,
) -> Result<MaskedCopyRelation, UnivariateProverError> {
    let domain_size = shape.connection_domain_size;
    if maps.b_c.evaluations.len() != domain_size || s_c.evaluations.len() != domain_size {
        return Err(UnivariateProverError::CopyRecurrenceDoesNotClose);
    }
    let mut f_evaluations = vec![ScalarField::zero(); domain_size];
    let mut g_evaluations = vec![ScalarField::zero(); domain_size];
    let mut point = ScalarField::one();
    for index in 0..domain_size {
        let b = maps.b_c.evaluations[index];
        f_evaluations[index] = b + beta * s_c.evaluations[index] + gamma_c;
        g_evaluations[index] = b + beta * point + gamma_c;
        if g_evaluations[index] == ScalarField::zero() {
            return Err(UnivariateProverError::CopyDenominator { index });
        }
        point = point * shape.connection_root;
    }
    let mut r_evaluations = vec![ScalarField::zero(); domain_size];
    r_evaluations[0] = ScalarField::one();
    for index in 0..domain_size - 1 {
        r_evaluations[index + 1] =
            r_evaluations[index] * f_evaluations[index] * g_evaluations[index].inv();
    }
    if r_evaluations[domain_size - 1] * f_evaluations[domain_size - 1]
        != g_evaluations[domain_size - 1]
    {
        return Err(UnivariateProverError::CopyRecurrenceDoesNotClose);
    }
    let r_c = DenseUnivariatePolynomial::new(interpolate(&r_evaluations)?.into_boxed_slice())?;
    let r_hat = blind(r_c, r_r, domain_size)?;
    let f_hat = b_hat
        .add(&domain_polynomial(s_c)?.scale(beta))
        .add(&constant(gamma_c));
    let g_hat = b_hat.add(&linear(gamma_c, beta));
    let l_zero = lagrange_zero(domain_size)?;
    let q_c_0 = r_hat
        .sub(&DenseUnivariatePolynomial::new(
            vec![ScalarField::one()].into_boxed_slice(),
        )?)
        .multiply(&l_zero)?
        .divide_vanishing_exact(domain_size)?;
    let q_c_1 = scale_argument(&r_hat, shape.connection_root)
        .multiply(&g_hat)?
        .sub(&r_hat.multiply(&f_hat)?)
        .divide_vanishing_exact(domain_size)?;
    Ok(MaskedCopyRelation {
        r_hat,
        q_c_0,
        q_c_1,
    })
}

fn domain_polynomial(
    polynomial: &DenseDomainPolynomial,
) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    Ok(DenseUnivariatePolynomial::new(
        polynomial.coefficients.clone(),
    )?)
}

fn combine_tagged_queries(
    role: &'static str,
    values: &[TaggedWitnessValue],
    queries: &[UnivariateTaggedQuery],
    query_index: impl Fn((usize, usize, usize)) -> Option<usize>,
) -> Result<G1serde, UnivariateProverError> {
    let mut seen = std::collections::HashSet::with_capacity(values.len());
    let mut combined = G1serde::zero();
    for value in values {
        let key = (
            value.placement_index,
            value.subcircuit_id,
            value.local_wire_index,
        );
        if !seen.insert(key) {
            return Err(UnivariateProverError::DuplicateBindingCoordinate {
                role,
                placement_index: value.placement_index,
                subcircuit_id: value.subcircuit_id,
                local_wire_index: value.local_wire_index,
            });
        }
        let query = query_index(key)
            .and_then(|index| queries.get(index))
            .ok_or(UnivariateProverError::MissingBindingQuery {
                role,
                placement_index: value.placement_index,
                subcircuit_id: value.subcircuit_id,
                local_wire_index: value.local_wire_index,
            })?;
        combined = combined + query.point * value.value;
    }
    Ok(combined)
}

/// `(Z^large - 1) / (Z^small - 1)` for `small | large`.  The domains are
/// radix-two, so this is the sparse geometric series required by U10/U25.
fn complementary_factor(
    large_domain_size: usize,
    small_domain_size: usize,
) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    if small_domain_size == 0 || large_domain_size % small_domain_size != 0 {
        return Err(UnivariateProverError::InvalidOpeningPoint);
    }
    let mut coefficients = vec![ScalarField::zero(); large_domain_size];
    for index in (0..large_domain_size).step_by(small_domain_size) {
        coefficients[index] = ScalarField::one();
    }
    DenseUnivariatePolynomial::new(coefficients.into_boxed_slice()).map_err(Into::into)
}

fn validate_opening_point(
    shape: &UnivariateCrsShape,
    zeta: ScalarField,
) -> Result<(), UnivariateProverError> {
    if zeta == ScalarField::zero()
        || zeta.pow(shape.arithmetic_domain_size) == ScalarField::one()
        || zeta.pow(shape.connection_domain_size) == ScalarField::one()
    {
        return Err(UnivariateProverError::InvalidOpeningPoint);
    }
    Ok(())
}

fn blind(
    base: DenseUnivariatePolynomial,
    randomizer: &DenseUnivariatePolynomial,
    domain_size: usize,
) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    Ok(base.add(&randomizer.multiply_vanishing(domain_size)?))
}

fn dense_selector(
    selector: &StridedPolynomial,
    arithmetic_domain_size: usize,
) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    let highest_degree = selector
        .coefficients
        .len()
        .checked_sub(1)
        .and_then(|index| index.checked_mul(selector.stride))
        .ok_or(UnivariateProverError::SelectorDegree)?;
    if highest_degree >= arithmetic_domain_size {
        return Err(UnivariateProverError::SelectorDegree);
    }
    let mut coefficients = vec![ScalarField::zero(); highest_degree + 1];
    for (index, coefficient) in selector.coefficients.iter().enumerate() {
        coefficients[index * selector.stride] = *coefficient;
    }
    Ok(DenseUnivariatePolynomial::new(
        coefficients.into_boxed_slice(),
    )?)
}

fn constant(value: ScalarField) -> DenseUnivariatePolynomial {
    DenseUnivariatePolynomial::new(vec![value].into_boxed_slice())
        .expect("constant polynomial is nonempty")
}

fn linear(constant_term: ScalarField, linear_term: ScalarField) -> DenseUnivariatePolynomial {
    DenseUnivariatePolynomial::new(vec![constant_term, linear_term].into_boxed_slice())
        .expect("linear polynomial is nonempty")
}

fn lagrange_zero(domain_size: usize) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    let inverse = ScalarField::from_u32(
        u32::try_from(domain_size).map_err(|_| UnivariateProverError::SelectorDegree)?,
    )
    .inv();
    DenseUnivariatePolynomial::new(vec![inverse; domain_size].into_boxed_slice())
        .map_err(Into::into)
}

fn scale_argument(
    polynomial: &DenseUnivariatePolynomial,
    scale: ScalarField,
) -> DenseUnivariatePolynomial {
    let mut power = ScalarField::one();
    let coefficients = polynomial
        .coefficients()
        .iter()
        .map(|coefficient| {
            let scaled = *coefficient * power;
            power = power * scale;
            scaled
        })
        .collect::<Vec<_>>();
    DenseUnivariatePolynomial::new(coefficients.into_boxed_slice())
        .expect("scaled polynomial is nonempty")
}

fn interpolate(evaluations: &[ScalarField]) -> Result<Vec<ScalarField>, UnivariateProverError> {
    init_ntt_domain_for_size(evaluations.len()).map_err(UnivariateProverError::Ntt)?;
    let mut coefficients = vec![ScalarField::zero(); evaluations.len()];
    ntt::ntt(
        HostSlice::from_slice(evaluations),
        NTTDir::kInverse,
        &NTTConfig::<ScalarField>::default(),
        HostSlice::from_mut_slice(&mut coefficients),
    )
    .map_err(UnivariateProverError::Ntt)?;
    Ok(coefficients)
}

#[cfg(test)]
mod tests {
    use super::{
        build_masked_arithmetic_witness, build_masked_copy_relation, build_opening_polynomials,
        combine_quotients, domain_polynomial, linear, scale_argument, select_witness_values,
        ArithmeticMaskRandomizers,
    };
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    use libs::frontend_artifacts::{HexString, PlacementVariables, SetupParams};
    use libs::univariate_crs::UnivariateCrsShape;
    use libs::univariate_polynomial::DenseUnivariatePolynomial;
    use libs::univariate_relation::{
        DenseDomainPolynomial, StridedPolynomial, UnivariateSubcircuit, WitnessMaps,
    };

    fn polynomial(values: &[u32]) -> DenseUnivariatePolynomial {
        DenseUnivariatePolynomial::new(
            values
                .iter()
                .copied()
                .map(ScalarField::from_u32)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        )
        .unwrap()
    }

    #[test]
    fn u24_divides_the_masked_arithmetic_relation_exactly() {
        let setup = SetupParams {
            l_free: 0,
            l: 1,
            l_user_out: 0,
            l_user: 0,
            l_D: 3,
            m_D: 3,
            n: 2,
            s_D: 1,
            s_max: 2,
        };
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let map = |coefficients: &[u32]| DenseDomainPolynomial {
            evaluations: vec![ScalarField::zero(); 2].into_boxed_slice(),
            coefficients: coefficients
                .iter()
                .copied()
                .map(ScalarField::from_u32)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        };
        let maps = WitnessMaps {
            u_a: map(&[1]),
            v_a: map(&[2]),
            w_a: map(&[2]),
            b_c: map(&[3]),
        };
        let selector = StridedPolynomial {
            stride: 2,
            coefficients: vec![ScalarField::one()].into_boxed_slice(),
        };
        let masked = build_masked_arithmetic_witness(
            &shape,
            &selector,
            &maps,
            ArithmeticMaskRandomizers {
                u: polynomial(&[3, 4]),
                v: polynomial(&[5, 6]),
                w: polynomial(&[7, 8]),
                b: polynomial(&[9, 10]),
            },
        )
        .unwrap();
        let relation = masked
            .u_hat
            .multiply(&masked.v_hat)
            .unwrap()
            .sub(&masked.w_hat);
        let reconstructed = masked
            .q_a
            .multiply_vanishing(shape.arithmetic_domain_size)
            .unwrap();
        assert_eq!(relation, reconstructed);
    }

    #[test]
    fn selector_alignment_keeps_inactive_slots_explicit() {
        let setup = SetupParams {
            l_free: 0,
            l: 1,
            l_user_out: 0,
            l_user: 0,
            l_D: 2,
            m_D: 3,
            n: 1,
            s_D: 1,
            s_max: 2,
        };
        let wires = [0usize];
        let rows: [Vec<(usize, ScalarField)>; 0] = [];
        let flatten = [0usize, 1, 2];
        let subcircuits = [UnivariateSubcircuit {
            id: 0,
            flatten_map: &flatten,
            a_active_wires: &wires,
            b_active_wires: &wires,
            c_active_wires: &wires,
            a_rows: &rows,
            b_rows: &rows,
            c_rows: &rows,
        }];
        let placements = [PlacementVariables {
            subcircuitId: 0,
            variables: ["0x01", "0x02", "0x03"]
                .into_iter()
                .map(|value| HexString(value.to_string()))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        }];
        let selected =
            select_witness_values(&[Some(0), None], &placements, &setup, &subcircuits).unwrap();
        assert!(selected.slot_values[0].is_some());
        assert!(selected.slot_values[1].is_none());
        assert_eq!(selected.interface_values.len(), 1);
        assert_eq!(selected.internal_values.len(), 1);
        assert_eq!(selected.internal_values[0].value, ScalarField::from_u32(3));
    }

    #[test]
    fn u25_divides_both_blinded_copy_relations_exactly() {
        let setup = SetupParams {
            l_free: 0,
            l: 1,
            l_user_out: 0,
            l_user: 0,
            l_D: 3,
            m_D: 3,
            n: 2,
            s_D: 1,
            s_max: 2,
        };
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let map = |evaluations: &[u32], coefficients: &[u32]| DenseDomainPolynomial {
            evaluations: evaluations
                .iter()
                .copied()
                .map(ScalarField::from_u32)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
            coefficients: coefficients
                .iter()
                .copied()
                .map(ScalarField::from_u32)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        };
        let maps = WitnessMaps {
            u_a: map(&[0, 0], &[0]),
            v_a: map(&[0, 0], &[0]),
            w_a: map(&[0, 0], &[0]),
            // B_C=3 on every element of H_4.
            b_c: map(&[3, 3, 3, 3], &[3]),
        };
        // S_C(Z)=Z, the identity permutation on H_4.
        let mut point = ScalarField::one();
        let mut identity_evaluations = Vec::with_capacity(shape.connection_domain_size);
        for _ in 0..shape.connection_domain_size {
            identity_evaluations.push(point);
            point = point * shape.connection_root;
        }
        let s_c = DenseDomainPolynomial {
            evaluations: identity_evaluations.into_boxed_slice(),
            coefficients: vec![ScalarField::zero(), ScalarField::one()].into_boxed_slice(),
        };
        let b_hat = domain_polynomial(&maps.b_c).unwrap().add(
            &polynomial(&[9, 10])
                .multiply_vanishing(shape.connection_domain_size)
                .unwrap(),
        );
        let relation = build_masked_copy_relation(
            &shape,
            &maps,
            &s_c,
            &b_hat,
            ScalarField::zero(),
            ScalarField::one(),
            &polynomial(&[5, 6, 7, 8]),
        )
        .unwrap();
        let l_zero = super::lagrange_zero(shape.connection_domain_size).unwrap();
        let boundary = relation
            .r_hat
            .sub(&polynomial(&[1]))
            .multiply(&l_zero)
            .unwrap();
        assert_eq!(
            boundary,
            relation
                .q_c_0
                .multiply_vanishing(shape.connection_domain_size)
                .unwrap()
        );
        let factor = b_hat.add(&linear(ScalarField::one(), ScalarField::zero()));
        let recurrence = scale_argument(&relation.r_hat, shape.connection_root)
            .multiply(&factor)
            .unwrap()
            .sub(&relation.r_hat.multiply(&factor).unwrap());
        assert_eq!(
            recurrence,
            relation
                .q_c_1
                .multiply_vanishing(shape.connection_domain_size)
                .unwrap()
        );
        let theta = ScalarField::from_u32(7);
        let q_a = polynomial(&[11, 12]);
        let q_hat = combine_quotients(&shape, &q_a, &relation, theta).unwrap();
        let m_a = super::complementary_factor(
            shape.connection_domain_size,
            shape.intersection_domain_size,
        )
        .unwrap();
        let m_c = super::complementary_factor(
            shape.arithmetic_domain_size,
            shape.intersection_domain_size,
        )
        .unwrap();
        assert_eq!(
            q_hat,
            q_a.multiply(&m_a)
                .unwrap()
                .add(&relation.q_c_0.multiply(&m_c).unwrap().scale(theta))
                .add(&relation.q_c_1.multiply(&m_c).unwrap().scale(theta * theta))
        );
        let selector = StridedPolynomial {
            stride: 2,
            coefficients: vec![ScalarField::one()].into_boxed_slice(),
        };
        let openings = build_opening_polynomials(
            &shape,
            &selector,
            &s_c,
            &polynomial(&[0]),
            &polynomial(&[0]),
            &polynomial(&[0]),
            &b_hat,
            &relation.r_hat,
            &q_hat,
            ScalarField::from_u32(2),
        )
        .unwrap();
        assert_eq!(openings.pi_zeta_terms.len(), 8);
        assert_eq!(openings.evaluations.u, ScalarField::zero());
        assert_eq!(openings.evaluations.s_a, ScalarField::one());
        let plus_point = shape.connection_root * ScalarField::from_u32(2);
        assert_eq!(
            relation
                .r_hat
                .sub(&polynomial(&[1]).scale(openings.evaluations.r_plus)),
            openings
                .pi_plus
                .multiply(&linear(
                    ScalarField::zero() - plus_point,
                    ScalarField::one()
                ))
                .unwrap()
        );
    }
}
