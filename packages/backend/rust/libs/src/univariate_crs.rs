//! Private construction primitives for the univariate CRS foundation.
//!
//! This module intentionally has no serializer, artifact reader, or runtime
//! admission path. Until PM0-B adds the U20 and U21 query families, the U18
//! basis is not a usable CRS artifact.

use crate::frontend_artifacts::SetupParams;
use crate::group_structures::{G1serde, G2serde};
use icicle_bls12_381::curve::{G1Affine, G2Affine, ScalarCfg, ScalarField};
use icicle_core::ntt;
use icicle_core::traits::{Arithmetic, FieldImpl, GenerateRandom};
use thiserror::Error;

/// The sole schema identifier for the new univariate artifact family.
///
/// Its public-query layout is fixed by the resolved library's public-buffer
/// metadata. PM0-B will add its serialization and ingress validation.
pub const UNIVARIATE_CRS_SCHEMA_ID: &str = "tokamak-zk-evm-univariate-v1";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum UnivariateCrsError {
    #[error("{name} must be greater than one")]
    DomainTooSmall { name: &'static str },
    #[error("{name} exceeds the supported u64 domain size")]
    DomainTooLarge { name: &'static str },
    #[error("{name} has no primitive root of the required order")]
    InvalidDomainRoot { name: &'static str },
    #[error("{name} overflows while deriving univariate CRS capacity")]
    CapacityOverflow { name: &'static str },
    #[error("{name} must be nonzero")]
    ZeroTrapdoor { name: &'static str },
    #[error("tau belongs to the {domain} evaluation domain")]
    TauInsideDomain { domain: &'static str },
    #[error("failed to sample tau outside both evaluation domains")]
    TauSamplingExhausted,
    #[error("failed to allocate {length} ordinary KZG powers")]
    PowerAllocation { length: usize },
}

/// Capacity and domain information fixed by the library and placement bound.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateCrsShape {
    pub arithmetic_domain_size: usize,
    pub connection_domain_size: usize,
    pub degree_bound: usize,
    pub arithmetic_root: ScalarField,
    pub connection_root: ScalarField,
    pub blinding_bounds: [usize; 4],
}

impl UnivariateCrsShape {
    /// Derives U18/U22/U59 capacities from the existing library metadata.
    pub fn from_setup_params(params: &SetupParams) -> Result<Self, UnivariateCrsError> {
        let interface_wire_count =
            params
                .l_D
                .checked_sub(params.l)
                .ok_or(UnivariateCrsError::CapacityOverflow {
                    name: "m_I = l_D - l",
                })?;
        let arithmetic_domain_size = params
            .n
            .checked_mul(params.s_max)
            .and_then(|value| value.checked_mul(params.s_D))
            .ok_or(UnivariateCrsError::CapacityOverflow {
                name: "N_A = n * s_max * s_D",
            })?;
        let connection_domain_size = interface_wire_count.checked_mul(params.s_max).ok_or(
            UnivariateCrsError::CapacityOverflow {
                name: "N_C = m_I * s_max",
            },
        )?;
        if arithmetic_domain_size <= 1 {
            return Err(UnivariateCrsError::DomainTooSmall { name: "N_A" });
        }
        if connection_domain_size <= 1 {
            return Err(UnivariateCrsError::DomainTooSmall { name: "N_C" });
        }
        let arithmetic_bound = arithmetic_domain_size
            .checked_mul(2)
            .and_then(|value| value.checked_sub(params.n))
            .and_then(|value| value.checked_add(2))
            .ok_or(UnivariateCrsError::CapacityOverflow {
                name: "2 * N_A - n + 2",
            })?;
        let connection_bound = connection_domain_size
            .checked_add(4)
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "N_C + 4" })?;

        Ok(Self {
            arithmetic_domain_size,
            connection_domain_size,
            degree_bound: arithmetic_bound.max(connection_bound),
            arithmetic_root: primitive_root("N_A", arithmetic_domain_size)?,
            connection_root: primitive_root("N_C", connection_domain_size)?,
            blinding_bounds: [2; 4],
        })
    }
}

/// Analysis-only trapdoors required to construct the U18 basis.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateTrapdoor {
    tau: ScalarField,
    alpha: ScalarField,
    gamma: ScalarField,
    eta: ScalarField,
    delta: ScalarField,
}

impl UnivariateTrapdoor {
    pub fn new(
        shape: &UnivariateCrsShape,
        tau: ScalarField,
        alpha: ScalarField,
        gamma: ScalarField,
        eta: ScalarField,
        delta: ScalarField,
    ) -> Result<Self, UnivariateCrsError> {
        for (name, value) in [
            ("tau", tau),
            ("alpha", alpha),
            ("gamma", gamma),
            ("eta", eta),
            ("delta", delta),
        ] {
            if value == ScalarField::zero() {
                return Err(UnivariateCrsError::ZeroTrapdoor { name });
            }
        }
        if tau.pow(shape.arithmetic_domain_size) == ScalarField::one() {
            return Err(UnivariateCrsError::TauInsideDomain {
                domain: "arithmetic",
            });
        }
        if tau.pow(shape.connection_domain_size) == ScalarField::one() {
            return Err(UnivariateCrsError::TauInsideDomain {
                domain: "connection",
            });
        }
        Ok(Self {
            tau,
            alpha,
            gamma,
            eta,
            delta,
        })
    }

    pub fn sample(shape: &UnivariateCrsShape) -> Result<Self, UnivariateCrsError> {
        for _ in 0..64 {
            let tau = nonzero_scalar();
            if let Ok(trapdoor) = Self::new(
                shape,
                tau,
                nonzero_scalar(),
                nonzero_scalar(),
                nonzero_scalar(),
                nonzero_scalar(),
            ) {
                return Ok(trapdoor);
            }
        }
        Err(UnivariateCrsError::TauSamplingExhausted)
    }
}

/// The non-serializable U18 ordinary KZG basis.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateCrsFoundation {
    pub schema_id: &'static str,
    pub shape: UnivariateCrsShape,
    pub tau_powers_g1: Box<[G1serde]>,
    pub one_g2: G2serde,
    pub tau_g2: G2serde,
    pub alpha_g2: [G2serde; 4],
    pub gamma_g2: G2serde,
    pub eta_g2: G2serde,
    pub delta_g2: G2serde,
}

impl UnivariateCrsFoundation {
    /// Generates only U18. PM0-B appends the U20 and U21 query families.
    pub fn generate(
        shape: UnivariateCrsShape,
        trapdoor: &UnivariateTrapdoor,
        g1: G1Affine,
        g2: G2Affine,
    ) -> Result<Self, UnivariateCrsError> {
        let power_count = shape
            .degree_bound
            .checked_add(1)
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "D + 1" })?;
        let mut tau_powers_g1 = Vec::new();
        tau_powers_g1.try_reserve_exact(power_count).map_err(|_| {
            UnivariateCrsError::PowerAllocation {
                length: power_count,
            }
        })?;

        let mut tau_power = ScalarField::one();
        for _ in 0..power_count {
            tau_powers_g1.push(G1serde(G1Affine::from(g1.to_projective() * tau_power)));
            tau_power = tau_power * trapdoor.tau;
        }

        let alpha_g2 = std::array::from_fn(|index| {
            let exponent = index + 1;
            G2serde(G2Affine::from(
                g2.to_projective() * trapdoor.alpha.pow(exponent),
            ))
        });

        Ok(Self {
            schema_id: UNIVARIATE_CRS_SCHEMA_ID,
            shape,
            tau_powers_g1: tau_powers_g1.into_boxed_slice(),
            one_g2: G2serde(g2),
            tau_g2: G2serde(G2Affine::from(g2.to_projective() * trapdoor.tau)),
            alpha_g2,
            gamma_g2: G2serde(G2Affine::from(g2.to_projective() * trapdoor.gamma)),
            eta_g2: G2serde(G2Affine::from(g2.to_projective() * trapdoor.eta)),
            delta_g2: G2serde(G2Affine::from(g2.to_projective() * trapdoor.delta)),
        })
    }
}

fn primitive_root(
    name: &'static str,
    domain_size: usize,
) -> Result<ScalarField, UnivariateCrsError> {
    if domain_size <= 1 {
        return Err(UnivariateCrsError::DomainTooSmall { name });
    }
    let domain_size_u64 =
        u64::try_from(domain_size).map_err(|_| UnivariateCrsError::DomainTooLarge { name })?;
    let root = ntt::get_root_of_unity::<ScalarField>(domain_size_u64);
    if root.pow(domain_size) != ScalarField::one()
        || distinct_prime_factors(domain_size)
            .iter()
            .any(|factor| root.pow(domain_size / factor) == ScalarField::one())
    {
        return Err(UnivariateCrsError::InvalidDomainRoot { name });
    }
    Ok(root)
}

fn distinct_prime_factors(mut value: usize) -> Vec<usize> {
    let mut factors = Vec::new();
    let mut divisor = 2;
    while divisor <= value / divisor {
        if value % divisor == 0 {
            factors.push(divisor);
            while value % divisor == 0 {
                value /= divisor;
            }
        }
        divisor += if divisor == 2 { 1 } else { 2 };
    }
    if value > 1 {
        factors.push(value);
    }
    factors
}

fn nonzero_scalar() -> ScalarField {
    loop {
        let scalar = ScalarCfg::generate_random(1)[0];
        if scalar != ScalarField::zero() {
            return scalar;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        UnivariateCrsError, UnivariateCrsFoundation, UnivariateCrsShape, UnivariateTrapdoor,
        UNIVARIATE_CRS_SCHEMA_ID,
    };
    use crate::frontend_artifacts::SetupParams;
    use crate::group_structures::{G1serde, G2serde};
    use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg, ScalarField};
    use icicle_core::curve::Curve;
    use icicle_core::traits::{Arithmetic, FieldImpl};

    fn setup_params() -> SetupParams {
        SetupParams {
            l_free: 0,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 4,
            n: 2,
            s_D: 2,
            s_max: 2,
        }
    }

    fn test_trapdoor(shape: &UnivariateCrsShape) -> UnivariateTrapdoor {
        let mut tau = ScalarField::from_u32(2);
        while tau.pow(shape.arithmetic_domain_size) == ScalarField::one()
            || tau.pow(shape.connection_domain_size) == ScalarField::one()
        {
            tau = tau + ScalarField::one();
        }
        UnivariateTrapdoor::new(
            shape,
            tau,
            ScalarField::from_u32(3),
            ScalarField::from_u32(5),
            ScalarField::from_u32(7),
            ScalarField::from_u32(11),
        )
        .expect("test trapdoor must satisfy the domain exclusion")
    }

    #[test]
    fn derives_u59_capacity_and_generates_the_u18_basis() {
        let shape = UnivariateCrsShape::from_setup_params(&setup_params())
            .expect("test setup parameters must define supported domains");
        assert_eq!(shape.arithmetic_domain_size, 8);
        assert_eq!(shape.connection_domain_size, 4);
        assert_eq!(shape.degree_bound, 16);
        assert_eq!(shape.blinding_bounds, [2; 4]);

        let g1 = CurveCfg::generate_random_affine_points(1)[0];
        let g2 = G2CurveCfg::generate_random_affine_points(1)[0];
        let trapdoor = test_trapdoor(&shape);
        let foundation = UnivariateCrsFoundation::generate(shape, &trapdoor, g1, g2)
            .expect("U18 basis generation must succeed");

        assert_eq!(foundation.schema_id, UNIVARIATE_CRS_SCHEMA_ID);
        assert_eq!(foundation.tau_powers_g1.len(), 17);
        assert_eq!(foundation.tau_powers_g1[0], G1serde(g1));
        assert_eq!(
            foundation.tau_powers_g1[3],
            foundation.tau_powers_g1[2] * trapdoor.tau
        );
        assert_eq!(foundation.one_g2, G2serde(g2));
        assert_eq!(foundation.tau_g2, foundation.one_g2 * trapdoor.tau);
        assert_eq!(
            foundation.alpha_g2[3],
            foundation.one_g2 * trapdoor.alpha.pow(4)
        );
    }

    #[test]
    fn rejects_tau_inside_an_evaluation_domain() {
        let shape = UnivariateCrsShape::from_setup_params(&setup_params())
            .expect("test setup parameters must define supported domains");
        let error = UnivariateTrapdoor::new(
            &shape,
            shape.arithmetic_root,
            ScalarField::from_u32(3),
            ScalarField::from_u32(5),
            ScalarField::from_u32(7),
            ScalarField::from_u32(11),
        )
        .expect_err("a domain root cannot be used as tau");
        assert_eq!(
            error,
            UnivariateCrsError::TauInsideDomain {
                domain: "arithmetic"
            }
        );
    }

    #[test]
    fn rejects_zero_sized_subcircuit_library() {
        let mut params = setup_params();
        params.s_D = 0;
        let error = UnivariateCrsShape::from_setup_params(&params)
            .expect_err("zero subcircuit count cannot define N_A");
        assert_eq!(error, UnivariateCrsError::DomainTooSmall { name: "N_A" });
    }
}
