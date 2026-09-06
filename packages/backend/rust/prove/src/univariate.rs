//! U22--U24 prover primitives for the univariate protocol.

use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::memory::HostSlice;
use libs::ntt_domain::init_ntt_domain_for_size;
use libs::univariate_crs::UnivariateCrsShape;
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
        build_masked_arithmetic_witness, build_masked_copy_relation, combine_quotients,
        domain_polynomial, linear, scale_argument, ArithmeticMaskRandomizers,
    };
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    use libs::frontend_artifacts::SetupParams;
    use libs::univariate_crs::UnivariateCrsShape;
    use libs::univariate_polynomial::DenseUnivariatePolynomial;
    use libs::univariate_relation::{DenseDomainPolynomial, StridedPolynomial, WitnessMaps};

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
    }
}
