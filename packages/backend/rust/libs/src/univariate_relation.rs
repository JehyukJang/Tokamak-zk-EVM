//! Sparse univariate selector polynomials for the migrated protocol.
//!
//! These polynomials are represented by the nonzero coefficient stride implied
//! by U2 and U5. They never expand a selector into an `N_A` or `N_C` dense
//! vector.

use crate::frontend_artifacts::SetupParams;
use crate::ntt_domain::init_ntt_domain_for_size;
use crate::univariate_crs::UnivariateCrsShape;
use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::errors::eIcicleError;
use icicle_runtime::memory::HostSlice;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UnivariateRelationError {
    #[error("{name} must be a power of two for the selected direct NTT provider")]
    TransformDomainNotPowerOfTwo { name: &'static str },
    #[error("selector capacity is {actual}, expected {expected}")]
    SelectorCapacity { actual: usize, expected: usize },
    #[error("placement index {value} is outside the placement capacity")]
    PlacementIndex { value: usize },
    #[error("subcircuit ID {value} is outside the admitted range")]
    SubcircuitId { value: usize },
    #[error("ICICLE NTT failed: {0:?}")]
    Ntt(eIcicleError),
}

/// A polynomial containing only powers whose exponents are multiples of
/// `stride`: `sum_q coefficients[q] * Z^(stride * q)`.
#[derive(Clone, Debug, PartialEq)]
pub struct StridedPolynomial {
    pub stride: usize,
    pub coefficients: Box<[ScalarField]>,
}

impl StridedPolynomial {
    pub fn evaluate(&self, point: ScalarField) -> ScalarField {
        let base = point.pow(self.stride);
        self.coefficients
            .iter()
            .rev()
            .fold(ScalarField::zero(), |accumulator, coefficient| {
                accumulator * base + *coefficient
            })
    }
}

/// Builds the U2 selector `C^A_(i,k)` by interpolating one value on the
/// `s*t` coset-label domain. The returned polynomial has exactly `s*t`
/// coefficients rather than an `N_A`-element dense representation.
pub fn arithmetic_coset_selector(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit_id: usize,
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    if subcircuit_id >= shape.subcircuit_capacity {
        return Err(UnivariateRelationError::SubcircuitId {
            value: subcircuit_id,
        });
    }
    let label_count = arithmetic_label_count(shape, setup)?;
    let mut evaluations = vec![ScalarField::zero(); label_count];
    evaluations[placement_index + setup.s_max * subcircuit_id] = ScalarField::one();
    interpolate_selector(evaluations, setup.n)
}

/// Builds the U9a polynomial `S_kappa` directly from a capacity-length
/// selector. Only real library IDs are admitted; the `t - s_D` padding range
/// is never a legal placement value.
pub fn placement_selector_polynomial(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    selector: &[Option<usize>],
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if selector.len() != setup.s_max {
        return Err(UnivariateRelationError::SelectorCapacity {
            actual: selector.len(),
            expected: setup.s_max,
        });
    }
    let label_count = arithmetic_label_count(shape, setup)?;
    let mut evaluations = vec![ScalarField::zero(); label_count];
    for (placement_index, subcircuit_id) in selector.iter().enumerate() {
        if let Some(subcircuit_id) = subcircuit_id {
            if *subcircuit_id >= setup.s_D {
                return Err(UnivariateRelationError::SubcircuitId {
                    value: *subcircuit_id,
                });
            }
            evaluations[placement_index + setup.s_max * *subcircuit_id] = ScalarField::one();
        }
    }
    interpolate_selector(evaluations, setup.n)
}

/// Builds the U5 slot selector `C^C_i` over the `s` connection cosets.
pub fn connection_coset_selector(
    setup: &SetupParams,
    placement_index: usize,
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    let interface_wire_count = setup.l_D - setup.l;
    let mut evaluations = vec![ScalarField::zero(); setup.s_max];
    evaluations[placement_index] = ScalarField::one();
    interpolate_selector(evaluations, interface_wire_count)
}

fn arithmetic_label_count(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
) -> Result<usize, UnivariateRelationError> {
    setup
        .s_max
        .checked_mul(shape.subcircuit_capacity)
        .ok_or(UnivariateRelationError::TransformDomainNotPowerOfTwo { name: "s * t" })
}

fn interpolate_selector(
    evaluations: Vec<ScalarField>,
    stride: usize,
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if !evaluations.len().is_power_of_two() {
        return Err(UnivariateRelationError::TransformDomainNotPowerOfTwo {
            name: "selector-label domain",
        });
    }
    init_ntt_domain_for_size(evaluations.len()).map_err(UnivariateRelationError::Ntt)?;

    let mut coefficients = vec![ScalarField::zero(); evaluations.len()];
    ntt::ntt(
        HostSlice::from_slice(&evaluations),
        NTTDir::kInverse,
        &NTTConfig::<ScalarField>::default(),
        HostSlice::from_mut_slice(&mut coefficients),
    )
    .map_err(UnivariateRelationError::Ntt)?;
    Ok(StridedPolynomial {
        stride,
        coefficients: coefficients.into_boxed_slice(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        arithmetic_coset_selector, connection_coset_selector, placement_selector_polynomial,
    };
    use crate::frontend_artifacts::SetupParams;
    use crate::univariate_crs::UnivariateCrsShape;
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::{Arithmetic, FieldImpl};

    fn setup() -> SetupParams {
        SetupParams {
            l_free: 0,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 4,
            n: 2,
            s_D: 3,
            s_max: 2,
        }
    }

    #[test]
    fn arithmetic_selectors_match_the_u2_coset_values() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let selector = arithmetic_coset_selector(&shape, &setup, 1, 2).unwrap();

        for placement in 0..setup.s_max {
            for subcircuit in 0..shape.subcircuit_capacity {
                for row in 0..setup.n {
                    let point = shape.arithmetic_root.pow(
                        shape
                            .arithmetic_index(placement, subcircuit, row, &setup)
                            .unwrap(),
                    );
                    let expected = if (placement, subcircuit) == (1, 2) {
                        ScalarField::one()
                    } else {
                        ScalarField::zero()
                    };
                    assert_eq!(selector.evaluate(point), expected);
                }
            }
        }
    }

    #[test]
    fn placement_selector_uses_only_real_catalog_ids() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let selector = placement_selector_polynomial(&shape, &setup, &[Some(0), None]).unwrap();

        for placement in 0..setup.s_max {
            for subcircuit in 0..shape.subcircuit_capacity {
                let point = shape.arithmetic_root.pow(
                    shape
                        .arithmetic_index(placement, subcircuit, 0, &setup)
                        .unwrap(),
                );
                let expected = if (placement, subcircuit) == (0, 0) {
                    ScalarField::one()
                } else {
                    ScalarField::zero()
                };
                assert_eq!(selector.evaluate(point), expected);
            }
        }
        assert!(placement_selector_polynomial(&shape, &setup, &[Some(3), None]).is_err());
    }

    #[test]
    fn connection_selectors_match_the_u5_coset_values() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let selector = connection_coset_selector(&setup, 1).unwrap();

        for placement in 0..setup.s_max {
            for wire in 0..(setup.l_D - setup.l) {
                let connection_point = shape
                    .connection_root
                    .pow(shape.connection_index(placement, wire, &setup).unwrap());
                let expected = if placement == 1 {
                    ScalarField::one()
                } else {
                    ScalarField::zero()
                };
                assert_eq!(selector.evaluate(connection_point), expected);
            }
        }
    }
}
