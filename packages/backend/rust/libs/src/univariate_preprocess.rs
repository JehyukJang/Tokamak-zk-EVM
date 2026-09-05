//! Circuit-specific public preprocessing for the univariate protocol.
//!
//! The object contains exactly the two U21c commitments.  Its relationship to
//! a CRS and derived circuit is enforced by the protocol transcript, not by a
//! digest field or a second compatibility mechanism.

use crate::group_structures::G1serde;
use crate::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID;
use serde::{Deserialize, Serialize};

/// U21c's public preprocessing object for one `(kappa, rho)` circuit.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnivariatePreprocess {
    /// Identifies the protocol family used by both commitments.
    pub protocol_schema_id: String,
    /// The ordinary-KZG commitment `[S_kappa]_1`.
    pub s_kappa: G1serde,
    /// The ordinary-KZG commitment `[S_C]_1`.
    pub s_c: G1serde,
}

impl UnivariatePreprocess {
    pub fn new(s_kappa: G1serde, s_c: G1serde) -> Self {
        Self {
            protocol_schema_id: UNIVARIATE_CRS_SCHEMA_ID.to_string(),
            s_kappa,
            s_c,
        }
    }

    pub fn validates_protocol_schema(&self) -> bool {
        self.protocol_schema_id == UNIVARIATE_CRS_SCHEMA_ID
    }
}
