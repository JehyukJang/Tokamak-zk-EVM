//! Construction primitives and in-memory representation for the univariate
//! U18--U21 CRS. Artifact projections and admission live in
//! `crate::crs_artifacts` so this module remains independent of filesystem and
//! archive concerns.

use crate::frontend_artifacts::public_wire_layout::{PublicQueryKey, PublicWireLayout};
use crate::frontend_artifacts::SetupParams;
use crate::group_structures::{G1serde, G2serde};
use crate::univariate_relation::{
    arithmetic_wire_lifts_at, connection_wire_lift_at, UnivariateRelationError,
    UnivariateSubcircuit,
};
use icicle_bls12_381::curve::{G1Affine, G2Affine, ScalarCfg, ScalarField};
use icicle_core::ntt;
use icicle_core::traits::{Arithmetic, FieldImpl, GenerateRandom};
use serde::Serialize;
use thiserror::Error;

/// The sole schema identifier for the new univariate artifact family.
/// Its public-query layout is fixed by resolved public-buffer metadata.
pub const UNIVARIATE_CRS_SCHEMA_ID: &str = "tokamak-zk-evm-univariate-v1";

#[derive(Debug, Error)]
pub enum UnivariateCrsError {
    #[error("{name} must be greater than one")]
    DomainTooSmall { name: &'static str },
    #[error("{name} must be a nonzero power of two for the selected transform provider")]
    DomainNotPowerOfTwo { name: &'static str },
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
    #[error("polynomial commitment needs {actual} KZG powers, but the CRS has {available}")]
    CommitmentDegree { actual: usize, available: usize },
    #[error("subcircuit catalog has {actual} entries, expected {expected}")]
    SubcircuitCatalog { actual: usize, expected: usize },
    #[error("subcircuit catalog entry {index} declares ID {actual}")]
    SubcircuitId { index: usize, actual: usize },
    #[error("public query key ({subcircuit_id}, {local_wire_index}) is invalid")]
    InvalidPublicQueryKey {
        subcircuit_id: usize,
        local_wire_index: usize,
    },
    #[error("duplicate compressed public query key ({subcircuit_id}, {local_wire_index})")]
    DuplicatePublicQueryKey {
        subcircuit_id: usize,
        local_wire_index: usize,
    },
    #[error(transparent)]
    Relation(#[from] UnivariateRelationError),
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
        if !interface_wire_count.is_power_of_two() {
            return Err(UnivariateCrsError::DomainNotPowerOfTwo { name: "m_I" });
        }
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

/// The U18 ordinary KZG basis carried by the complete in-memory CRS.
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

/// The canonical compressed key for one U20 public binding query.  It is
/// deliberately independent of the runtime placement: the only admitted
/// public-buffer placement is the fixed `(b, b)` coordinate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnivariatePublicQuery {
    pub key: PublicQueryKey,
    pub point: G1serde,
}

/// A full U20 key used for interface and internal wires.  Unlike public
/// buffers, non-public wires retain their independent placement coordinate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnivariateTaggedQuery {
    pub placement_index: usize,
    pub subcircuit_id: usize,
    pub local_wire_index: usize,
    pub point: G1serde,
}

/// Read-only indices over a validated U20 query layout.  They contain only
/// positions into the decoded CRS, so repeated proof generation avoids both
/// linear query scans and a second copy of the curve points.
pub struct UnivariateQueryIndex {
    public: std::collections::HashMap<PublicQueryKey, usize>,
    interface: std::collections::HashMap<(usize, usize, usize), usize>,
    internal: std::collections::HashMap<(usize, usize, usize), usize>,
}

impl UnivariateQueryIndex {
    pub fn public_index(&self, key: PublicQueryKey) -> Option<usize> {
        self.public.get(&key).copied()
    }

    pub fn interface_index(&self, key: (usize, usize, usize)) -> Option<usize> {
        self.interface.get(&key).copied()
    }

    pub fn internal_index(&self, key: (usize, usize, usize)) -> Option<usize> {
        self.internal.get(&key).copied()
    }
}

/// The complete, in-memory U18--U21 CRS.  This is intentionally distinct
/// from legacy `Sigma`: it has no bivariate fields and is not accepted by any
/// legacy/MPC reader.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateCrs {
    pub foundation: UnivariateCrsFoundation,
    pub gamma_inv_public_queries: Box<[UnivariatePublicQuery]>,
    pub eta_inv_interface_queries: Box<[UnivariateTaggedQuery]>,
    pub delta_inv_internal_queries: Box<[UnivariateTaggedQuery]>,
    pub delta_inv_arithmetic_masking_queries: [Box<[G1serde]>; 3],
    pub delta_inv_connection_masking_queries: Box<[G1serde]>,
    pub delta_g1: G1serde,
    pub eta_g1: G1serde,
}

/// JSON projection used at the native/browser conversion boundary.  The RKYV
/// projection is the native loading format; this form deliberately exposes
/// the same groups and keys for canonical cross-runtime conversion.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnivariateCrsJson<'a> {
    pub schema_id: &'a str,
    pub shape: UnivariateCrsShapeJson,
    pub tau_powers_g1: &'a [G1serde],
    pub one_g2: G2serde,
    pub tau_g2: G2serde,
    pub alpha_g2: [G2serde; 4],
    pub gamma_g2: G2serde,
    pub eta_g2: G2serde,
    pub delta_g2: G2serde,
    pub gamma_inv_public_queries: Vec<UnivariatePublicQueryJson>,
    pub eta_inv_interface_queries: Vec<UnivariateTaggedQueryJson>,
    pub delta_inv_internal_queries: Vec<UnivariateTaggedQueryJson>,
    pub delta_inv_arithmetic_masking_queries: [&'a [G1serde]; 3],
    pub delta_inv_connection_masking_queries: &'a [G1serde],
    pub delta_g1: G1serde,
    pub eta_g1: G1serde,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnivariateCrsShapeJson {
    pub subcircuit_capacity: usize,
    pub arithmetic_domain_size: usize,
    pub connection_domain_size: usize,
    pub intersection_domain_size: usize,
    pub union_domain_size: usize,
    pub degree_bound: usize,
    pub blinding_bounds: [usize; 4],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnivariatePublicQueryJson {
    pub buffer_subcircuit_id: usize,
    pub local_public_wire_index: usize,
    pub point: G1serde,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnivariateTaggedQueryJson {
    pub placement_index: usize,
    pub subcircuit_id: usize,
    pub local_wire_index: usize,
    pub point: G1serde,
}

impl UnivariateCrsFoundation {
    /// Generates the U18 ordinary KZG basis used by complete CRS construction.
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

impl UnivariateCrs {
    /// Builds all U18--U21 groups from the sparse relation and the resolved
    /// library.  The public-query range is intentionally compressed to the
    /// fixed public-buffer coordinates validated by `PublicWireLayout`.
    pub fn generate(
        setup: &SetupParams,
        public_wire_layout: &PublicWireLayout,
        subcircuits: &[UnivariateSubcircuit<'_>],
        trapdoor: &UnivariateTrapdoor,
        g1: G1Affine,
        g2: G2Affine,
    ) -> Result<Self, UnivariateCrsError> {
        let shape = UnivariateCrsShape::from_setup_params(setup)?;
        if subcircuits.len() != setup.s_D {
            return Err(UnivariateCrsError::SubcircuitCatalog {
                actual: subcircuits.len(),
                expected: setup.s_D,
            });
        }
        for (index, subcircuit) in subcircuits.iter().enumerate() {
            if subcircuit.id != index {
                return Err(UnivariateCrsError::SubcircuitId {
                    index,
                    actual: subcircuit.id,
                });
            }
        }

        let foundation = UnivariateCrsFoundation::generate(shape.clone(), trapdoor, g1, g2)?;
        let base_g1 = foundation.tau_powers_g1[0];
        let mut seen_public_keys = std::collections::HashSet::new();
        let mut gamma_inv_public_queries = Vec::new();
        for key in public_wire_layout.public_query_keys() {
            if !seen_public_keys.insert((key.buffer_subcircuit_id, key.local_public_wire_index)) {
                return Err(UnivariateCrsError::DuplicatePublicQueryKey {
                    subcircuit_id: key.buffer_subcircuit_id,
                    local_wire_index: key.local_public_wire_index,
                });
            }
            let subcircuit = subcircuits
                .get(key.buffer_subcircuit_id)
                .filter(|subcircuit| key.local_public_wire_index < subcircuit.flatten_map.len())
                .ok_or(UnivariateCrsError::InvalidPublicQueryKey {
                    subcircuit_id: key.buffer_subcircuit_id,
                    local_wire_index: key.local_public_wire_index,
                })?;
            let query = tagged_query_at(
                &shape,
                setup,
                key.buffer_subcircuit_id,
                subcircuit,
                key.local_public_wire_index,
                trapdoor,
            )?;
            gamma_inv_public_queries.push(UnivariatePublicQuery {
                key,
                point: base_g1 * (trapdoor.gamma.inv() * query),
            });
        }

        let mut eta_inv_interface_queries = Vec::new();
        let mut delta_inv_internal_queries = Vec::new();
        for placement_index in 0..setup.s_max {
            for subcircuit in subcircuits {
                for (local_wire_index, global_wire_index) in
                    subcircuit.flatten_map.iter().copied().enumerate()
                {
                    let query = match global_wire_index {
                        value if value < setup.l => continue,
                        value if value < setup.l_D => tagged_query_at(
                            &shape,
                            setup,
                            placement_index,
                            subcircuit,
                            local_wire_index,
                            trapdoor,
                        )?,
                        _ => tagged_query_at(
                            &shape,
                            setup,
                            placement_index,
                            subcircuit,
                            local_wire_index,
                            trapdoor,
                        )?,
                    };
                    let tagged = UnivariateTaggedQuery {
                        placement_index,
                        subcircuit_id: subcircuit.id,
                        local_wire_index,
                        point: if global_wire_index < setup.l_D {
                            base_g1 * (trapdoor.eta.inv() * query)
                        } else {
                            base_g1 * (trapdoor.delta.inv() * query)
                        },
                    };
                    if global_wire_index < setup.l_D {
                        eta_inv_interface_queries.push(tagged);
                    } else {
                        delta_inv_internal_queries.push(tagged);
                    }
                }
            }
        }

        let z_a = trapdoor.tau.pow(shape.arithmetic_domain_size) - ScalarField::one();
        let z_c = trapdoor.tau.pow(shape.connection_domain_size) - ScalarField::one();
        let delta_inverse = trapdoor.delta.inv();
        let delta_inv_arithmetic_masking_queries = std::array::from_fn(|index| {
            let alpha_power = trapdoor.alpha.pow(index + 1);
            let mut tau_power = ScalarField::one();
            (0..shape.blinding_bounds[index])
                .map(|_| {
                    let point = base_g1 * (delta_inverse * alpha_power * tau_power * z_a);
                    tau_power = tau_power * trapdoor.tau;
                    point
                })
                .collect::<Vec<_>>()
                .into_boxed_slice()
        });
        let mut tau_power = ScalarField::one();
        let delta_inv_connection_masking_queries = (0..shape.blinding_bounds[3])
            .map(|_| {
                let point = base_g1 * (delta_inverse * trapdoor.alpha.pow(4) * tau_power * z_c);
                tau_power = tau_power * trapdoor.tau;
                point
            })
            .collect::<Vec<_>>()
            .into_boxed_slice();

        Ok(Self {
            foundation,
            gamma_inv_public_queries: gamma_inv_public_queries.into_boxed_slice(),
            eta_inv_interface_queries: eta_inv_interface_queries.into_boxed_slice(),
            delta_inv_internal_queries: delta_inv_internal_queries.into_boxed_slice(),
            delta_inv_arithmetic_masking_queries,
            delta_inv_connection_masking_queries,
            delta_g1: base_g1 * trapdoor.delta,
            eta_g1: base_g1 * trapdoor.eta,
        })
    }

    pub fn json_projection(&self) -> UnivariateCrsJson<'_> {
        let foundation = &self.foundation;
        UnivariateCrsJson {
            schema_id: foundation.schema_id,
            shape: UnivariateCrsShapeJson {
                subcircuit_capacity: foundation.shape.subcircuit_capacity,
                arithmetic_domain_size: foundation.shape.arithmetic_domain_size,
                connection_domain_size: foundation.shape.connection_domain_size,
                intersection_domain_size: foundation.shape.intersection_domain_size,
                union_domain_size: foundation.shape.union_domain_size,
                degree_bound: foundation.shape.degree_bound,
                blinding_bounds: foundation.shape.blinding_bounds,
            },
            tau_powers_g1: &foundation.tau_powers_g1,
            one_g2: foundation.one_g2,
            tau_g2: foundation.tau_g2,
            alpha_g2: foundation.alpha_g2,
            gamma_g2: foundation.gamma_g2,
            eta_g2: foundation.eta_g2,
            delta_g2: foundation.delta_g2,
            gamma_inv_public_queries: self
                .gamma_inv_public_queries
                .iter()
                .map(|query| UnivariatePublicQueryJson {
                    buffer_subcircuit_id: query.key.buffer_subcircuit_id,
                    local_public_wire_index: query.key.local_public_wire_index,
                    point: query.point,
                })
                .collect(),
            eta_inv_interface_queries: self
                .eta_inv_interface_queries
                .iter()
                .map(UnivariateTaggedQueryJson::from_query)
                .collect(),
            delta_inv_internal_queries: self
                .delta_inv_internal_queries
                .iter()
                .map(UnivariateTaggedQueryJson::from_query)
                .collect(),
            delta_inv_arithmetic_masking_queries: self
                .delta_inv_arithmetic_masking_queries
                .each_ref()
                .map(|queries| queries.as_ref()),
            delta_inv_connection_masking_queries: &self.delta_inv_connection_masking_queries,
            delta_g1: self.delta_g1,
            eta_g1: self.eta_g1,
        }
    }

    /// Builds reusable indices after native CRS admission. The serialized CRS
    /// is already required to have a canonical, duplicate-free query layout.
    pub fn query_index(&self) -> UnivariateQueryIndex {
        UnivariateQueryIndex {
            public: self
                .gamma_inv_public_queries
                .iter()
                .enumerate()
                .map(|(index, query)| (query.key, index))
                .collect(),
            interface: self
                .eta_inv_interface_queries
                .iter()
                .enumerate()
                .map(|(index, query)| {
                    (
                        (
                            query.placement_index,
                            query.subcircuit_id,
                            query.local_wire_index,
                        ),
                        index,
                    )
                })
                .collect(),
            internal: self
                .delta_inv_internal_queries
                .iter()
                .enumerate()
                .map(|(index, query)| {
                    (
                        (
                            query.placement_index,
                            query.subcircuit_id,
                            query.local_wire_index,
                        ),
                        index,
                    )
                })
                .collect(),
        }
    }

    /// Commits a dense univariate polynomial with the ordinary U18 KZG
    /// powers.  The temporary affine-base vector is bounded by the supplied
    /// polynomial, not by the complete CRS degree capacity.
    pub fn commit_dense_polynomial(
        &self,
        coefficients: &[ScalarField],
    ) -> Result<G1serde, UnivariateCrsError> {
        self.commit_indexed_coefficients(coefficients.iter().copied().enumerate())
    }

    /// Commits a strided selector without expanding its zero coefficients.
    pub fn commit_strided_polynomial(
        &self,
        polynomial: &crate::univariate_relation::StridedPolynomial,
    ) -> Result<G1serde, UnivariateCrsError> {
        self.commit_indexed_coefficients(
            polynomial
                .coefficients
                .iter()
                .copied()
                .enumerate()
                .map(|(index, coefficient)| {
                    index
                        .checked_mul(polynomial.stride)
                        .ok_or(UnivariateCrsError::CapacityOverflow {
                            name: "strided KZG commitment index",
                        })
                        .map(|power| (power, coefficient))
                })
                .collect::<Result<Vec<_>, _>>()?
                .into_iter(),
        )
    }

    fn commit_indexed_coefficients(
        &self,
        coefficients: impl IntoIterator<Item = (usize, ScalarField)>,
    ) -> Result<G1serde, UnivariateCrsError> {
        let pairs = coefficients.into_iter().collect::<Vec<_>>();
        let available = self.foundation.tau_powers_g1.len();
        let highest_power = pairs.iter().map(|(power, _)| *power).max();
        if highest_power.is_some_and(|power| power >= available) {
            return Err(UnivariateCrsError::CommitmentDegree {
                actual: highest_power.unwrap_or_default().saturating_add(1),
                available,
            });
        }
        let scalars = pairs.iter().map(|(_, scalar)| *scalar).collect::<Vec<_>>();
        let bases = pairs
            .iter()
            .map(|(power, _)| self.foundation.tau_powers_g1[*power].0)
            .collect::<Vec<_>>();
        Ok(crate::group_structures::msm_g1_bases(&scalars, &bases))
    }
}

impl UnivariateTaggedQueryJson {
    fn from_query(query: &UnivariateTaggedQuery) -> Self {
        Self {
            placement_index: query.placement_index,
            subcircuit_id: query.subcircuit_id,
            local_wire_index: query.local_wire_index,
            point: query.point,
        }
    }
}

fn tagged_query_at(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
    trapdoor: &UnivariateTrapdoor,
) -> Result<ScalarField, UnivariateCrsError> {
    let [u, v, w] = arithmetic_wire_lifts_at(
        shape,
        setup,
        placement_index,
        subcircuit,
        local_wire_index,
        trapdoor.tau,
    )?;
    let b = connection_wire_lift_at(
        shape,
        setup,
        placement_index,
        subcircuit,
        local_wire_index,
        trapdoor.tau,
    )?;
    Ok(trapdoor.alpha * u
        + trapdoor.alpha.pow(2) * v
        + trapdoor.alpha.pow(3) * w
        + trapdoor.alpha.pow(4) * b)
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
        UnivariateCrs, UnivariateCrsError, UnivariateCrsFoundation, UnivariateCrsShape,
        UnivariateSubcircuit, UnivariateTrapdoor, UNIVARIATE_CRS_SCHEMA_ID,
    };
    use crate::crs_artifacts::{
        read_univariate_crs_artifact, write_univariate_crs_artifacts, UnivariateCrsRkyvExt,
        UNIVARIATE_CRS_JSON_FILE_NAME, UNIVARIATE_CRS_RKYV_FILE_NAME,
    };
    use crate::frontend_artifacts::public_wire_layout::{GlobalWire, PublicWireLayout};
    use crate::frontend_artifacts::{BufferDirection, SetupParams, SubcircuitInfo};
    use crate::group_structures::{G1serde, G2serde};
    use backend_interface::UnivariateCrsRkyv;
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
        assert!(matches!(
            error,
            UnivariateCrsError::TauInsideDomain {
                domain: "arithmetic"
            }
        ));
    }

    #[test]
    fn builds_the_complete_u20_and_u21_query_families_without_public_grid_expansion() {
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
        let infos = [SubcircuitInfo {
            id: 0,
            name: "public-buffer".to_string(),
            Nwires: 3,
            Nconsts: 0,
            Out_idx: Box::new([]),
            In_idx: Box::new([1, 1]),
            flattenMap: Box::new([2, 0, 1]),
            bufferDirection: Some(BufferDirection::In),
        }];
        let public_layout = PublicWireLayout::derive(
            &setup,
            &[
                GlobalWire::Mapped {
                    subcircuit_id: 0,
                    local_wire_index: 1,
                },
                GlobalWire::Mapped {
                    subcircuit_id: 0,
                    local_wire_index: 2,
                },
                GlobalWire::Mapped {
                    subcircuit_id: 0,
                    local_wire_index: 0,
                },
            ],
            &infos,
        )
        .expect("the fixed public buffer must define a compressed query key");
        let a_active_wires = [1usize];
        let b_active_wires = [1usize];
        let c_active_wires = [1usize];
        let a_rows = [vec![(0usize, ScalarField::one())]];
        let b_rows = [vec![(0usize, ScalarField::one())]];
        let c_rows = [vec![(0usize, ScalarField::one())]];
        let subcircuits = [UnivariateSubcircuit {
            id: 0,
            flatten_map: &infos[0].flattenMap,
            a_active_wires: &a_active_wires,
            b_active_wires: &b_active_wires,
            c_active_wires: &c_active_wires,
            a_rows: &a_rows,
            b_rows: &b_rows,
            c_rows: &c_rows,
        }];
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let trapdoor = test_trapdoor(&shape);
        let crs = UnivariateCrs::generate(
            &setup,
            &public_layout,
            &subcircuits,
            &trapdoor,
            CurveCfg::generate_random_affine_points(1)[0],
            G2CurveCfg::generate_random_affine_points(1)[0],
        )
        .expect("the complete univariate CRS must be constructible");

        // The sole public buffer contributes one reachable `(b, (b, j))`
        // query, not the generic two-placement public table.
        assert_eq!(crs.gamma_inv_public_queries.len(), 1);
        assert_eq!(crs.gamma_inv_public_queries[0].key.buffer_subcircuit_id, 0);
        assert_eq!(
            crs.gamma_inv_public_queries[0].key.local_public_wire_index,
            1
        );
        // The interface wire remains placement-indexed for both slots.
        assert_eq!(crs.eta_inv_interface_queries.len(), 2 * setup.s_max);
        assert!(crs.delta_inv_internal_queries.is_empty());
        assert_eq!(
            crs.delta_inv_arithmetic_masking_queries
                .iter()
                .map(|queries| queries.len())
                .collect::<Vec<_>>(),
            vec![2, 2, 2]
        );
        assert_eq!(crs.delta_inv_connection_masking_queries.len(), 2);
        let query_index = crs.query_index();
        assert_eq!(
            query_index.public_index(crs.gamma_inv_public_queries[0].key),
            Some(0)
        );
        assert_eq!(query_index.interface_index((1, 0, 0)), Some(2));
        assert_eq!(query_index.internal_index((0, 0, 0)), None);

        let output = tempfile::tempdir().expect("must create a temporary CRS output");
        let digests = write_univariate_crs_artifacts(output.path(), &crs)
            .expect("complete CRS projections must be writable");
        let rkyv = std::fs::read(output.path().join(UNIVARIATE_CRS_RKYV_FILE_NAME))
            .expect("must read the RKYV projection");
        rkyv::check_archived_root::<UnivariateCrsRkyv>(&rkyv)
            .expect("the RKYV projection must be structurally valid");
        let json: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output.path().join(UNIVARIATE_CRS_JSON_FILE_NAME))
                .expect("must read the JSON projection"),
        )
        .expect("the JSON projection must be valid");
        assert_eq!(json["schemaId"], UNIVARIATE_CRS_SCHEMA_ID);
        assert_eq!(digests.rkyv_sha256.len(), 64);
        assert_eq!(digests.json_sha256.len(), 64);
        let loaded = read_univariate_crs_artifact(
            &output.path().join(UNIVARIATE_CRS_RKYV_FILE_NAME),
            &setup,
            &public_layout,
            &subcircuits,
        )
        .expect("a matching univariate CRS archive must load");
        assert_eq!(loaded, crs);
        let mut archive = UnivariateCrsRkyv::from_univariate_crs(&crs);
        archive.eta_inv_interface_queries[0].placement_index = 1;
        let bytes = rkyv::to_bytes::<_, 256>(&archive).expect("archive must serialize");
        let path = output.path().join(UNIVARIATE_CRS_RKYV_FILE_NAME);
        std::fs::write(&path, bytes.as_ref()).expect("must write malformed CRS archive");

        let error = read_univariate_crs_artifact(&path, &setup, &public_layout, &subcircuits)
            .expect_err("the reader must reject an altered query label");
        assert!(error
            .to_string()
            .contains("interface-query range does not match"));
    }

    #[test]
    fn rejects_zero_sized_subcircuit_library() {
        let mut params = setup_params();
        params.s_D = 0;
        let error = UnivariateCrsShape::from_setup_params(&params)
            .expect_err("zero subcircuit count cannot define t");
        assert!(matches!(
            error,
            UnivariateCrsError::DomainTooSmall { name: "s_D" }
        ));
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
