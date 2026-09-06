//! U22--U24 prover primitives for the univariate protocol.

use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::memory::HostSlice;
use libs::frontend_artifacts::public_wire_layout::{PublicQueryKey, PublicWireLayout};
use libs::frontend_artifacts::{Instance, PlacementVariables, SetupParams};
use libs::group_structures::G1serde;
use libs::ntt_domain::init_ntt_domain_for_size;
use libs::univariate_crs::{
    UnivariateCrs, UnivariateCrsShape, UnivariateQueryIndex, UnivariateTaggedQuery,
};
use libs::univariate_polynomial::{DenseUnivariatePolynomial, UnivariatePolynomialError};
use libs::univariate_relation::{DenseDomainPolynomial, StridedPolynomial, WitnessMaps};
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
    pub v: ScalarField,
    pub r: ScalarField,
    pub r_plus: ScalarField,
    pub p: ScalarField,
}

/// U29 and U30's quotient inputs.  These are ordinary coefficient
/// polynomials and can therefore be committed with the U18 KZG powers without
/// any bivariate compatibility conversion.
pub struct UnivariateOpeningPolynomials {
    pub p_nu: DenseUnivariatePolynomial,
    pub linearization: DenseUnivariatePolynomial,
    pub h_zeta_varpi: DenseUnivariatePolynomial,
    pub pi_zeta: DenseUnivariatePolynomial,
    pub pi_plus: DenseUnivariatePolynomial,
    pub evaluations: UnivariateEvaluations,
}

/// U25's single quotient.  The complementary vanishing factors belong to
/// the verifier's combined identity; the quotient itself is the theta-linear
/// combination of the three exact per-domain quotients.
pub fn combine_quotients(
    q_a: &DenseUnivariatePolynomial,
    copy: &MaskedCopyRelation,
    theta: ScalarField,
) -> DenseUnivariatePolynomial {
    q_a.add(&copy.q_c_0.scale(theta))
        .add(&copy.q_c_1.scale(theta * theta))
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
    for (index, randomizer) in masks.into_iter().enumerate() {
        let queries = if index < 3 {
            &crs.delta_inv_arithmetic_masking_queries[index]
        } else {
            &crs.delta_inv_connection_masking_queries
        };
        if randomizer.coefficients().len() > queries.len() {
            return Err(UnivariateProverError::BlindingDegree {
                role: if index < 3 {
                    "arithmetic"
                } else {
                    "connection"
                },
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

/// Builds U28--U30 after all five witness-polynomial commitments and the
/// circuit-specific preprocessing commitments have been fixed.
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
    beta: ScalarField,
    gamma_c: ScalarField,
    theta: ScalarField,
    nu: ScalarField,
    zeta: ScalarField,
    varpi: ScalarField,
) -> Result<UnivariateOpeningPolynomials, UnivariateProverError> {
    validate_opening_point(shape, zeta)?;
    let selector = dense_selector(selector, shape.arithmetic_domain_size)?;
    let s_c = domain_polynomial(s_c)?;
    let p_nu = u_hat
        .add(&w_hat.scale(nu))
        .add(&b_hat.scale(nu * nu))
        .add(&q_hat.scale(nu * nu * nu));
    let evaluations = UnivariateEvaluations {
        s_a: selector.evaluate(zeta),
        v: v_hat.evaluate(zeta),
        r: r_hat.evaluate(zeta),
        r_plus: r_hat.evaluate(shape.connection_root * zeta),
        p: p_nu.evaluate(zeta),
    };
    let m_a = complementary_factor(shape.connection_domain_size, shape.intersection_domain_size)?;
    let m_c = complementary_factor(shape.arithmetic_domain_size, shape.intersection_domain_size)?;
    let l_zero = lagrange_zero(shape.connection_domain_size)?;
    let linearization = u_hat
        .scale(m_a.evaluate(zeta) * evaluations.s_a * evaluations.v)
        .sub(&w_hat.scale(m_a.evaluate(zeta) * evaluations.s_a))
        .add(
            &r_hat
                .sub(&constant(ScalarField::one()))
                .scale(theta * m_c.evaluate(zeta) * l_zero.evaluate(zeta)),
        )
        .add(
            &b_hat.scale(theta * theta * m_c.evaluate(zeta) * (evaluations.r_plus - evaluations.r)),
        )
        .add(
            &linear(
                gamma_c * (evaluations.r_plus - evaluations.r),
                beta * evaluations.r_plus,
            )
            .scale(theta * theta * m_c.evaluate(zeta)),
        )
        .sub(&s_c.scale(theta * theta * m_c.evaluate(zeta) * beta * evaluations.r))
        .sub(&q_hat.scale(vanishing(shape.union_domain_size).evaluate(zeta)));
    let h_zeta_varpi = linearization
        .add(&v_hat.sub(&constant(evaluations.v)).scale(varpi))
        .add(&r_hat.sub(&constant(evaluations.r)).scale(varpi * varpi))
        .add(
            &p_nu
                .sub(&constant(evaluations.p))
                .scale(varpi * varpi * varpi),
        )
        .add(
            &selector
                .sub(&constant(evaluations.s_a))
                .scale(varpi * varpi * varpi * varpi),
        );
    let (pi_zeta, h_value) = h_zeta_varpi.ruffini(zeta);
    debug_assert_eq!(h_value, ScalarField::zero());
    let (pi_plus, r_plus_value) = r_hat
        .sub(&constant(evaluations.r_plus))
        .ruffini(shape.connection_root * zeta);
    debug_assert_eq!(r_plus_value, ScalarField::zero());
    Ok(UnivariateOpeningPolynomials {
        p_nu,
        linearization,
        h_zeta_varpi,
        pi_zeta,
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

fn vanishing(domain_size: usize) -> DenseUnivariatePolynomial {
    let mut coefficients = vec![ScalarField::zero(); domain_size + 1];
    coefficients[0] = ScalarField::zero() - ScalarField::one();
    coefficients[domain_size] = ScalarField::one();
    DenseUnivariatePolynomial::new(coefficients.into_boxed_slice())
        .expect("a positive-domain vanishing polynomial is nonempty")
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
        assert_eq!(
            combine_quotients(&q_a, &relation, theta),
            q_a.add(&relation.q_c_0.scale(theta))
                .add(&relation.q_c_1.scale(theta * theta))
        );

        let q_hat = combine_quotients(&polynomial(&[0]), &relation, theta);
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
            ScalarField::zero(),
            ScalarField::one(),
            theta,
            ScalarField::from_u32(5),
            ScalarField::from_u32(2),
            ScalarField::from_u32(3),
        )
        .unwrap();
        assert_eq!(
            openings.h_zeta_varpi.evaluate(ScalarField::from_u32(2)),
            ScalarField::zero()
        );
        assert_eq!(
            openings.h_zeta_varpi,
            openings
                .pi_zeta
                .multiply(&linear(
                    ScalarField::zero() - ScalarField::from_u32(2),
                    ScalarField::one()
                ))
                .unwrap()
        );
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
