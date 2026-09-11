//! U23--U33 proving over the current arithmetic, connection and selection domains.
//! ICICLE owns polynomial multiplication/NTT/MSM parallelism on CPU and CUDA.

use crate::univariate_crs::{commit, msm_points, point, ProverCrs};
use icicle_bls12_381::{
    curve::{ScalarCfg, ScalarField},
    polynomials::DensePolynomial,
};
use icicle_core::{
    polynomials::UnivariatePolynomial,
    traits::{Arithmetic, FieldImpl, GenerateRandom},
};
use icicle_runtime::memory::HostSlice;
use libs::{
    field_structures::FieldSerde,
    frontend_artifacts::{
        public_wire_layout::PublicWireLayout, Instance, PlacementVariables, SetupParams,
    },
    group_structures::G1serde,
    ntt_domain::init_ntt_domain_for_size,
    univariate_proof::UnivariateProof,
    univariate_relation::{DenseDomainPolynomial, UnivariateSubcircuit, WitnessMaps},
    univariate_selection::SelectedRoots,
    univariate_transcript::{
        encode_evaluation_message_block, encode_g1_message_block, UnivariateChallenges,
        UnivariateTranscript,
    },
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UnivariateProverError {
    #[error("{0}")]
    Invalid(String),
    #[error("copy recursion denominator vanishes at connection-domain index {index}")]
    CopyDenominator { index: usize },
    #[error("copy recursion does not close around the connection domain")]
    CopyRecurrenceDoesNotClose,
    #[error("{relation} polynomial has a nonzero vanishing remainder")]
    Unsatisfied { relation: &'static str },
}
impl From<String> for UnivariateProverError {
    fn from(error: String) -> Self {
        Self::Invalid(error)
    }
}

/// U23 masks are sampled once and reused in the masked maps and binding MSM.
pub struct ProverRandomizers {
    pub u: [ScalarField; 2],
    pub v: [ScalarField; 2],
    pub w: [ScalarField; 2],
    pub b: [ScalarField; 2],
    pub r: [ScalarField; 4],
    pub selection: ScalarField,
}
impl ProverRandomizers {
    pub fn sample() -> Self {
        let values = ScalarCfg::generate_random(13);
        Self {
            u: values[0..2].try_into().unwrap(),
            v: values[2..4].try_into().unwrap(),
            w: values[4..6].try_into().unwrap(),
            b: values[6..8].try_into().unwrap(),
            r: values[8..12].try_into().unwrap(),
            selection: values[12],
        }
    }
}

pub struct ProvingInput<'a> {
    pub crs: &'a ProverCrs,
    pub setup: &'a SetupParams,
    pub public_layout: &'a PublicWireLayout,
    pub selector: &'a [Option<usize>],
    pub slots: &'a [Option<Box<[ScalarField]>>],
    pub maps: &'a WitnessMaps,
    pub s_c: &'a DenseDomainPolynomial,
    /// All instance values are checked against the witness. Only the free
    /// prefix enters A_free and the transcript; fixed values remain in maps.
    pub public_inputs: &'a [ScalarField],
    pub randomizers: &'a ProverRandomizers,
}

pub fn prove(
    input: ProvingInput<'_>,
) -> Result<(UnivariateProof, UnivariateChallenges), UnivariateProverError> {
    let ProvingInput {
        crs,
        setup,
        public_layout,
        selector,
        slots,
        maps,
        s_c,
        public_inputs,
        randomizers: masks,
    } = input;
    validate_public_witness(setup, public_layout, selector, slots, public_inputs)?;
    let shape = &crs.shape;
    // Multiplications need room for two blinded polynomials. Domain setup is
    // provider-global; do it before constructing any ICICLE polynomial handle.
    let transform = (2
        * (shape
            .arithmetic_domain_size
            .max(shape.connection_domain_size)
            + 4))
        .next_power_of_two();
    init_ntt_domain_for_size(transform.max((shape.selection_domain_size + 1).next_power_of_two()))
        .map_err(|e| format!("NTT initialization failed: {e:?}"))?;
    let (u, v, w, b, q_a) = crate::time_block!("univariate.arithmetic", "prove", {
        let u = blind(
            &maps.u_a.coefficients,
            &masks.u,
            shape.arithmetic_domain_size,
        );
        let v = blind(
            &maps.v_a.coefficients,
            &masks.v,
            shape.arithmetic_domain_size,
        );
        let w = blind(
            &maps.w_a.coefficients,
            &masks.w,
            shape.arithmetic_domain_size,
        );
        let b = blind(
            &maps.b_c.coefficients,
            &masks.b,
            shape.connection_domain_size,
        );
        let q = divide_vanishing(
            &u.mul(&v).sub(&w),
            shape.arithmetic_domain_size,
            "arithmetic",
        )?;
        (u, v, w, b, q)
    });
    let a = DensePolynomial::from_rou_evals(
        HostSlice::from_slice(&public_inputs[..setup.l_free]),
        setup.l_free,
    );
    let c_l = commit(&crs.tau.s0_g1, &coefficients(&a), 0)?
        + commit(&crs.tau.sxi_g1, &coefficients(&u), 0)?
        + commit(&crs.tau.spsi_g1, &coefficients(&w), 0)?;
    let c_h = commit(&crs.tau.sxi_g1, &coefficients(&v), 0)?
        + commit(&crs.tau.spsi_g1, &coefficients(&b), 0)?;
    let c_o = crate::time_block!("univariate.binding", "prove", {
        binding(
            crs,
            setup,
            public_layout,
            selector,
            slots,
            public_inputs,
            masks,
        )?
    });
    let (d_q, d_q_k) = crate::time_block!("univariate.selection", "prove", {
        let roots = SelectedRoots::new(shape, setup, selector)?;
        let mut q = Vec::with_capacity(setup.m * setup.s_max);
        for j in 0..setup.m {
            let values = slots
                .iter()
                .map(|slot| {
                    slot.as_ref()
                        .and_then(|w| w.get(j))
                        .copied()
                        .unwrap_or(ScalarField::zero())
                })
                .collect::<Vec<_>>();
            let polynomial = roots.quotient_for_wire(&values)?;
            let mut wire_coefficients = coefficients(&polynomial);
            wire_coefficients.resize(setup.s_max, ScalarField::zero());
            q.extend(wire_coefficients);
        }
        let zv = coefficients(roots.selected_polynomial());
        (
            commit(&crs.keys.weighted_g1, &q, 0)?
                + commit(&crs.tau.s0_g1, &zv, 0)? * masks.selection,
            commit(&crs.keys.weighted_shifted_g1, &q, 0)?
                + commit(&crs.tau.s0_g1, &zv, shape.k)? * masks.selection,
        )
    });
    let mut transcript = UnivariateTranscript::from_public_inputs(&public_inputs[..setup.l_free]);
    transcript.set_message(&encode_g1_message_block(
        "F2.a1",
        &[c_l, c_h, c_o, d_q, d_q_k],
    ));
    let upsilon = transcript.challenge(1, 0);
    let c_d = commit(&crs.tau.s0_g1, &coefficients(&a), shape.k)?
        + commit(
            &crs.tau.sxi_g1,
            &coefficients(&u.add(&v.mul_by_scalar(&upsilon))),
            shape.k,
        )?
        + commit(
            &crs.tau.spsi_g1,
            &coefficients(&w.add(&b.mul_by_scalar(&upsilon))),
            shape.k,
        )?;
    transcript.set_message(&encode_g1_message_block("F2.a2", &[c_d]));
    let (beta, gamma_c) = transcript.challenge_pair(2);
    let sc = polynomial(&s_c.coefficients);
    let (r, q_c_0, q_c_1) = crate::time_block!("univariate.copy", "prove", {
        copy_relation(
            shape.connection_root,
            shape.connection_domain_size,
            &maps.b_c.evaluations,
            s_c,
            &b,
            beta,
            gamma_c,
            &masks.r,
        )?
    });
    let c_r = commit(&crs.tau.s0_g1, &coefficients(&r), 0)?;
    transcript.set_message(&encode_g1_message_block("F2.a3", &[c_r]));
    let theta = transcript.challenge(3, 0);
    let q = q_a
        .add(&q_c_0.mul_by_scalar(&theta))
        .add(&q_c_1.mul_by_scalar(&theta.pow(2)));
    let c_q = commit(&crs.tau.s0_g1, &coefficients(&q), 0)?;
    transcript.set_message(&encode_g1_message_block("F2.a4", &[c_q]));
    let chi = transcript.chi(shape.arithmetic_domain_size, shape.connection_domain_size);
    let mut proof = UnivariateProof {
        c_l,
        c_h,
        c_o,
        d_q,
        d_q_k,
        c_d,
        c_r,
        c_q,
        s_c: FieldSerde(sc.eval(&chi)),
        u: FieldSerde(u.eval(&chi)),
        v: FieldSerde(v.eval(&chi)),
        w: FieldSerde(w.eval(&chi)),
        b: FieldSerde(b.eval(&chi)),
        r: FieldSerde(r.eval(&chi)),
        r_plus: FieldSerde(r.eval(&(chi * shape.connection_root))),
        pi_chi: G1serde::zero(),
        pi_plus: G1serde::zero(),
    };
    transcript.set_message(&encode_evaluation_message_block(&proof));
    let varpi = transcript.challenge(5, 0);
    crate::time_block!("univariate.openings", "prove", {
        let ordinary = a
            .add(&r.mul_by_scalar(&varpi.pow(2)))
            .add(&q.mul_by_scalar(&varpi.pow(3)))
            .add(&sc.mul_by_scalar(&varpi.pow(4)));
        let xi = u.add(&v.mul_by_scalar(&varpi));
        let psi = w.add(&b.mul_by_scalar(&varpi));
        proof.pi_chi = commit(&crs.tau.s0_g1, &opening(&ordinary, chi), 0)?
            + commit(&crs.tau.sxi_g1, &opening(&xi, chi), 0)?
            + commit(&crs.tau.spsi_g1, &opening(&psi, chi), 0)?;
        proof.pi_plus = commit(&crs.tau.s0_g1, &opening(&r, chi * shape.connection_root), 0)?;
    });
    transcript.set_message(&encode_g1_message_block(
        "F2.a6",
        &[proof.pi_chi, proof.pi_plus],
    ));
    let mu = transcript.nonzero_challenge(6, 0);
    Ok((
        proof,
        UnivariateChallenges {
            upsilon,
            beta,
            gamma_c,
            theta,
            chi,
            varpi,
            mu,
        },
    ))
}

fn binding(
    crs: &ProverCrs,
    setup: &SetupParams,
    public: &PublicWireLayout,
    selector: &[Option<usize>],
    slots: &[Option<Box<[ScalarField]>>],
    values: &[ScalarField],
    masks: &ProverRandomizers,
) -> Result<G1serde, UnivariateProverError> {
    let mut bases = Vec::new();
    let mut scalars = Vec::new();
    // The free query sequence follows mapped global free wires, skipping only
    // structural padding. Fixed-public queries belong exclusively to C_fix.
    for (query, global) in
        crs.keys.free_public_queries.iter().zip(
            (0..setup.l_free).filter(|g| public.public_query_key_for_public_wire(*g).is_some()),
        )
    {
        bases.push(point(query));
        scalars.push(values[global]);
    }
    // Same library-derived coordinate order as trusted setup; no lookup by
    // assumed dense m*s*t index and no expansion of omitted zero blocks.
    for (i, selected) in selector.iter().enumerate() {
        if let Some(k) = selected {
            let witness = slots[i]
                .as_ref()
                .ok_or_else(|| UnivariateProverError::Invalid("missing selected witness".into()))?;
            for (query, j) in crs.keys.nonpublic_queries
                [crs.layout.range(i, *k).map_err(str::to_owned)?]
            .iter()
            .zip(crs.layout.local_wires(*k).map_err(str::to_owned)?)
            {
                bases.push(point(query));
                scalars.push(witness[*j]);
            }
        }
    }
    for (queries, mask) in [
        (&crs.keys.mask_u, &masks.u),
        (&crs.keys.mask_v, &masks.v),
        (&crs.keys.mask_w, &masks.w),
        (&crs.keys.mask_b, &masks.b),
    ] {
        bases.extend(queries.iter().map(point));
        scalars.extend(mask);
    }
    bases.push(point(&crs.keys.mask_selection));
    scalars.push(masks.selection);
    Ok(msm_points(&bases, &scalars)?)
}

pub fn collect_public_inputs(
    instance: &Instance,
    setup: &SetupParams,
) -> Result<Vec<ScalarField>, UnivariateProverError> {
    let values = instance
        .a_pub_user
        .iter()
        .chain(instance.a_pub_block.iter())
        .chain(instance.a_pub_function.iter())
        .map(|v| ScalarField::from_hex(v.as_ref()))
        .collect::<Vec<_>>();
    if values.len() != setup.l {
        return Err(format!(
            "public instance length {}, expected {}",
            values.len(),
            setup.l
        )
        .into());
    }
    Ok(values)
}

pub fn select_witness_values(
    selector: &[Option<usize>],
    placements: &[PlacementVariables],
    setup: &SetupParams,
    circuits: &[UnivariateSubcircuit<'_>],
) -> Result<Vec<Option<Box<[ScalarField]>>>, UnivariateProverError> {
    if selector.len() != setup.s_max {
        return Err("selector capacity mismatch".to_owned().into());
    }
    let mut records = placements.iter();
    let mut slots = Vec::with_capacity(selector.len());
    for selected in selector {
        let Some(k) = selected else {
            slots.push(None);
            continue;
        };
        let record = records.next().ok_or("missing placement".to_owned())?;
        let circuit = circuits.get(*k).ok_or("unknown circuit".to_owned())?;
        if record.subcircuitId != *k || record.variables.len() != circuit.flatten_map.len() {
            return Err("selector and witness mismatch".to_owned().into());
        }
        slots.push(Some(
            record
                .variables
                .iter()
                .map(|v| ScalarField::from_hex(v.as_ref()))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        ));
    }
    if records.next().is_some() {
        return Err("extra placement".to_owned().into());
    }
    Ok(slots)
}

fn validate_public_witness(
    setup: &SetupParams,
    public: &PublicWireLayout,
    selector: &[Option<usize>],
    slots: &[Option<Box<[ScalarField]>>],
    values: &[ScalarField],
) -> Result<(), UnivariateProverError> {
    if values.len() != setup.l || selector.len() != setup.s_max || slots.len() != setup.s_max {
        return Err("proving input dimensions mismatch".to_owned().into());
    }
    for (i, selected) in selector.iter().enumerate() {
        if let Some(k) = selected {
            if i != *k
                && public
                    .segments()
                    .iter()
                    .any(|segment| segment.subcircuit_id == *k)
            {
                return Err("public buffer cannot be repeated at another placement"
                    .to_owned()
                    .into());
            }
        }
    }
    for (g, value) in values.iter().enumerate() {
        let expected = if let Some(key) = public.public_query_key_for_public_wire(g) {
            // Only public buffer wires specialize placement i == subcircuit ID.
            // Intermediate/private wires always use the actual selected placement.
            let k = key.buffer_subcircuit_id;
            if selector.get(k) != Some(&Some(k)) {
                return Err("public buffer must occupy its matching placement"
                    .to_owned()
                    .into());
            }
            slots[k]
                .as_ref()
                .and_then(|w| w.get(key.local_public_wire_index))
                .copied()
                .ok_or("missing public witness".to_owned())?
        } else {
            ScalarField::zero()
        };
        if *value != expected {
            return Err(format!(
                "public value at global wire {g} differs from its witness or zero padding"
            )
            .into());
        }
    }
    Ok(())
}

fn polynomial(values: &[ScalarField]) -> DensePolynomial {
    DensePolynomial::from_coeffs(HostSlice::from_slice(values), values.len())
}
fn coefficients(p: &DensePolynomial) -> Vec<ScalarField> {
    let mut values = vec![ScalarField::zero(); (p.degree() + 1).max(1) as usize];
    p.copy_coeffs(0, HostSlice::from_mut_slice(&mut values));
    values
}
fn blind(values: &[ScalarField], mask: &[ScalarField], n: usize) -> DensePolynomial {
    let mut coefficients = values.to_vec();
    coefficients.resize(n + mask.len(), ScalarField::zero());
    for (i, value) in mask.iter().enumerate() {
        coefficients[i] = coefficients[i] - *value;
        coefficients[n + i] = coefficients[n + i] + *value;
    }
    polynomial(&coefficients)
}
/// Exact linear-time division by Z^n-1. ICICLE's vanishing division does not
/// expose a remainder; checking it is necessary to reject unsatisfied witnesses.
fn divide_vanishing(
    p: &DensePolynomial,
    n: usize,
    relation: &'static str,
) -> Result<DensePolynomial, UnivariateProverError> {
    let mut remainder = coefficients(p);
    let mut quotient = vec![ScalarField::zero(); remainder.len().saturating_sub(n).max(1)];
    for i in (n..remainder.len()).rev() {
        let v = remainder[i];
        quotient[i - n] = v;
        remainder[i] = ScalarField::zero();
        remainder[i - n] = remainder[i - n] + v;
    }
    if remainder.iter().any(|v| *v != ScalarField::zero()) {
        return Err(UnivariateProverError::Unsatisfied { relation });
    }
    Ok(polynomial(&quotient))
}
/// Linear Ruffini division returns the coefficients used by the opening MSM.
fn opening(p: &DensePolynomial, z: ScalarField) -> Vec<ScalarField> {
    let coefficients = coefficients(p);
    if coefficients.len() == 1 {
        return vec![ScalarField::zero()];
    }
    let mut quotient = vec![ScalarField::zero(); coefficients.len() - 1];
    let mut accumulator = *coefficients.last().unwrap();
    for i in (0..quotient.len()).rev() {
        quotient[i] = accumulator;
        accumulator = coefficients[i] + z * accumulator;
    }
    quotient
}

fn copy_relation(
    root: ScalarField,
    n: usize,
    b_values: &[ScalarField],
    sc: &DenseDomainPolynomial,
    b: &DensePolynomial,
    beta: ScalarField,
    gamma: ScalarField,
    mask: &[ScalarField; 4],
) -> Result<(DensePolynomial, DensePolynomial, DensePolynomial), UnivariateProverError> {
    if b_values.len() != n || sc.evaluations.len() != n {
        return Err("connection dimensions mismatch".to_owned().into());
    }
    let mut values = vec![ScalarField::zero(); n];
    let mut product = ScalarField::one();
    let mut z = ScalarField::one();
    for i in 0..n {
        values[i] = product;
        let denominator = b_values[i] + beta * z + gamma;
        if denominator == ScalarField::zero() {
            return Err(UnivariateProverError::CopyDenominator { index: i });
        }
        product = product * (b_values[i] + beta * sc.evaluations[i] + gamma) * denominator.inv();
        z = z * root;
    }
    if product != ScalarField::one() {
        return Err(UnivariateProverError::CopyRecurrenceDoesNotClose);
    }
    let rc = DensePolynomial::from_rou_evals(HostSlice::from_slice(&values), n);
    let r = blind(&coefficients(&rc), mask, n);
    let f = b
        .add(&polynomial(&sc.coefficients).mul_by_scalar(&beta))
        .add(&polynomial(&[gamma]));
    let g = b.add(&polynomial(&[gamma, beta]));
    let inverse_n = ScalarField::from_bytes_le(&n.to_le_bytes()).inv();
    let l0 = polynomial(&vec![inverse_n; n]);
    let q0 = divide_vanishing(
        &r.sub(&polynomial(&[ScalarField::one()])).mul(&l0),
        n,
        "copy boundary",
    )?;
    let mut shifted = coefficients(&r);
    let mut power = ScalarField::one();
    for v in &mut shifted {
        *v = *v * power;
        power = power * root;
    }
    let q1 = divide_vanishing(
        &polynomial(&shifted).mul(&g).sub(&r.mul(&f)),
        n,
        "copy recurrence",
    )?;
    Ok((r, q0, q1))
}

#[cfg(test)]
mod tests;
