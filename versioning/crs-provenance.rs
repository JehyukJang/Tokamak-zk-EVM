//! Repository-owned contract for `crs_provenance.json`.
//!
//! The same filename records either a development-only trusted-setup Sigma or
//! a final MPC CRS. `documentKind` is therefore mandatory and consumers must
//! select the representation appropriate to their boundary.

use crate::input_origin::SubcircuitLibraryOrigin;
use rkyv::{Archive, Deserialize as RkyvDeserialize, Serialize as RkyvSerialize};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub const CRS_PROVENANCE_FILE_NAME: &str = "crs_provenance.json";
pub const DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND: &str = "developmentTrustedSetupSigma";
pub const FINAL_MPC_CRS_DOCUMENT_KIND: &str = "finalMpcCrs";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "documentKind", rename_all = "camelCase")]
pub enum CrsProvenance {
    DevelopmentTrustedSetupSigma(DevelopmentTrustedSetupSigmaProvenance),
    FinalMpcCrs(FinalMpcCrsProvenance),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentTrustedSetupSigmaProvenance {
    pub release_eligible: DevelopmentOnlyReleaseEligibility,
}

/// A serialized `false` that cannot be constructed as `true`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DevelopmentOnlyReleaseEligibility;

impl Serialize for DevelopmentOnlyReleaseEligibility {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bool(false)
    }
}

impl<'de> Deserialize<'de> for DevelopmentOnlyReleaseEligibility {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if <bool as Deserialize>::deserialize(deserializer)? {
            return Err(D::Error::custom(
                "developmentTrustedSetupSigma provenance must set releaseEligible to false",
            ));
        }
        Ok(Self)
    }
}

#[derive(
    Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Archive, RkyvSerialize, RkyvDeserialize,
)]
#[archive(check_bytes)]
pub struct DuskSourceProvenance {
    pub source_url: String,
    pub source_size_bytes: u64,
    pub raw_encoding: String,
    pub pinned_contribution: String,
    pub pinned_readme_url: String,
    pub pinned_drive_file_id: String,
    pub expected_source_sha256: String,
    pub actual_source_sha256: String,
    pub auto_downloaded: bool,
    pub downloaded_contribution: Option<String>,
    pub downloaded_readme_url: Option<String>,
    pub downloaded_drive_file_id: Option<String>,
    pub max_g1_exp_used: usize,
    pub max_g2_exp_used: usize,
    pub transcript_consistency_verified: bool,
}

#[derive(
    Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Archive, RkyvSerialize, RkyvDeserialize,
)]
#[archive(check_bytes)]
pub enum Phase1SourceProvenance {
    Native,
    DuskGroth16(DuskSourceProvenance),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubcircuitLibraryProvenance {
    pub package_name: String,
    pub package_version: String,
    pub origin: SubcircuitLibraryOrigin,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalMpcCrsProvenance {
    pub release_eligible: bool,
    pub generated_at_utc: String,
    pub compatible_backend_version: String,
    pub subcircuit_library: SubcircuitLibraryProvenance,
    pub phase1_source_provenance: Option<Phase1SourceProvenance>,
    pub combined_sigma_sha256: String,
    pub sigma_preprocess_sha256: String,
    pub sigma_verify_sha256: String,
}

#[cfg(test)]
mod tests {
    use super::{
        CrsProvenance, DevelopmentOnlyReleaseEligibility, DevelopmentTrustedSetupSigmaProvenance,
        CRS_PROVENANCE_FILE_NAME, DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND,
        FINAL_MPC_CRS_DOCUMENT_KIND,
    };
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contract {
        file_name: String,
        document_kinds: serde_json::Map<String, serde_json::Value>,
    }

    #[test]
    fn conforms_to_the_repository_crs_provenance_contract() {
        let contract: Contract = serde_json::from_str(include_str!("crs-provenance-contract.json"))
            .expect("repository CRS provenance contract must be valid JSON");
        assert_eq!(contract.file_name, CRS_PROVENANCE_FILE_NAME);
        assert!(contract
            .document_kinds
            .contains_key(DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND));
        assert!(contract
            .document_kinds
            .contains_key(FINAL_MPC_CRS_DOCUMENT_KIND));
    }

    #[test]
    fn development_provenance_is_tagged_and_cannot_be_release_eligible() {
        let provenance =
            CrsProvenance::DevelopmentTrustedSetupSigma(DevelopmentTrustedSetupSigmaProvenance {
                release_eligible: DevelopmentOnlyReleaseEligibility,
            });
        let encoded = serde_json::to_value(&provenance).expect("must serialize provenance");
        assert_eq!(encoded["documentKind"], "developmentTrustedSetupSigma");
        assert_eq!(encoded["releaseEligible"], false);
        assert!(serde_json::from_value::<CrsProvenance>(serde_json::json!({
            "documentKind": "developmentTrustedSetupSigma",
            "releaseEligible": true,
        }))
        .is_err());
    }
}
