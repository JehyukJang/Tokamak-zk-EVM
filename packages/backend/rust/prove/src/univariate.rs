//! U22--U24 prover primitives for the univariate protocol.

use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
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

/// Builds U23 and U24.  Exact vanishing division is an admission boundary:
/// malformed witness maps cannot become a silently truncated quotient.
pub fn build_masked_arithmetic_witness(
    shape: &UnivariateCrsShape,
    selector: &StridedPolynomial,
    maps: &WitnessMaps,
    randomizers: ArithmeticMaskRandomizers,
) -> Result<MaskedArithmeticWitness, UnivariateProverError> {
    let u_hat = blind(domain_polynomial(&maps.u_a)?, &randomizers.u, shape.arithmetic_domain_size)?;
    let v_hat = blind(domain_polynomial(&maps.v_a)?, &randomizers.v, shape.arithmetic_domain_size)?;
    let w_hat = blind(domain_polynomial(&maps.w_a)?, &randomizers.w, shape.arithmetic_domain_size)?;
    let b_hat = blind(domain_polynomial(&maps.b_c)?, &randomizers.b, shape.connection_domain_size)?;
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

fn domain_polynomial(
    polynomial: &DenseDomainPolynomial,
) -> Result<DenseUnivariatePolynomial, UnivariateProverError> {
    Ok(DenseUnivariatePolynomial::new(polynomial.coefficients.clone())?)
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
    Ok(DenseUnivariatePolynomial::new(coefficients.into_boxed_slice())?)
}

#[cfg(test)]
mod tests {
    use super::{build_masked_arithmetic_witness, ArithmeticMaskRandomizers};
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
        let reconstructed = masked.q_a.multiply_vanishing(shape.arithmetic_domain_size).unwrap();
        assert_eq!(relation, reconstructed);
    }
}
