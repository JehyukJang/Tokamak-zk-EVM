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
    #[error("{coordinate} index {value} is outside its admitted range")]
    IndexOutOfRange {
        coordinate: &'static str,
        value: usize,
    },
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
    /// The power-of-two arithmetic type capacity `t`, strictly above `s_D`.
    pub subcircuit_capacity: usize,
    pub arithmetic_domain_size: usize,
    pub connection_domain_size: usize,
    pub intersection_domain_size: usize,
    pub union_domain_size: usize,
    pub degree_bound: usize,
    pub arithmetic_root: ScalarField,
    pub connection_root: ScalarField,
    pub blinding_bounds: [usize; 4],
}

impl UnivariateCrsShape {
    /// Derives U18/U22/U59 capacities from the existing library metadata.
    pub fn from_setup_params(params: &SetupParams) -> Result<Self, UnivariateCrsError> {
        let subcircuit_capacity = strict_power_of_two_capacity(params.s_D)?;
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
            .and_then(|value| value.checked_mul(subcircuit_capacity))
            .ok_or(UnivariateCrsError::CapacityOverflow {
                name: "N_A = n * s_max * t",
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
        let intersection_domain_size =
            greatest_common_divisor(arithmetic_domain_size, connection_domain_size);
        let union_domain_size =
            least_common_multiple(arithmetic_domain_size, connection_domain_size)?;
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
            subcircuit_capacity,
            arithmetic_domain_size,
            connection_domain_size,
            intersection_domain_size,
            union_domain_size,
            degree_bound: arithmetic_bound.max(connection_bound),
            arithmetic_root: primitive_root("N_A", arithmetic_domain_size)?,
            connection_root: primitive_root("N_C", connection_domain_size)?,
            blinding_bounds: [2; 4],
        })
    }

    /// U1's canonical flat index for an arithmetic-domain coordinate.
    pub fn arithmetic_index(
        &self,
        placement_index: usize,
        subcircuit_id: usize,
        constraint_row: usize,
        setup: &SetupParams,
    ) -> Result<usize, UnivariateCrsError> {
        if placement_index >= setup.s_max {
            return Err(UnivariateCrsError::IndexOutOfRange {
                coordinate: "placement",
                value: placement_index,
            });
        }
        if subcircuit_id >= self.subcircuit_capacity {
            return Err(UnivariateCrsError::IndexOutOfRange {
                coordinate: "subcircuit",
                value: subcircuit_id,
            });
        }
        if constraint_row >= setup.n {
            return Err(UnivariateCrsError::IndexOutOfRange {
                coordinate: "constraint row",
                value: constraint_row,
            });
        }

        setup
            .s_max
            .checked_mul(subcircuit_id)
            .and_then(|subcircuit_offset| placement_index.checked_add(subcircuit_offset))
            .and_then(|prefix| {
                setup
                    .s_max
                    .checked_mul(self.subcircuit_capacity)
                    .and_then(|stride| stride.checked_mul(constraint_row))
                    .and_then(|row_offset| prefix.checked_add(row_offset))
            })
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "U1 index" })
    }

    /// U4's canonical flat index for a connection-domain coordinate.
    pub fn connection_index(
        &self,
        placement_index: usize,
        interface_wire_index: usize,
        setup: &SetupParams,
    ) -> Result<usize, UnivariateCrsError> {
        let interface_wire_count =
            setup
                .l_D
                .checked_sub(setup.l)
                .ok_or(UnivariateCrsError::CapacityOverflow {
                    name: "m_I = l_D - l",
                })?;
        if placement_index >= setup.s_max {
            return Err(UnivariateCrsError::IndexOutOfRange {
                coordinate: "placement",
                value: placement_index,
            });
        }
        if interface_wire_index >= interface_wire_count {
            return Err(UnivariateCrsError::IndexOutOfRange {
                coordinate: "interface wire",
                value: interface_wire_index,
            });
        }

        setup
            .s_max
            .checked_mul(interface_wire_index)
            .and_then(|wire_offset| placement_index.checked_add(wire_offset))
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "U4 index" })
    }
}

/// Returns the smallest power of two strictly greater than the library's
/// subcircuit catalog size. This is the new protocol's arithmetic type capacity
/// `t`; IDs in `[s_D, t)` are permanently inactive padding coordinates.
fn strict_power_of_two_capacity(subcircuit_count: usize) -> Result<usize, UnivariateCrsError> {
    if subcircuit_count == 0 {
        return Err(UnivariateCrsError::DomainTooSmall { name: "s_D" });
    }

    let capacity = if subcircuit_count.is_power_of_two() {
        subcircuit_count.checked_mul(2)
    } else {
        subcircuit_count.checked_next_power_of_two()
    };
    capacity.ok_or(UnivariateCrsError::CapacityOverflow { name: "t" })
}

fn greatest_common_divisor(mut left: usize, mut right: usize) -> usize {
    while right != 0 {
        (left, right) = (right, left % right);
    }
    left
}

fn least_common_multiple(left: usize, right: usize) -> Result<usize, UnivariateCrsError> {
    (left / greatest_common_divisor(left, right))
        .checked_mul(right)
        .ok_or(UnivariateCrsError::CapacityOverflow { name: "N_union" })
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
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct DomainFixture {
        cases: Vec<DomainFixtureCase>,
    }

    #[derive(Deserialize)]
    struct DomainFixtureCase {
        setup: DomainFixtureSetup,
        expected: DomainFixtureExpected,
    }

    #[derive(Deserialize)]
    struct DomainFixtureSetup {
        l: usize,
        #[serde(rename = "l_D")]
        l_d: usize,
        n: usize,
        #[serde(rename = "s_D")]
        s_d: usize,
        s_max: usize,
    }

    #[derive(Deserialize)]
    struct DomainFixtureExpected {
        t: usize,
        #[serde(rename = "N_A")]
        n_a: usize,
        #[serde(rename = "N_C")]
        n_c: usize,
        #[serde(rename = "N_G")]
        n_g: usize,
        #[serde(rename = "N_union")]
        n_union: usize,
        #[serde(rename = "D")]
        d: usize,
        #[serde(rename = "arithmeticIndex")]
        arithmetic_index: usize,
        #[serde(rename = "connectionIndex")]
        connection_index: usize,
    }

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
        assert_eq!(shape.subcircuit_capacity, 4);
        assert_eq!(shape.arithmetic_domain_size, 16);
        assert_eq!(shape.connection_domain_size, 4);
        assert_eq!(shape.intersection_domain_size, 4);
        assert_eq!(shape.union_domain_size, 16);
        assert_eq!(shape.degree_bound, 32);
        assert_eq!(shape.blinding_bounds, [2; 4]);

        let g1 = CurveCfg::generate_random_affine_points(1)[0];
        let g2 = G2CurveCfg::generate_random_affine_points(1)[0];
        let trapdoor = test_trapdoor(&shape);
        let foundation = UnivariateCrsFoundation::generate(shape, &trapdoor, g1, g2)
            .expect("U18 basis generation must succeed");

        assert_eq!(foundation.schema_id, UNIVARIATE_CRS_SCHEMA_ID);
        assert_eq!(foundation.tau_powers_g1.len(), 33);
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
            .expect_err("zero subcircuit count cannot define t");
        assert_eq!(error, UnivariateCrsError::DomainTooSmall { name: "s_D" });
    }

    #[test]
    fn derives_a_strictly_larger_power_of_two_type_capacity() {
        let mut params = setup_params();
        params.s_D = 3;
        assert_eq!(
            UnivariateCrsShape::from_setup_params(&params)
                .expect("non-power-of-two catalog must be padded")
                .subcircuit_capacity,
            4
        );

        params.s_D = 4;
        assert_eq!(
            UnivariateCrsShape::from_setup_params(&params)
                .expect("power-of-two catalog must still use a strictly larger capacity")
                .subcircuit_capacity,
            8
        );
    }

    #[test]
    fn current_library_type_padding_produces_a_radix_two_arithmetic_domain() {
        let mut params = setup_params();
        params.n = 1024;
        params.s_D = 44;
        params.s_max = 256;
        params.l = 396;
        params.l_D = 1420;

        let shape = UnivariateCrsShape::from_setup_params(&params)
            .expect("current library dimensions must define supported domains");
        assert_eq!(shape.subcircuit_capacity, 64);
        assert_eq!(shape.arithmetic_domain_size, 1 << 24);
        assert_eq!(shape.connection_domain_size, 1 << 18);
        assert_eq!(shape.intersection_domain_size, 1 << 18);
        assert_eq!(shape.union_domain_size, 1 << 24);
    }

    #[test]
    fn matches_the_backend_owned_univariate_domain_fixtures() {
        let fixture: DomainFixture = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../common/contracts/fixtures/univariate-domain-shape.v1.json"
        )))
        .expect("univariate domain fixture must be valid JSON");

        for case in fixture.cases {
            let shape = UnivariateCrsShape::from_setup_params(&SetupParams {
                l_free: 0,
                l: case.setup.l,
                l_user_out: 0,
                l_user: 0,
                l_D: case.setup.l_d,
                m_D: case.setup.l_d,
                n: case.setup.n,
                s_D: case.setup.s_d,
                s_max: case.setup.s_max,
            })
            .expect("fixture must describe a supported univariate domain");
            assert_eq!(shape.subcircuit_capacity, case.expected.t);
            assert_eq!(shape.arithmetic_domain_size, case.expected.n_a);
            assert_eq!(shape.connection_domain_size, case.expected.n_c);
            assert_eq!(shape.intersection_domain_size, case.expected.n_g);
            assert_eq!(shape.union_domain_size, case.expected.n_union);
            assert_eq!(shape.degree_bound, case.expected.d);
            let setup = SetupParams {
                l_free: 0,
                l: case.setup.l,
                l_user_out: 0,
                l_user: 0,
                l_D: case.setup.l_d,
                m_D: case.setup.l_d,
                n: case.setup.n,
                s_D: case.setup.s_d,
                s_max: case.setup.s_max,
            };
            assert_eq!(
                shape
                    .arithmetic_index(
                        setup.s_max - 1,
                        shape.subcircuit_capacity - 1,
                        setup.n - 1,
                        &setup,
                    )
                    .expect("maximum U1 coordinate must be admitted"),
                case.expected.arithmetic_index
            );
            assert_eq!(
                shape
                    .connection_index(setup.s_max - 1, setup.l_D - setup.l - 1, &setup)
                    .expect("maximum U4 coordinate must be admitted"),
                case.expected.connection_index
            );
        }
    }
}
