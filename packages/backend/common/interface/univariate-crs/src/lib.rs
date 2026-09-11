//! 64-bit RKYV schemas for the role-separated univariate CRS archives.
//!
//! This crate is isolated from the 32-bit RKYV schema used by the existing MPC
//! artifacts. Production univariate CRS files exceed the offset range of
//! RKYV's default 32-bit relative pointers.

#![deny(unsafe_code)]

pub use rkyv as archive;

mod nonpublic_queries;
pub use nonpublic_queries::NonpublicQueryLayout;

/// Current U19 source families. Sequence lengths determine their exponent bounds.
#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct TauSequenceRkyv {
    pub schema_id: String,
    pub s0_g1: Vec<UnivariateG1Rkyv>,
    pub sxi_g1: Vec<UnivariateG1Rkyv>,
    pub spsi_g1: Vec<UnivariateG1Rkyv>,
    pub tau_powers_g2: Vec<UnivariateG2Rkyv>,
    pub psi_g2: UnivariateG2Rkyv,
}

/// Query order is defined by the backend-owned CRS contract and library maps.
/// No point descriptors, positive delta role, or fixed-public scaled aliases.
#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct ProverKeysRkyv {
    pub schema_id: String,
    pub weighted_g1: Vec<UnivariateG1Rkyv>,
    pub weighted_shifted_g1: Vec<UnivariateG1Rkyv>,
    pub free_public_queries: Vec<UnivariateG1Rkyv>,
    /// Lexicographic (placement, compiled circuit, actual local wire), excluding
    /// public wires. Virtual IDs and local-capacity padding have no stored slot.
    /// NonpublicQueryLayout derives ranges from the selected library's maps.
    pub nonpublic_queries: Vec<UnivariateG1Rkyv>,
    pub mask_u: [UnivariateG1Rkyv; 2],
    pub mask_v: [UnivariateG1Rkyv; 2],
    pub mask_w: [UnivariateG1Rkyv; 2],
    pub mask_b: [UnivariateG1Rkyv; 2],
    pub mask_selection: UnivariateG1Rkyv,
}

/// Self-contained bases for S_C, E_kappa and C_fix, not their encoded outputs.
#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct PreprocessKeysRkyv {
    pub schema_id: String,
    pub sc_g1: Vec<UnivariateG1Rkyv>,
    pub selection_g2: Vec<UnivariateG2Rkyv>,
    pub fixed_public_queries: Vec<UnivariateG1Rkyv>,
}

/// Online pairing operands only. Preprocess bases belong to PreprocessKeysRkyv.
#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct VerifierKeysRkyv {
    pub schema_id: String,
    pub one_g1: UnivariateG1Rkyv,
    pub xi_g1: UnivariateG1Rkyv,
    pub psi_g1: UnivariateG1Rkyv,
    pub one_g2: UnivariateG2Rkyv,
    pub tau_g2: UnivariateG2Rkyv,
    pub tau_k_g2: UnivariateG2Rkyv,
    pub delta_g2: UnivariateG2Rkyv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateG1Rkyv {
    pub x: [u8; 48],
    pub y: [u8; 48],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateG2Rkyv {
    pub x: [u8; 96],
    pub y: [u8; 96],
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateTauSequenceRkyv {
    pub schema_id: String,
    pub capacity: UnivariateTauCapacityRkyv,
    pub s0_g1: Vec<UnivariateG1Rkyv>,
    pub sxi_g1: Vec<UnivariateG1Rkyv>,
    pub spsi_g1: Vec<UnivariateG1Rkyv>,
    pub tau_powers_g2: Vec<UnivariateG2Rkyv>,
}

/// Terminal U22c capacities. These values are independent of any selected
/// subcircuit library; Phase 2 checks them against its derived U18 shape.
#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateTauCapacityRkyv {
    pub l0: u64,
    pub l_xi: u64,
    pub l_psi: u64,
    pub l2: u64,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateProverKeysRkyv {
    pub schema_id: String,
    pub shape: UnivariateCrsShapeRkyv,
    pub tau_sequence_sha256: [u8; 32],
    pub eta_inv_interface_queries: Vec<UnivariateTaggedQueryRkyv>,
    pub delta_inv_internal_queries: Vec<UnivariateTaggedQueryRkyv>,
    pub delta_inv_u_masking_queries: Vec<UnivariateG1Rkyv>,
    pub delta_inv_v_masking_queries: Vec<UnivariateG1Rkyv>,
    pub delta_inv_w_masking_queries: Vec<UnivariateG1Rkyv>,
    pub delta_inv_b_masking_queries: Vec<UnivariateG1Rkyv>,
    pub delta_g1: UnivariateG1Rkyv,
    pub eta_g1: UnivariateG1Rkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateVerifierKeysRkyv {
    pub schema_id: String,
    pub shape: UnivariateCrsShapeRkyv,
    pub tau_sequence_sha256: [u8; 32],
    pub one_g1: UnivariateG1Rkyv,
    pub xi_g1: UnivariateG1Rkyv,
    pub psi_g1: UnivariateG1Rkyv,
    pub gamma_g2: UnivariateG2Rkyv,
    pub eta_g2: UnivariateG2Rkyv,
    pub delta_g2: UnivariateG2Rkyv,
    pub one_g2: UnivariateG2Rkyv,
    pub tau_g2: UnivariateG2Rkyv,
    pub tau_k_g2: UnivariateG2Rkyv,
    pub gamma_inv_public_queries: Vec<UnivariatePublicQueryRkyv>,
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateCrsShapeRkyv {
    pub subcircuit_capacity: u64,
    pub arithmetic_domain_size: u64,
    pub connection_domain_size: u64,
    pub intersection_domain_size: u64,
    pub union_domain_size: u64,
    pub minimum_capacity: [u64; 3],
    pub declared_capacity: [u64; 3],
    pub k: u64,
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariatePublicQueryRkyv {
    pub buffer_subcircuit_id: u64,
    pub local_public_wire_index: u64,
    pub point: UnivariateG1Rkyv,
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
pub struct UnivariateTaggedQueryRkyv {
    pub placement_index: u64,
    pub subcircuit_id: u64,
    pub local_wire_index: u64,
    pub point: UnivariateG1Rkyv,
}

#[cfg(test)]
mod tests {
    #[test]
    fn archive_offsets_are_64_bit() {
        assert_eq!(
            core::mem::size_of::<rkyv::Archived<usize>>(),
            core::mem::size_of::<u64>()
        );
    }
}
