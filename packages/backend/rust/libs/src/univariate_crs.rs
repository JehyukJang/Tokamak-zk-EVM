//! Construction primitives and in-memory representation for the univariate
//! U18--U21 CRS. Artifact projections and admission live in
//! `crate::crs_artifacts` so this module remains independent of filesystem and
//! archive concerns.

use crate::frontend_artifacts::public_wire_layout::{PublicQueryKey, PublicWireLayout};
use crate::frontend_artifacts::SetupParams;
use crate::group_structures::{G1serde, G2serde};
use crate::univariate_relation::{
    arithmetic_wire_lifts_at, connection_wire_lift_at, R1csMatrix, UnivariateRelationError,
    UnivariateSubcircuit,
};
#[cfg(not(test))]
use icicle_bls12_381::curve::{CurveCfg, G1Projective};
use icicle_bls12_381::curve::{G1Affine, G2Affine, ScalarCfg, ScalarField};
#[cfg(not(test))]
use icicle_core::ecntt::ecntt_inplace;
use icicle_core::ntt;
#[cfg(not(test))]
use icicle_core::ntt::{NTTConfig, NTTDir};
use icicle_core::traits::{Arithmetic, FieldImpl, GenerateRandom};
use icicle_runtime::errors::eIcicleError;
#[cfg(not(test))]
use icicle_runtime::memory::HostSlice;
use rayon::prelude::*;
use std::time::Instant;
use thiserror::Error;

/// The sole schema identifier for the new univariate artifact family.
/// Its public-query layout is fixed by resolved public-buffer metadata.
pub const UNIVARIATE_CRS_SCHEMA_ID: &str = "tokamak-zk-evm-univariate";

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
    #[error("failed to allocate {length} CRS powers")]
    PowerAllocation { length: usize },
    #[error("ICICLE ECNTT failed while deriving public query bases: {0:?}")]
    Ecntt(eIcicleError),
    #[error(
        "terminal tau sequence capacity {name}={available} is smaller than required {required}"
    )]
    InsufficientTauCapacity {
        name: &'static str,
        available: usize,
        required: usize,
    },
    #[error("polynomial commitment needs {actual} CRS powers, but the selected CRS sequence has {available}")]
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

/// Library-independent exponent bounds of the U22c terminal sequences.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UnivariateTauCapacity {
    pub l0: usize,
    pub l_xi: usize,
    pub l_psi: usize,
    pub l2: usize,
}

impl UnivariateTauCapacity {
    pub fn from_shape(shape: &UnivariateCrsShape) -> Self {
        Self {
            l0: shape.declared_capacity[0],
            l_xi: shape.declared_capacity[1],
            l_psi: shape.declared_capacity[2],
            l2: shape.k,
        }
    }

    pub fn admits(self, shape: &UnivariateCrsShape) -> Result<(), UnivariateCrsError> {
        for (name, available, required) in [
            ("L_0", self.l0, shape.declared_capacity[0]),
            ("L_xi", self.l_xi, shape.declared_capacity[1]),
            ("L_psi", self.l_psi, shape.declared_capacity[2]),
            ("L_2", self.l2, shape.k),
        ] {
            if available < required {
                return Err(UnivariateCrsError::InsufficientTauCapacity {
                    name,
                    available,
                    required,
                });
            }
        }
        Ok(())
    }
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
    /// The U18 minimum `(M_0, M_xi, M_psi)` capacity vector.
    pub minimum_capacity: [usize; 3],
    /// The declared CRS capacity. It may exceed `minimum_capacity` componentwise.
    pub declared_capacity: [usize; 3],
    /// `K = M_psi - d`, where `d = max(N_A + 1, N_C + 1)`.
    pub k: usize,
    pub arithmetic_root: ScalarField,
    pub connection_root: ScalarField,
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

        let d = arithmetic_domain_size
            .checked_add(1)
            .map(|arithmetic| arithmetic.max(connection_domain_size.saturating_add(1)))
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "d" })?;
        let minimum_capacity = [
            arithmetic_bound.max(connection_bound),
            arithmetic_domain_size
                .checked_add(1)
                .ok_or(UnivariateCrsError::CapacityOverflow { name: "N_A + 1" })?,
            d.checked_mul(2)
                .and_then(|value| value.checked_add(1))
                .ok_or(UnivariateCrsError::CapacityOverflow { name: "2d + 1" })?,
        ];
        let k = minimum_capacity[2]
            .checked_sub(d)
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "K" })?;

        Ok(Self {
            subcircuit_capacity,
            arithmetic_domain_size,
            connection_domain_size,
            intersection_domain_size,
            union_domain_size,
            minimum_capacity,
            declared_capacity: minimum_capacity,
            k,
            arithmetic_root: primitive_root("N_A", arithmetic_domain_size)?,
            connection_root: primitive_root("N_C", connection_domain_size)?,
        })
    }

    /// Uses a declared U18 capacity vector after checking the componentwise
    /// lower bound and the derived `K` relation. This deliberately admits
    /// larger reusable CRS artifacts.
    pub fn with_declared_capacity(
        mut self,
        declared_capacity: [usize; 3],
    ) -> Result<Self, UnivariateCrsError> {
        if declared_capacity
            .iter()
            .zip(self.minimum_capacity)
            .any(|(declared, minimum)| *declared < minimum)
        {
            return Err(UnivariateCrsError::CommitmentDegree {
                actual: self
                    .minimum_capacity
                    .iter()
                    .copied()
                    .max()
                    .unwrap_or_default(),
                available: declared_capacity.iter().copied().max().unwrap_or_default(),
            });
        }
        let d = self
            .arithmetic_domain_size
            .checked_add(1)
            .map(|arithmetic| arithmetic.max(self.connection_domain_size.saturating_add(1)))
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "d" })?;
        self.k = declared_capacity[2]
            .checked_sub(d)
            .ok_or(UnivariateCrsError::CapacityOverflow { name: "K" })?;
        self.declared_capacity = declared_capacity;
        Ok(self)
    }

    /// Returns whether this declared CRS shape can serve the selected setup.
    /// Domain geometry and the protocol minimum must agree exactly; only the
    /// three reusable source ranges may be larger than the minimum.
    pub fn admits_setup(&self, setup_shape: &Self) -> bool {
        self.subcircuit_capacity == setup_shape.subcircuit_capacity
            && self.arithmetic_domain_size == setup_shape.arithmetic_domain_size
            && self.connection_domain_size == setup_shape.connection_domain_size
            && self.intersection_domain_size == setup_shape.intersection_domain_size
            && self.union_domain_size == setup_shape.union_domain_size
            && self.minimum_capacity == setup_shape.minimum_capacity
            && self
                .declared_capacity
                .iter()
                .zip(setup_shape.minimum_capacity)
                .all(|(declared, minimum)| *declared >= minimum)
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
    xi: ScalarField,
    psi: ScalarField,
    gamma: ScalarField,
    eta: ScalarField,
    delta: ScalarField,
}

/// Role scalars generated only by library-specializing Phase 2.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateRoleTrapdoor {
    gamma: ScalarField,
    eta: ScalarField,
    delta: ScalarField,
}

impl UnivariateRoleTrapdoor {
    pub fn new(
        gamma: ScalarField,
        eta: ScalarField,
        delta: ScalarField,
    ) -> Result<Self, UnivariateCrsError> {
        for (name, value) in [("gamma", gamma), ("eta", eta), ("delta", delta)] {
            if value == ScalarField::zero() {
                return Err(UnivariateCrsError::ZeroTrapdoor { name });
            }
        }
        Ok(Self { gamma, eta, delta })
    }

    pub fn sample() -> Self {
        Self {
            gamma: nonzero_scalar(),
            eta: nonzero_scalar(),
            delta: nonzero_scalar(),
        }
    }
}

impl UnivariateTrapdoor {
    pub fn new(
        shape: &UnivariateCrsShape,
        tau: ScalarField,
        xi: ScalarField,
        psi: ScalarField,
        gamma: ScalarField,
        eta: ScalarField,
        delta: ScalarField,
    ) -> Result<Self, UnivariateCrsError> {
        for (name, value) in [
            ("tau", tau),
            ("xi", xi),
            ("psi", psi),
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
            xi,
            psi,
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
                nonzero_scalar(),
            ) {
                return Ok(trapdoor);
            }
        }
        Err(UnivariateCrsError::TauSamplingExhausted)
    }
}

/// The U18 source sequences carried by the complete in-memory CRS.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateCrsFoundation {
    pub schema_id: &'static str,
    pub shape: UnivariateCrsShape,
    pub s0_g1: Box<[G1serde]>,
    pub sxi_g1: Box<[G1serde]>,
    pub spsi_g1: Box<[G1serde]>,
    pub tau_powers_g2: Box<[G2serde]>,
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

/// U19 sequence selected by a commitment or opening source term.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnivariateCommitmentSource {
    S0,
    Sxi,
    Spsi,
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
    pub delta_inv_u_masking_queries: Box<[G1serde]>,
    pub delta_inv_v_masking_queries: Box<[G1serde]>,
    pub delta_inv_w_masking_queries: Box<[G1serde]>,
    pub delta_inv_b_masking_queries: Box<[G1serde]>,
    pub delta_g1: G1serde,
    pub eta_g1: G1serde,
}

/// Generic powers shared by preprocessing and proving. Their group elements
/// overlap algebraically with a reusable phase-1 tau sequence; no
/// circuit-specialized proving or verification key is stored here.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateTauSequence {
    pub schema_id: &'static str,
    pub capacity: UnivariateTauCapacity,
    pub s0_g1: Box<[G1serde]>,
    pub sxi_g1: Box<[G1serde]>,
    pub spsi_g1: Box<[G1serde]>,
    pub tau_powers_g2: Box<[G2serde]>,
}

/// Circuit-specialized keys consumed only by the prover. Group elements in
/// this structure are deliberately disjoint from `UnivariateTauSequence`.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateProverKeys {
    pub schema_id: &'static str,
    pub shape: UnivariateCrsShape,
    pub eta_inv_interface_queries: Box<[UnivariateTaggedQuery]>,
    pub delta_inv_internal_queries: Box<[UnivariateTaggedQuery]>,
    pub delta_inv_u_masking_queries: Box<[G1serde]>,
    pub delta_inv_v_masking_queries: Box<[G1serde]>,
    pub delta_inv_w_masking_queries: Box<[G1serde]>,
    pub delta_inv_b_masking_queries: Box<[G1serde]>,
    pub delta_g1: G1serde,
    pub eta_g1: G1serde,
}

/// The two files needed by proof generation, admitted as one typed input.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateProverCrs {
    pub tau_sequence: UnivariateTauSequence,
    pub prover_keys: UnivariateProverKeys,
}

/// Proof-verification material. Preprocess generation and admission use the
/// separate generic tau sequence instead of duplicating S0 here.
#[derive(Clone, Debug, PartialEq)]
pub struct UnivariateVerifierKeys {
    pub schema_id: &'static str,
    pub shape: UnivariateCrsShape,
    pub one_g1: G1serde,
    pub xi_g1: G1serde,
    pub psi_g1: G1serde,
    pub one_g2: G2serde,
    pub tau_g2: G2serde,
    pub tau_k_g2: G2serde,
    pub gamma_g2: G2serde,
    pub eta_g2: G2serde,
    pub delta_g2: G2serde,
    pub gamma_inv_public_queries: Box<[UnivariatePublicQuery]>,
}

impl UnivariateCrsFoundation {
    /// Generates U19's three source sequences and the U18 verifier basis.
    pub fn generate(
        shape: UnivariateCrsShape,
        trapdoor: &UnivariateTrapdoor,
        g1: G1Affine,
        g2: G2Affine,
    ) -> Result<Self, UnivariateCrsError> {
        let s0_g1 = generate_tagged_powers_parallel(
            "S0",
            shape.declared_capacity[0]
                .checked_add(1)
                .ok_or(UnivariateCrsError::CapacityOverflow { name: "M_0 + 1" })?,
            ScalarField::one(),
            trapdoor.tau,
            g1,
        )?;
        let sxi_g1 = generate_tagged_powers_parallel(
            "Sxi",
            shape.declared_capacity[1]
                .checked_add(1)
                .ok_or(UnivariateCrsError::CapacityOverflow { name: "M_xi + 1" })?,
            trapdoor.xi,
            trapdoor.tau,
            g1,
        )?;
        let spsi_g1 = generate_tagged_powers_parallel(
            "Spsi",
            shape.declared_capacity[2]
                .checked_add(1)
                .ok_or(UnivariateCrsError::CapacityOverflow { name: "M_psi + 1" })?,
            trapdoor.psi,
            trapdoor.tau,
            g1,
        )?;

        let (tau_powers_g2, (gamma_g2, (eta_g2, delta_g2))) = rayon::join(
            || generate_g2_powers_parallel(shape.k + 1, trapdoor.tau, g2),
            || {
                rayon::join(
                    || G2serde(G2Affine::from(g2.to_projective() * trapdoor.gamma)),
                    || {
                        rayon::join(
                            || G2serde(G2Affine::from(g2.to_projective() * trapdoor.eta)),
                            || G2serde(G2Affine::from(g2.to_projective() * trapdoor.delta)),
                        )
                    },
                )
            },
        );
        let tau_powers_g2 = tau_powers_g2?;
        Ok(Self {
            schema_id: UNIVARIATE_CRS_SCHEMA_ID,
            shape,
            s0_g1,
            sxi_g1,
            spsi_g1,
            tau_powers_g2,
            gamma_g2,
            eta_g2,
            delta_g2,
        })
    }
}

fn generate_g2_powers_parallel(
    length: usize,
    tau: ScalarField,
    g2: G2Affine,
) -> Result<Box<[G2serde]>, UnivariateCrsError> {
    let mut points = Vec::new();
    points
        .try_reserve_exact(length)
        .map_err(|_| UnivariateCrsError::PowerAllocation { length })?;
    points.resize(length, G2serde::zero());
    let target_chunks = rayon::current_num_threads()
        .saturating_mul(POWER_CHUNKS_PER_WORKER)
        .max(1);
    let chunk_size = length
        .div_ceil(target_chunks)
        .clamp(1, MAX_POWER_GENERATION_CHUNK_SIZE);
    points
        .par_chunks_mut(chunk_size)
        .enumerate()
        .for_each(|(chunk_index, chunk)| {
            let start = chunk_index * chunk_size;
            let mut tau_power = tau.pow(start);
            for point in chunk {
                *point = G2serde(G2Affine::from(g2.to_projective() * tau_power));
                tau_power = tau_power * tau;
            }
        });
    Ok(points.into_boxed_slice())
}

const MAX_POWER_GENERATION_CHUNK_SIZE: usize = 16_384;
const POWER_CHUNKS_PER_WORKER: usize = 4;

/// Generate independent single-point scalar multiplications in parallel.
/// This does not wrap a bulk ICICLE operation: the multiplication operator
/// computes one point and provides no cross-element parallelism of its own.
fn generate_tagged_powers_parallel(
    label: &str,
    length: usize,
    tag: ScalarField,
    tau: ScalarField,
    g1: G1Affine,
) -> Result<Box<[G1serde]>, UnivariateCrsError> {
    let started = Instant::now();
    let mut points = Vec::new();
    points
        .try_reserve_exact(length)
        .map_err(|_| UnivariateCrsError::PowerAllocation { length })?;
    points.resize(length, G1serde::zero());
    let tagged_generator = g1.to_projective() * tag;
    let target_chunks = rayon::current_num_threads()
        .saturating_mul(POWER_CHUNKS_PER_WORKER)
        .max(1);
    let chunk_size = length
        .div_ceil(target_chunks)
        .clamp(1, MAX_POWER_GENERATION_CHUNK_SIZE);
    points
        .par_chunks_mut(chunk_size)
        .enumerate()
        .for_each(|(chunk_index, chunk)| {
            let start = chunk_index * chunk_size;
            let mut tau_power = tau.pow(start);
            for point in chunk {
                *point = G1serde(G1Affine::from(tagged_generator * tau_power));
                tau_power = tau_power * tau;
            }
        });
    println!(
        "Generated {label} powers: {length} in {:.6} seconds",
        started.elapsed().as_secs_f64(),
    );
    Ok(points.into_boxed_slice())
}

fn generate_tagged_queries_parallel(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    descriptors: &[(&UnivariateSubcircuit<'_>, usize)],
    trapdoor: &UnivariateTrapdoor,
    base_g1: G1serde,
    inverse_tag: ScalarField,
) -> Result<Box<[UnivariateTaggedQuery]>, UnivariateCrsError> {
    if descriptors.is_empty() {
        return Ok(Vec::new().into_boxed_slice());
    }
    let query_count =
        setup
            .s_max
            .checked_mul(descriptors.len())
            .ok_or(UnivariateCrsError::CapacityOverflow {
                name: "specialized query count",
            })?;
    let queries = (0..query_count)
        .into_par_iter()
        .map(|query_index| {
            let placement_index = query_index / descriptors.len();
            let (subcircuit, local_wire_index) = descriptors[query_index % descriptors.len()];
            let query = tagged_query_at(
                shape,
                setup,
                placement_index,
                subcircuit,
                local_wire_index,
                trapdoor,
            )?;
            Ok(UnivariateTaggedQuery {
                placement_index,
                subcircuit_id: subcircuit.id,
                local_wire_index,
                point: base_g1 * (inverse_tag * query),
            })
        })
        .collect::<Result<Vec<_>, UnivariateCrsError>>()?;
    Ok(queries.into_boxed_slice())
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

        let foundation_started = Instant::now();
        let foundation = UnivariateCrsFoundation::generate(shape.clone(), trapdoor, g1, g2)?;
        println!(
            "Generated univariate CRS foundation in {:.6} seconds",
            foundation_started.elapsed().as_secs_f64(),
        );
        let base_g1 = foundation.s0_g1[0];
        let public_queries_started = Instant::now();
        let mut seen_public_keys = std::collections::HashSet::new();
        let public_query_keys = public_wire_layout.public_query_keys().collect::<Vec<_>>();
        for key in &public_query_keys {
            if !seen_public_keys.insert((key.buffer_subcircuit_id, key.local_public_wire_index)) {
                return Err(UnivariateCrsError::DuplicatePublicQueryKey {
                    subcircuit_id: key.buffer_subcircuit_id,
                    local_wire_index: key.local_public_wire_index,
                });
            }
        }
        let gamma_inverse = trapdoor.gamma.inv();
        let gamma_inv_public_queries = public_query_keys
            .par_iter()
            .map(|key| {
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
                Ok(UnivariatePublicQuery {
                    key: *key,
                    point: base_g1 * (gamma_inverse * query),
                })
            })
            .collect::<Result<Vec<_>, UnivariateCrsError>>()?;
        println!(
            "Generated {} public queries in {:.6} seconds",
            gamma_inv_public_queries.len(),
            public_queries_started.elapsed().as_secs_f64(),
        );

        let non_public_queries_started = Instant::now();
        let descriptor_groups = subcircuits
            .par_iter()
            .map(|subcircuit| {
                let mut interface = Vec::new();
                let mut internal = Vec::new();
                for (local_wire_index, global_wire_index) in
                    subcircuit.flatten_map.iter().copied().enumerate()
                {
                    if global_wire_index < setup.l {
                        continue;
                    }
                    if global_wire_index < setup.l_D {
                        interface.push((subcircuit, local_wire_index));
                    } else {
                        internal.push((subcircuit, local_wire_index));
                    }
                }
                (interface, internal)
            })
            .collect::<Vec<_>>();
        let mut interface_descriptors = Vec::new();
        let mut internal_descriptors = Vec::new();
        for (interface, internal) in descriptor_groups {
            interface_descriptors.extend(interface);
            internal_descriptors.extend(internal);
        }
        let (eta_inv_interface_queries, delta_inv_internal_queries) = rayon::join(
            || {
                generate_tagged_queries_parallel(
                    &shape,
                    setup,
                    &interface_descriptors,
                    trapdoor,
                    base_g1,
                    trapdoor.eta.inv(),
                )
            },
            || {
                generate_tagged_queries_parallel(
                    &shape,
                    setup,
                    &internal_descriptors,
                    trapdoor,
                    base_g1,
                    trapdoor.delta.inv(),
                )
            },
        );
        let eta_inv_interface_queries = eta_inv_interface_queries?;
        let delta_inv_internal_queries = delta_inv_internal_queries?;
        println!(
            "Generated {} interface and {} internal queries in {:.6} seconds",
            eta_inv_interface_queries.len(),
            delta_inv_internal_queries.len(),
            non_public_queries_started.elapsed().as_secs_f64(),
        );

        let masking_started = Instant::now();
        let z_a = trapdoor.tau.pow(shape.arithmetic_domain_size) - ScalarField::one();
        let z_c = trapdoor.tau.pow(shape.connection_domain_size) - ScalarField::one();
        let delta_inverse = trapdoor.delta.inv();
        let masking_range = |tag: ScalarField, offset: usize, z: ScalarField| {
            (0..2)
                .map(|h| base_g1 * (delta_inverse * tag * trapdoor.tau.pow(offset + h) * z))
                .collect::<Vec<_>>()
                .into_boxed_slice()
        };
        // U22 has two masks per polynomial. The B masks begin at K so their
        // basis is identical to U20's psi*tau^K B term.
        let (
            (delta_inv_u_masking_queries, delta_inv_v_masking_queries),
            (delta_inv_w_masking_queries, delta_inv_b_masking_queries),
        ) = rayon::join(
            || {
                rayon::join(
                    || masking_range(ScalarField::one(), 0, z_a),
                    || masking_range(trapdoor.xi, 0, z_a),
                )
            },
            || {
                rayon::join(
                    || masking_range(trapdoor.psi, 0, z_a),
                    || masking_range(trapdoor.psi, shape.k, z_c),
                )
            },
        );
        println!(
            "Generated univariate masking queries in {:.6} seconds",
            masking_started.elapsed().as_secs_f64(),
        );

        let (delta_g1, eta_g1) =
            rayon::join(|| base_g1 * trapdoor.delta, || base_g1 * trapdoor.eta);
        Ok(Self {
            foundation,
            gamma_inv_public_queries: gamma_inv_public_queries.into_boxed_slice(),
            eta_inv_interface_queries,
            delta_inv_internal_queries,
            delta_inv_u_masking_queries,
            delta_inv_v_masking_queries,
            delta_inv_w_masking_queries,
            delta_inv_b_masking_queries,
            delta_g1,
            eta_g1,
        })
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

    /// Commits a dense univariate polynomial with U19's ordinary `S_0`
    /// powers.  The temporary affine-base vector is bounded by the supplied
    /// polynomial, not by the complete CRS degree capacity.
    pub fn commit_dense_polynomial(
        &self,
        coefficients: &[ScalarField],
    ) -> Result<G1serde, UnivariateCrsError> {
        self.commit_indexed_coefficients(
            &self.foundation.s0_g1,
            coefficients.iter().copied().enumerate(),
        )
    }

    /// Commits a strided selector without expanding its zero coefficients.
    pub fn commit_strided_polynomial(
        &self,
        polynomial: &crate::univariate_relation::StridedPolynomial,
    ) -> Result<G1serde, UnivariateCrsError> {
        self.commit_indexed_coefficients(
            &self.foundation.s0_g1,
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

    pub fn commit_tagged_dense_polynomial(
        &self,
        source: UnivariateCommitmentSource,
        coefficients: &[ScalarField],
        offset: usize,
    ) -> Result<G1serde, UnivariateCrsError> {
        let sequence = match source {
            UnivariateCommitmentSource::S0 => &self.foundation.s0_g1,
            UnivariateCommitmentSource::Sxi => &self.foundation.sxi_g1,
            UnivariateCommitmentSource::Spsi => &self.foundation.spsi_g1,
        };
        let indexed = coefficients
            .iter()
            .copied()
            .enumerate()
            .map(|(index, value)| {
                index
                    .checked_add(offset)
                    .ok_or(UnivariateCrsError::CapacityOverflow {
                        name: "tagged commitment index",
                    })
                    .map(|power| (power, value))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.commit_indexed_coefficients(sequence, indexed)
    }

    fn commit_indexed_coefficients(
        &self,
        sequence: &[G1serde],
        coefficients: impl IntoIterator<Item = (usize, ScalarField)>,
    ) -> Result<G1serde, UnivariateCrsError> {
        let pairs = coefficients.into_iter().collect::<Vec<_>>();
        let available = sequence.len();
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
            .map(|(power, _)| sequence[*power].0)
            .collect::<Vec<_>>();
        Ok(crate::group_structures::msm_g1_bases(&scalars, &bases))
    }
}

impl UnivariateTauSequence {
    /// Generates the library-independent U22c terminal families. No
    /// subcircuit-library shape is consulted during this phase.
    pub fn generate(
        capacity: UnivariateTauCapacity,
        tau: ScalarField,
        xi: ScalarField,
        psi: ScalarField,
        g1: G1Affine,
        g2: G2Affine,
    ) -> Result<Self, UnivariateCrsError> {
        for (name, value) in [("tau", tau), ("xi", xi), ("psi", psi)] {
            if value == ScalarField::zero() {
                return Err(UnivariateCrsError::ZeroTrapdoor { name });
            }
        }
        let ((s0_g1, sxi_g1), (spsi_g1, tau_powers_g2)) = rayon::join(
            || {
                rayon::join(
                    || {
                        generate_tagged_powers_parallel(
                            "P0",
                            capacity.l0 + 1,
                            ScalarField::one(),
                            tau,
                            g1,
                        )
                    },
                    || generate_tagged_powers_parallel("Pxi", capacity.l_xi + 1, xi, tau, g1),
                )
            },
            || {
                rayon::join(
                    || generate_tagged_powers_parallel("Ppsi", capacity.l_psi + 1, psi, tau, g1),
                    || generate_g2_powers_parallel(capacity.l2 + 1, tau, g2),
                )
            },
        );
        Ok(Self {
            schema_id: UNIVARIATE_CRS_SCHEMA_ID,
            capacity,
            s0_g1: s0_g1?,
            sxi_g1: sxi_g1?,
            spsi_g1: spsi_g1?,
            tau_powers_g2: tau_powers_g2?,
        })
    }

    pub fn admits_shape(&self, shape: &UnivariateCrsShape) -> Result<(), UnivariateCrsError> {
        self.capacity.admits(shape)?;
        let one_g2 =
            self.tau_powers_g2
                .first()
                .ok_or(UnivariateCrsError::InsufficientTauCapacity {
                    name: "L_2",
                    available: 0,
                    required: 1,
                })?;
        if self.tau_powers_g2[shape.arithmetic_domain_size] == *one_g2 {
            return Err(UnivariateCrsError::TauInsideDomain {
                domain: "arithmetic",
            });
        }
        if self.tau_powers_g2[shape.connection_domain_size] == *one_g2 {
            return Err(UnivariateCrsError::TauInsideDomain {
                domain: "connection",
            });
        }
        Ok(())
    }

    pub fn commit_dense_polynomial(
        &self,
        coefficients: &[ScalarField],
    ) -> Result<G1serde, UnivariateCrsError> {
        commit_indexed_coefficients(&self.s0_g1, coefficients.iter().copied().enumerate())
    }

    pub fn commit_strided_polynomial(
        &self,
        polynomial: &crate::univariate_relation::StridedPolynomial,
    ) -> Result<G1serde, UnivariateCrsError> {
        commit_indexed_coefficients(
            &self.s0_g1,
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
                .collect::<Result<Vec<_>, _>>()?,
        )
    }

    pub fn commit_tagged_dense_polynomial(
        &self,
        source: UnivariateCommitmentSource,
        coefficients: &[ScalarField],
        offset: usize,
    ) -> Result<G1serde, UnivariateCrsError> {
        let sequence = match source {
            UnivariateCommitmentSource::S0 => &self.s0_g1,
            UnivariateCommitmentSource::Sxi => &self.sxi_g1,
            UnivariateCommitmentSource::Spsi => &self.spsi_g1,
        };
        let indexed = coefficients
            .iter()
            .copied()
            .enumerate()
            .map(|(index, value)| {
                index
                    .checked_add(offset)
                    .ok_or(UnivariateCrsError::CapacityOverflow {
                        name: "tagged commitment index",
                    })
                    .map(|power| (power, value))
            })
            .collect::<Result<Vec<_>, _>>()?;
        commit_indexed_coefficients(sequence, indexed)
    }
}

impl UnivariateProverCrs {
    pub fn query_index(&self) -> UnivariateQueryIndex {
        UnivariateQueryIndex {
            public: std::collections::HashMap::new(),
            interface: self
                .prover_keys
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
                .prover_keys
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

    pub fn commit_tagged_dense_polynomial(
        &self,
        source: UnivariateCommitmentSource,
        coefficients: &[ScalarField],
        offset: usize,
    ) -> Result<G1serde, UnivariateCrsError> {
        self.tau_sequence
            .commit_tagged_dense_polynomial(source, coefficients, offset)
    }
}

/// Specializes one persisted U22c terminal output for a fixed library without
/// access to the Phase 1 trapdoor scalars.
pub fn specialize_univariate_keys(
    setup: &SetupParams,
    public_wire_layout: &PublicWireLayout,
    subcircuits: &[UnivariateSubcircuit<'_>],
    tau_sequence: &UnivariateTauSequence,
    role_trapdoor: &UnivariateRoleTrapdoor,
) -> Result<(UnivariateProverKeys, UnivariateVerifierKeys), UnivariateCrsError> {
    let shape = UnivariateCrsShape::from_setup_params(setup)?;
    tau_sequence.admits_shape(&shape)?;
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

    let bases = QueryCommitmentBases::new(tau_sequence, &shape)?;
    let base_g1 = tau_sequence.s0_g1[0];
    let gamma_inverse = role_trapdoor.gamma.inv();
    let public_keys = public_wire_layout.public_query_keys().collect::<Vec<_>>();
    let gamma_inv_public_queries = public_keys
        .par_iter()
        .map(|key| {
            let subcircuit = subcircuits
                .get(key.buffer_subcircuit_id)
                .filter(|subcircuit| key.local_public_wire_index < subcircuit.flatten_map.len())
                .ok_or(UnivariateCrsError::InvalidPublicQueryKey {
                    subcircuit_id: key.buffer_subcircuit_id,
                    local_wire_index: key.local_public_wire_index,
                })?;
            Ok(UnivariatePublicQuery {
                key: *key,
                point: bases.query_at(
                    &shape,
                    setup,
                    key.buffer_subcircuit_id,
                    subcircuit,
                    key.local_public_wire_index,
                )? * gamma_inverse,
            })
        })
        .collect::<Result<Vec<_>, UnivariateCrsError>>()?;

    let descriptor_groups = subcircuits
        .par_iter()
        .map(|subcircuit| {
            let mut interface = Vec::new();
            let mut internal = Vec::new();
            for (local_wire_index, global_wire_index) in
                subcircuit.flatten_map.iter().copied().enumerate()
            {
                if global_wire_index < setup.l {
                    continue;
                }
                if global_wire_index < setup.l_D {
                    interface.push((subcircuit, local_wire_index));
                } else {
                    internal.push((subcircuit, local_wire_index));
                }
            }
            (interface, internal)
        })
        .collect::<Vec<_>>();
    let mut interface_descriptors = Vec::new();
    let mut internal_descriptors = Vec::new();
    for (interface, internal) in descriptor_groups {
        interface_descriptors.extend(interface);
        internal_descriptors.extend(internal);
    }
    let generate_queries = |descriptors: &[(&UnivariateSubcircuit<'_>, usize)],
                            inverse: ScalarField| {
        let query_count = setup.s_max.checked_mul(descriptors.len()).ok_or(
            UnivariateCrsError::CapacityOverflow {
                name: "specialized query count",
            },
        )?;
        (0..query_count)
            .into_par_iter()
            .map(|query_index| {
                let placement_index = query_index / descriptors.len();
                let (subcircuit, local_wire_index) = descriptors[query_index % descriptors.len()];
                Ok(UnivariateTaggedQuery {
                    placement_index,
                    subcircuit_id: subcircuit.id,
                    local_wire_index,
                    point: bases.query_at(
                        &shape,
                        setup,
                        placement_index,
                        subcircuit,
                        local_wire_index,
                    )? * inverse,
                })
            })
            .collect::<Result<Vec<_>, UnivariateCrsError>>()
            .map(Vec::into_boxed_slice)
    };
    let (eta_inv_interface_queries, delta_inv_internal_queries) = rayon::join(
        || generate_queries(&interface_descriptors, role_trapdoor.eta.inv()),
        || generate_queries(&internal_descriptors, role_trapdoor.delta.inv()),
    );

    let delta_inverse = role_trapdoor.delta.inv();
    let masking_pair = |sequence: &[G1serde], offset: usize, domain_size: usize| {
        (0..2)
            .map(|h| (sequence[offset + h + domain_size] - sequence[offset + h]) * delta_inverse)
            .collect::<Vec<_>>()
            .into_boxed_slice()
    };
    let prover = UnivariateProverKeys {
        schema_id: UNIVARIATE_CRS_SCHEMA_ID,
        shape: shape.clone(),
        eta_inv_interface_queries: eta_inv_interface_queries?,
        delta_inv_internal_queries: delta_inv_internal_queries?,
        delta_inv_u_masking_queries: masking_pair(
            &tau_sequence.s0_g1,
            0,
            shape.arithmetic_domain_size,
        ),
        delta_inv_v_masking_queries: masking_pair(
            &tau_sequence.sxi_g1,
            0,
            shape.arithmetic_domain_size,
        ),
        delta_inv_w_masking_queries: masking_pair(
            &tau_sequence.spsi_g1,
            0,
            shape.arithmetic_domain_size,
        ),
        delta_inv_b_masking_queries: masking_pair(
            &tau_sequence.spsi_g1,
            shape.k,
            shape.connection_domain_size,
        ),
        delta_g1: base_g1 * role_trapdoor.delta,
        eta_g1: base_g1 * role_trapdoor.eta,
    };
    let verifier = UnivariateVerifierKeys {
        schema_id: UNIVARIATE_CRS_SCHEMA_ID,
        shape: shape.clone(),
        one_g1: tau_sequence.s0_g1[0],
        xi_g1: tau_sequence.sxi_g1[0],
        psi_g1: tau_sequence.spsi_g1[0],
        one_g2: tau_sequence.tau_powers_g2[0],
        tau_g2: tau_sequence.tau_powers_g2[1],
        tau_k_g2: tau_sequence.tau_powers_g2[shape.k],
        gamma_g2: tau_sequence.tau_powers_g2[0] * role_trapdoor.gamma,
        eta_g2: tau_sequence.tau_powers_g2[0] * role_trapdoor.eta,
        delta_g2: tau_sequence.tau_powers_g2[0] * role_trapdoor.delta,
        gamma_inv_public_queries: gamma_inv_public_queries.into_boxed_slice(),
    };
    Ok((prover, verifier))
}

struct QueryCommitmentBases {
    u: Box<[G1serde]>,
    v: Box<[G1serde]>,
    w: Box<[G1serde]>,
    b: Box<[G1serde]>,
}

fn lagrange_basis_commitments(
    monomial_powers: &[G1serde],
    root: ScalarField,
) -> Result<Box<[G1serde]>, UnivariateCrsError> {
    #[cfg(not(test))]
    {
        let _ = root;
        crate::ntt_domain::init_ntt_domain_for_size(monomial_powers.len())
            .map_err(UnivariateCrsError::Ecntt)?;
        let mut points = monomial_powers
            .iter()
            .map(|point| point.0.to_projective())
            .collect::<Vec<G1Projective>>();
        ecntt_inplace::<CurveCfg>(
            HostSlice::from_mut_slice(&mut points),
            NTTDir::kInverse,
            &NTTConfig::default(),
        )
        .map_err(UnivariateCrsError::Ecntt)?;
        return Ok(points
            .into_iter()
            .map(|point| G1serde(G1Affine::from(point)))
            .collect::<Vec<_>>()
            .into_boxed_slice());
    }

    #[cfg(test)]
    {
        let domain_size = monomial_powers.len();
        let scale = ScalarField::from_u32(u32::try_from(domain_size).map_err(|_| {
            UnivariateCrsError::DomainTooLarge {
                name: "Lagrange commitment domain",
            }
        })?)
        .inv();
        let mut result = Vec::with_capacity(domain_size);
        for evaluation_index in 0..domain_size {
            let mut point = G1serde::zero();
            for (power, monomial) in monomial_powers.iter().enumerate() {
                point = point + *monomial * (root.pow(evaluation_index).inv().pow(power) * scale);
            }
            result.push(point);
        }
        Ok(result.into_boxed_slice())
    }
}

fn arithmetic_wire_commitment(
    lagrange: &[G1serde],
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
    matrix: R1csMatrix,
) -> Result<G1serde, UnivariateCrsError> {
    if local_wire_index >= subcircuit.flatten_map.len() {
        return Err(UnivariateCrsError::Relation(
            UnivariateRelationError::LocalWireIndex {
                subcircuit_id: subcircuit.id,
                wire_index: local_wire_index,
            },
        ));
    }
    let (active_wires, rows) = match matrix {
        R1csMatrix::A => (subcircuit.a_active_wires, subcircuit.a_rows),
        R1csMatrix::B => (subcircuit.b_active_wires, subcircuit.b_rows),
        R1csMatrix::C => (subcircuit.c_active_wires, subcircuit.c_rows),
    };
    let mut commitment = G1serde::zero();
    for (row_index, row) in rows.iter().enumerate() {
        let mut coefficient = ScalarField::zero();
        for (compact_index, value) in row {
            let active_wire = active_wires.get(*compact_index).ok_or_else(|| {
                UnivariateCrsError::Relation(UnivariateRelationError::LocalWireIndex {
                    subcircuit_id: subcircuit.id,
                    wire_index: *compact_index,
                })
            })?;
            if *active_wire == local_wire_index {
                coefficient = coefficient + *value;
            }
        }
        if coefficient != ScalarField::zero() {
            let index = shape.arithmetic_index(placement_index, subcircuit.id, row_index, setup)?;
            commitment = commitment + lagrange[index] * coefficient;
        }
    }
    Ok(commitment)
}

fn connection_wire_commitment(
    lagrange: &[G1serde],
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
) -> Result<G1serde, UnivariateCrsError> {
    let global_index = *subcircuit
        .flatten_map
        .get(local_wire_index)
        .ok_or_else(|| {
            UnivariateCrsError::Relation(UnivariateRelationError::LocalWireIndex {
                subcircuit_id: subcircuit.id,
                wire_index: local_wire_index,
            })
        })?;
    if global_index < setup.l || global_index >= setup.l_D {
        return Ok(G1serde::zero());
    }
    let index = shape.connection_index(placement_index, global_index - setup.l, setup)?;
    Ok(lagrange[index])
}

impl QueryCommitmentBases {
    fn new(
        sequence: &UnivariateTauSequence,
        shape: &UnivariateCrsShape,
    ) -> Result<Self, UnivariateCrsError> {
        Ok(Self {
            u: lagrange_basis_commitments(
                &sequence.s0_g1[..shape.arithmetic_domain_size],
                shape.arithmetic_root,
            )?,
            v: lagrange_basis_commitments(
                &sequence.sxi_g1[..shape.arithmetic_domain_size],
                shape.arithmetic_root,
            )?,
            w: lagrange_basis_commitments(
                &sequence.spsi_g1[..shape.arithmetic_domain_size],
                shape.arithmetic_root,
            )?,
            b: lagrange_basis_commitments(
                &sequence.spsi_g1[shape.k..shape.k + shape.connection_domain_size],
                shape.connection_root,
            )?,
        })
    }

    fn query_at(
        &self,
        shape: &UnivariateCrsShape,
        setup: &SetupParams,
        placement_index: usize,
        subcircuit: &UnivariateSubcircuit<'_>,
        local_wire_index: usize,
    ) -> Result<G1serde, UnivariateCrsError> {
        let u = arithmetic_wire_commitment(
            &self.u,
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
            R1csMatrix::A,
        )?;
        let v = arithmetic_wire_commitment(
            &self.v,
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
            R1csMatrix::B,
        )?;
        let w = arithmetic_wire_commitment(
            &self.w,
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
            R1csMatrix::C,
        )?;
        let b = connection_wire_commitment(
            &self.b,
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
        )?;
        Ok(u + v + w + b)
    }
}

impl UnivariateVerifierKeys {
    pub fn query_index(&self) -> UnivariateQueryIndex {
        UnivariateQueryIndex {
            public: self
                .gamma_inv_public_queries
                .iter()
                .enumerate()
                .map(|(index, query)| (query.key, index))
                .collect(),
            interface: std::collections::HashMap::new(),
            internal: std::collections::HashMap::new(),
        }
    }
}

fn commit_indexed_coefficients(
    sequence: &[G1serde],
    coefficients: impl IntoIterator<Item = (usize, ScalarField)>,
) -> Result<G1serde, UnivariateCrsError> {
    let pairs = coefficients.into_iter().collect::<Vec<_>>();
    let available = sequence.len();
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
        .map(|(power, _)| sequence[*power].0)
        .collect::<Vec<_>>();
    Ok(crate::group_structures::msm_g1_bases(&scalars, &bases))
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
    Ok(u + trapdoor.xi * v + trapdoor.psi * w + trapdoor.psi * trapdoor.tau.pow(shape.k) * b)
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
        generate_tagged_powers_parallel, specialize_univariate_keys, UnivariateCrs,
        UnivariateCrsError, UnivariateCrsFoundation, UnivariateCrsShape, UnivariateRoleTrapdoor,
        UnivariateSubcircuit, UnivariateTauCapacity, UnivariateTauSequence, UnivariateTrapdoor,
        UNIVARIATE_CRS_SCHEMA_ID,
    };
    use crate::crs_artifacts::{
        read_univariate_prover_crs, read_univariate_tau_sequence, read_univariate_verifier_keys,
        write_univariate_crs_artifacts, UnivariateBoundCrsRkyvExt, PROVER_KEYS_RKYV_FILE_NAME,
        TAU_SEQUENCE_RKYV_FILE_NAME,
    };
    use crate::frontend_artifacts::public_wire_layout::{GlobalWire, PublicWireLayout};
    use crate::frontend_artifacts::{BufferDirection, SetupParams, SubcircuitInfo};
    use crate::group_structures::{G1serde, G2serde};
    use backend_interface::UnivariateProverKeysRkyv;
    use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg, ScalarField};
    use icicle_core::curve::Curve;
    use icicle_core::traits::{Arithmetic, FieldImpl};
    use serde::Deserialize;
    use sha2::Digest;

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
            ScalarField::from_u32(13),
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
        assert_eq!(shape.minimum_capacity, [32, 17, 35]);
        assert_eq!(shape.declared_capacity, [32, 17, 35]);
        assert_eq!(shape.k, 18);

        let g1 = CurveCfg::generate_random_affine_points(1)[0];
        let g2 = G2CurveCfg::generate_random_affine_points(1)[0];
        let trapdoor = test_trapdoor(&shape);
        let foundation = UnivariateCrsFoundation::generate(shape.clone(), &trapdoor, g1, g2)
            .expect("U18 basis generation must succeed");

        assert_eq!(foundation.schema_id, UNIVARIATE_CRS_SCHEMA_ID);
        assert_eq!(foundation.s0_g1.len(), 33);
        assert_eq!(foundation.sxi_g1.len(), 18);
        assert_eq!(foundation.spsi_g1.len(), 36);
        assert_eq!(foundation.s0_g1[0], G1serde(g1));
        assert_eq!(foundation.s0_g1[3], foundation.s0_g1[2] * trapdoor.tau);
        assert_eq!(foundation.tau_powers_g2[0], G2serde(g2));
        assert_eq!(
            foundation.tau_powers_g2[1],
            foundation.tau_powers_g2[0] * trapdoor.tau
        );
        assert_eq!(
            foundation.tau_powers_g2[shape.k],
            foundation.tau_powers_g2[0] * trapdoor.tau.pow(shape.k)
        );
    }

    #[test]
    fn parallel_power_generation_is_independent_of_worker_count() {
        let g1 = CurveCfg::generate_random_affine_points(1)[0];
        let tau = ScalarField::from_u32(17);
        let tag = ScalarField::from_u32(19);
        // Fixed worker counts belong only to this determinism test. Production
        // always uses Rayon's process-global, host-adaptive worker pool.
        let generate = |threads| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .expect("test Rayon pool must be constructible")
                .install(|| {
                    generate_tagged_powers_parallel("test", 16_385, tag, tau, g1)
                        .expect("parallel power generation must succeed")
                })
        };

        assert_eq!(generate(1), generate(4));
    }

    #[test]
    fn admits_a_larger_declared_capacity_without_changing_domain_geometry() {
        let minimum = UnivariateCrsShape::from_setup_params(&setup_params()).unwrap();
        let larger = minimum
            .clone()
            .with_declared_capacity([48, 24, 48])
            .expect("componentwise larger capacities must be admitted");
        assert!(larger.admits_setup(&minimum));
        assert_eq!(larger.k, 31);
        let too_small = minimum.clone().with_declared_capacity([31, 17, 35]);
        assert!(too_small.is_err());
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
            ScalarField::from_u32(13),
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
        let g1 = CurveCfg::generate_random_affine_points(1)[0];
        let g2 = G2CurveCfg::generate_random_affine_points(1)[0];
        let crs = UnivariateCrs::generate(&setup, &public_layout, &subcircuits, &trapdoor, g1, g2)
            .expect("the complete univariate CRS must be constructible");
        let sequence = UnivariateTauSequence::generate(
            UnivariateTauCapacity::from_shape(&shape),
            trapdoor.tau,
            trapdoor.xi,
            trapdoor.psi,
            g1,
            g2,
        )
        .expect("Phase 1 must generate the same terminal sequences");
        let role =
            UnivariateRoleTrapdoor::new(trapdoor.gamma, trapdoor.eta, trapdoor.delta).unwrap();
        let (specialized_prover, specialized_verifier) =
            specialize_univariate_keys(&setup, &public_layout, &subcircuits, &sequence, &role)
                .expect("Phase 2 must specialize persisted terminal sequences");
        assert_eq!(
            specialized_prover.eta_inv_interface_queries,
            crs.eta_inv_interface_queries
        );
        assert_eq!(
            specialized_prover.delta_inv_internal_queries,
            crs.delta_inv_internal_queries
        );
        assert_eq!(
            specialized_verifier.gamma_inv_public_queries,
            crs.gamma_inv_public_queries
        );

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
        assert_eq!(crs.delta_inv_u_masking_queries.len(), 2);
        assert_eq!(crs.delta_inv_v_masking_queries.len(), 2);
        assert_eq!(crs.delta_inv_w_masking_queries.len(), 2);
        assert_eq!(crs.delta_inv_b_masking_queries.len(), 2);
        let query_index = crs.query_index();
        assert_eq!(
            query_index.public_index(crs.gamma_inv_public_queries[0].key),
            Some(0)
        );
        assert_eq!(query_index.interface_index((1, 0, 0)), Some(2));
        assert_eq!(query_index.internal_index((0, 0, 0)), None);

        let output = tempfile::tempdir().expect("must create a temporary CRS output");
        std::fs::write(output.path().join("univariate_crs.json"), b"retired")
            .expect("must stage a retired JSON projection");
        let digests = write_univariate_crs_artifacts(output.path(), &crs)
            .expect("the complete CRS archive must be writable");
        assert!(!output.path().join("univariate_crs.json").exists());
        assert!(!output.path().join("univariate_crs.rkyv").exists());
        for digest in [
            &digests.tau_sequence_sha256,
            &digests.prover_keys_sha256,
            &digests.verifier_keys_sha256,
        ] {
            assert_eq!(digest.len(), 64);
        }
        let tau = read_univariate_tau_sequence(&output.path().join(TAU_SEQUENCE_RKYV_FILE_NAME))
            .expect("a matching tau sequence must load");
        assert_eq!(tau.s0_g1, crs.foundation.s0_g1);
        let prover = read_univariate_prover_crs(
            &output.path().join(TAU_SEQUENCE_RKYV_FILE_NAME),
            output.path(),
            &setup,
            &subcircuits,
        )
        .expect("matching prover material must load");
        assert_eq!(
            prover.prover_keys.eta_inv_interface_queries,
            crs.eta_inv_interface_queries
        );
        let tau_bytes = std::fs::read(output.path().join(TAU_SEQUENCE_RKYV_FILE_NAME)).unwrap();
        let tau_digest = sha2::Sha256::digest(tau_bytes).into();
        let verifier =
            read_univariate_verifier_keys(output.path(), &setup, &public_layout, tau_digest)
                .expect("matching verifier material must load");
        assert_eq!(
            verifier.gamma_inv_public_queries,
            crs.gamma_inv_public_queries
        );

        let path = output.path().join(PROVER_KEYS_RKYV_FILE_NAME);
        let mut archive = UnivariateProverKeysRkyv::from_univariate_crs(&crs, [9; 32]);
        let bytes = backend_univariate_crs_interface::archive::to_bytes::<
            backend_univariate_crs_interface::archive::rancor::Error,
        >(&archive)
        .expect("archive must serialize");
        std::fs::write(&path, bytes.as_ref()).expect("must write mismatched prover keys");
        let error = read_univariate_prover_crs(
            &output.path().join(TAU_SEQUENCE_RKYV_FILE_NAME),
            output.path(),
            &setup,
            &subcircuits,
        )
        .expect_err("the reader must reject prover keys bound to another tau sequence");
        assert!(error
            .to_string()
            .contains("prover keys belong to a different tau sequence"));

        archive.tau_sequence_sha256 = tau_digest;
        archive.eta_inv_interface_queries[0].placement_index = 1;
        let bytes = backend_univariate_crs_interface::archive::to_bytes::<
            backend_univariate_crs_interface::archive::rancor::Error,
        >(&archive)
        .expect("archive must serialize");
        std::fs::write(&path, bytes.as_ref()).expect("must write malformed CRS archive");

        let error = read_univariate_prover_crs(
            &output.path().join(TAU_SEQUENCE_RKYV_FILE_NAME),
            output.path(),
            &setup,
            &subcircuits,
        )
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
            assert_eq!(shape.minimum_capacity[0], case.expected.d);
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
