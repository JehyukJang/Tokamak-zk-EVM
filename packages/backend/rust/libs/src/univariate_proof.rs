//! U54 proof object for the univariate protocol.
//!
//! This is deliberately distinct from the legacy bivariate `Proof` and its
//! Solidity formatter.  The latter carries nineteen source-group points and
//! cannot encode this protocol's Fiat--Shamir proof.

use crate::field_structures::FieldSerde;
use crate::group_structures::G1serde;
use crate::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID;
use serde::{Deserialize, Serialize};

/// The five U52 prover-message blocks serialized by U54.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnivariateProof {
    pub protocol_schema_id: String,
    /// U52 `a_1`: blinded witness commitments and two private bindings.
    pub u_hat: G1serde,
    pub v_hat: G1serde,
    pub w_hat: G1serde,
    pub b_hat: G1serde,
    pub o_if: G1serde,
    pub o_int: G1serde,
    /// U52 `a_2` and `a_3`.
    pub r_hat: G1serde,
    pub q_hat: G1serde,
    /// U52 `a_5`.
    pub s_a: FieldSerde,
    pub v: FieldSerde,
    pub r: FieldSerde,
    pub r_plus: FieldSerde,
    pub p: FieldSerde,
    /// U52 `a_6`.
    pub pi_zeta: G1serde,
    pub pi_plus: G1serde,
}

impl UnivariateProof {
    pub fn has_protocol_schema(&self) -> bool {
        self.protocol_schema_id == UNIVARIATE_CRS_SCHEMA_ID
    }

    pub fn g1_element_count(&self) -> usize {
        10
    }

    pub fn scalar_element_count(&self) -> usize {
        5
    }
}

#[cfg(test)]
mod tests {
    use super::UnivariateProof;
    use crate::field_structures::FieldSerde;
    use crate::group_structures::G1serde;
    use crate::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID;
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;

    #[test]
    fn u54_wire_object_has_exact_protocol_cardinality() {
        let scalar = FieldSerde(ScalarField::one());
        let proof = UnivariateProof {
            protocol_schema_id: UNIVARIATE_CRS_SCHEMA_ID.to_string(),
            u_hat: G1serde::zero(),
            v_hat: G1serde::zero(),
            w_hat: G1serde::zero(),
            b_hat: G1serde::zero(),
            o_if: G1serde::zero(),
            o_int: G1serde::zero(),
            r_hat: G1serde::zero(),
            q_hat: G1serde::zero(),
            s_a: scalar,
            v: scalar,
            r: scalar,
            r_plus: scalar,
            p: scalar,
            pi_zeta: G1serde::zero(),
            pi_plus: G1serde::zero(),
        };
        assert!(proof.has_protocol_schema());
        assert_eq!(proof.g1_element_count(), 10);
        assert_eq!(proof.scalar_element_count(), 5);
        let encoded = serde_json::to_value(&proof).expect("U54 proof must serialize");
        assert_eq!(encoded.as_object().expect("proof JSON object").len(), 16);
    }
}
