//! Circuit-specific public preprocessing for the univariate protocol.
//!
//! The object contains exactly the two U21c commitments. Its relationship to
//! a CRS and derived circuit is admitted by the verifier configuration, not by
//! an additional serialized marker.

use crate::field_structures::FieldSerde;
use crate::frontend_artifacts::public_wire_layout::PublicWireLayout;
use crate::group_structures::{G1serde, G2serde};
use crate::univariate_crs::{UnivariateCrsShape, UnivariateVerifierKeys, UNIVARIATE_CRS_SCHEMA_ID};
use serde::{Deserialize, Serialize};

pub const ADMITTED_UNIVARIATE_VERIFIER_CONFIG_SCHEMA_ID: &str =
    "tokamak-zk-evm-univariate-verifier-config";

/// U21c's public preprocessing object for one `(kappa, rho)` circuit.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnivariatePreprocess {
    /// The ordinary-KZG commitment `[S_kappa]_1`.
    pub s_kappa: G1serde,
    /// The ordinary-KZG commitment `[S_C]_1`.
    pub s_c: G1serde,
}

impl UnivariatePreprocess {
    pub fn new(s_kappa: G1serde, s_c: G1serde) -> Self {
        Self { s_kappa, s_c }
    }
}

/// The complete fixed input to online verification. Circuit admission creates
/// this object once; verification needs no library, selector, permutation, or
/// tau-sequence artifact after it has been written.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmittedUnivariateVerifierConfig {
    pub schema_id: String,
    pub arithmetic_domain_size: usize,
    pub connection_domain_size: usize,
    pub intersection_domain_size: usize,
    pub union_domain_size: usize,
    pub connection_root: FieldSerde,
    pub preprocess: UnivariatePreprocess,
    pub public_binding_queries: Box<[G1serde]>,
    pub one_g1: G1serde,
    pub xi_g1: G1serde,
    pub psi_g1: G1serde,
    pub one_g2: G2serde,
    pub tau_g2: G2serde,
    pub tau_k_g2: G2serde,
    pub gamma_g2: G2serde,
    pub eta_g2: G2serde,
    pub delta_g2: G2serde,
}

impl AdmittedUnivariateVerifierConfig {
    pub fn from_admitted_circuit(
        keys: &UnivariateVerifierKeys,
        preprocess: UnivariatePreprocess,
        public_layout: &PublicWireLayout,
    ) -> Result<Self, String> {
        if keys.schema_id != UNIVARIATE_CRS_SCHEMA_ID {
            return Err("verifier keys use an unsupported CRS schema".to_string());
        }
        let query_index = keys.query_index();
        let mut public_binding_queries = Vec::with_capacity(public_layout.len());
        for public_wire_index in 0..public_layout.len() {
            let point = match public_layout.public_query_key_for_public_wire(public_wire_index) {
                None => G1serde::zero(),
                Some(key) => query_index
                    .public_index(key)
                    .and_then(|index| keys.gamma_inv_public_queries.get(index))
                    .map(|query| query.point)
                    .ok_or_else(|| {
                        format!(
                            "verifier keys are missing public query ({}, {})",
                            key.buffer_subcircuit_id, key.local_public_wire_index
                        )
                    })?,
            };
            public_binding_queries.push(point);
        }

        let UnivariateCrsShape {
            arithmetic_domain_size,
            connection_domain_size,
            intersection_domain_size,
            union_domain_size,
            connection_root,
            ..
        } = keys.shape;
        Ok(Self {
            schema_id: ADMITTED_UNIVARIATE_VERIFIER_CONFIG_SCHEMA_ID.to_string(),
            arithmetic_domain_size,
            connection_domain_size,
            intersection_domain_size,
            union_domain_size,
            connection_root: FieldSerde(connection_root),
            preprocess,
            public_binding_queries: public_binding_queries.into_boxed_slice(),
            one_g1: keys.one_g1,
            xi_g1: keys.xi_g1,
            psi_g1: keys.psi_g1,
            one_g2: keys.one_g2,
            tau_g2: keys.tau_g2,
            tau_k_g2: keys.tau_k_g2,
            gamma_g2: keys.gamma_g2,
            eta_g2: keys.eta_g2,
            delta_g2: keys.delta_g2,
        })
    }

    pub fn validate_for_online_verification(
        &self,
        public_input_count: usize,
    ) -> Result<(), String> {
        if self.schema_id != ADMITTED_UNIVARIATE_VERIFIER_CONFIG_SCHEMA_ID {
            return Err("unsupported admitted verifier configuration schema".to_string());
        }
        if self.public_binding_queries.len() != public_input_count {
            return Err(format!(
                "configuration has {} public binding queries, but the statement has {public_input_count} values",
                self.public_binding_queries.len()
            ));
        }
        Ok(())
    }

    pub fn public_binding(
        &self,
        public_inputs: &[icicle_bls12_381::curve::ScalarField],
    ) -> G1serde {
        self.public_binding_queries
            .iter()
            .copied()
            .zip(public_inputs.iter().copied())
            .fold(G1serde::zero(), |binding, (query, value)| {
                binding + query * value
            })
    }
}
