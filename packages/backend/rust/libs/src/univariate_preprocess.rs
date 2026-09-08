//! Circuit-specific public preprocessing for the univariate protocol.
//!
//! The object contains exactly the two U21c commitments. Its relationship to
//! a CRS and derived circuit is admitted by the verifier configuration, not by
//! an additional serialized marker.

use crate::group_structures::G1serde;
use serde::{Deserialize, Serialize};

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
