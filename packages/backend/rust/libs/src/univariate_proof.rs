//! F5 proof object for the latest univariate protocol.
//!
//! This is deliberately distinct from the legacy bivariate `Proof` and its
//! Solidity formatter.  The latter carries nineteen source-group points and
//! cannot encode this protocol's Fiat--Shamir proof.

use crate::field_structures::FieldSerde;
use crate::group_structures::G1serde;
use crate::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID;
use serde::{Deserialize, Serialize};

/// The six prover-message blocks serialized by F5.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnivariateProof {
    pub protocol_schema_id: String,
    /// F1 `a_1`: typed witness commitments and two private bindings.
    pub c_u: G1serde,
    pub c_v: G1serde,
    pub c_w: G1serde,
    pub c_b: G1serde,
    pub o_if: G1serde,
    pub o_int: G1serde,
    /// F2--F4 commitment messages.
    pub c_d: G1serde,
    pub c_r: G1serde,
    pub c_q: G1serde,
    /// F4's nine scalar evaluations.
    pub s_a: FieldSerde,
    pub s_c: FieldSerde,
    pub u: FieldSerde,
    pub v: FieldSerde,
    pub w: FieldSerde,
    pub b: FieldSerde,
    pub q_zeta: FieldSerde,
    pub r: FieldSerde,
    pub r_plus: FieldSerde,
    /// F5 aggregate opening messages.
    pub pi_zeta: G1serde,
    pub pi_plus: G1serde,
}

impl UnivariateProof {
    pub fn has_protocol_schema(&self) -> bool {
        self.protocol_schema_id == UNIVARIATE_CRS_SCHEMA_ID
    }

    pub fn g1_element_count(&self) -> usize {
        11
    }

    pub fn scalar_element_count(&self) -> usize {
        9
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
    fn f5_wire_object_has_exact_protocol_cardinality() {
        let scalar = FieldSerde(ScalarField::one());
        let proof = UnivariateProof {
            protocol_schema_id: UNIVARIATE_CRS_SCHEMA_ID.to_string(),
            c_u: G1serde::zero(),
            c_v: G1serde::zero(),
            c_w: G1serde::zero(),
            c_b: G1serde::zero(),
            o_if: G1serde::zero(),
            o_int: G1serde::zero(),
            c_d: G1serde::zero(),
            c_r: G1serde::zero(),
            c_q: G1serde::zero(),
            s_a: scalar,
            s_c: scalar,
            u: scalar,
            v: scalar,
            w: scalar,
            b: scalar,
            q_zeta: scalar,
            r: scalar,
            r_plus: scalar,
            pi_zeta: G1serde::zero(),
            pi_plus: G1serde::zero(),
        };
        assert!(proof.has_protocol_schema());
        assert_eq!(proof.g1_element_count(), 11);
        assert_eq!(proof.scalar_element_count(), 9);
        let encoded = serde_json::to_value(&proof).expect("U54 proof must serialize");
        assert_eq!(encoded.as_object().expect("proof JSON object").len(), 21);
    }
}
