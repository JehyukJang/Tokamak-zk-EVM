//! Backend-owned contract for `crs_provenance.json`.
//!
//! The same filename records either a development-only trusted-setup Sigma or
//! a final MPC CRS. `documentKind` is therefore mandatory and consumers must
//! select the representation appropriate to their boundary.

use crate::compatibility::{parse_compatible_backend_version, parse_package_version};
use crate::input_origin::SubcircuitLibraryOrigin;
use chrono::DateTime;
use rkyv::{Archive, Deserialize as RkyvDeserialize, Serialize as RkyvSerialize};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub const CRS_PROVENANCE_FILE_NAME: &str = "crs_provenance.json";
pub const DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND: &str = "developmentTrustedSetupSigma";
pub const FINAL_MPC_CRS_DOCUMENT_KIND: &str = "finalMpcCrs";

const CRS_PROVENANCE_CONTRACT_SHA256: &str =
    "4e3072e22cb712359ed2b994ba360666d59cb5c4e69c14552739e179d0d76188";
const SUPPORTED_SCHEMA_KEYWORDS: &[&str] = &[
    "additionalProperties",
    "const",
    "enum",
    "format",
    "minLength",
    "minimum",
    "oneOf",
    "pattern",
    "properties",
    "required",
    "type",
];

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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

/// Ensures that this Rust adapter still implements the checked-in backend
/// provenance contract. Any contract edit must deliberately update this
/// adapter, its fixtures, and its consumer validators.
pub fn ensure_crs_provenance_contract_definition() -> Result<(), String> {
    static VALIDATION: OnceLock<Result<(), String>> = OnceLock::new();
    VALIDATION
        .get_or_init(validate_crs_provenance_contract_definition)
        .clone()
}

fn validate_crs_provenance_contract_definition() -> Result<(), String> {
    let bytes = include_bytes!("../../contracts/crs-provenance-contract.json");
    let actual_digest = format!("{:x}", Sha256::digest(bytes));
    if actual_digest != CRS_PROVENANCE_CONTRACT_SHA256 {
        return Err(format!(
            "CRS provenance contract changed (expected SHA-256 {CRS_PROVENANCE_CONTRACT_SHA256}, got {actual_digest}); update the Rust adapter, fixtures, and consumer validators"
        ));
    }

    let contract: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("CRS provenance contract is invalid JSON: {error}"))?;
    let document_kinds = contract
        .get("documentKinds")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "CRS provenance contract is missing documentKinds".to_string())?;
    for document_kind in [
        DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND,
        FINAL_MPC_CRS_DOCUMENT_KIND,
    ] {
        let schema = document_kinds
            .get(document_kind)
            .and_then(|document| document.get("schema"))
            .ok_or_else(|| format!("CRS provenance contract is missing {document_kind}.schema"))?;
        validate_supported_schema_keywords(schema, document_kind)?;
    }
    Ok(())
}

fn validate_supported_schema_keywords(
    schema: &serde_json::Value,
    path: &str,
) -> Result<(), String> {
    let object = schema
        .as_object()
        .ok_or_else(|| format!("CRS provenance contract {path} schema must be an object"))?;
    for key in object.keys() {
        if !SUPPORTED_SCHEMA_KEYWORDS.contains(&key.as_str()) {
            return Err(format!(
                "CRS provenance contract {path} uses unsupported schema keyword {key}"
            ));
        }
    }
    if let Some(one_of) = object.get("oneOf") {
        for (index, candidate) in one_of
            .as_array()
            .ok_or_else(|| format!("CRS provenance contract {path}.oneOf must be an array"))?
            .iter()
            .enumerate()
        {
            validate_supported_schema_keywords(candidate, &format!("{path}.oneOf[{index}]"))?;
        }
    }
    if let Some(properties) = object.get("properties") {
        for (field, child) in properties
            .as_object()
            .ok_or_else(|| format!("CRS provenance contract {path}.properties must be an object"))?
        {
            validate_supported_schema_keywords(child, &format!("{path}.properties.{field}"))?;
        }
    }
    Ok(())
}

/// Parses and validates a final-MPC CRS provenance document at a backend
/// boundary. The JSON contract in `packages/backend/contracts` is the source
/// of the accepted document shape and semantic constraints.
pub fn parse_final_mpc_crs_provenance(bytes: &[u8]) -> Result<FinalMpcCrsProvenance, String> {
    ensure_crs_provenance_contract_definition()?;
    let provenance: CrsProvenance =
        serde_json::from_slice(bytes).map_err(|error| format!("invalid JSON: {error}"))?;
    let CrsProvenance::FinalMpcCrs(provenance) = provenance else {
        return Err("documentKind must equal finalMpcCrs".to_string());
    };
    validate_final_mpc_crs_provenance(&provenance)?;
    Ok(provenance)
}

/// Validates the semantic constraints that Serde types alone cannot express.
pub fn validate_final_mpc_crs_provenance(provenance: &FinalMpcCrsProvenance) -> Result<(), String> {
    ensure_crs_provenance_contract_definition()?;
    validate_rfc3339(&provenance.generated_at_utc, "generatedAtUtc")?;
    parse_compatible_backend_version(&provenance.compatible_backend_version)
        .map_err(|error| format!("compatibleBackendVersion {error}"))?;
    validate_non_empty(
        &provenance.subcircuit_library.package_name,
        "subcircuitLibrary.packageName",
    )?;
    parse_package_version(&provenance.subcircuit_library.package_version)
        .map_err(|error| format!("subcircuitLibrary.packageVersion {error}"))?;
    validate_sha256(&provenance.combined_sigma_sha256, "combinedSigmaSha256")?;
    validate_sha256(&provenance.sigma_preprocess_sha256, "sigmaPreprocessSha256")?;
    validate_sha256(&provenance.sigma_verify_sha256, "sigmaVerifySha256")?;

    if let Some(Phase1SourceProvenance::DuskGroth16(dusk)) =
        provenance.phase1_source_provenance.as_ref()
    {
        for (field, value) in [
            (
                "phase1SourceProvenance.duskGroth16.sourceUrl",
                &dusk.source_url,
            ),
            (
                "phase1SourceProvenance.duskGroth16.rawEncoding",
                &dusk.raw_encoding,
            ),
            (
                "phase1SourceProvenance.duskGroth16.pinnedContribution",
                &dusk.pinned_contribution,
            ),
            (
                "phase1SourceProvenance.duskGroth16.pinnedReadmeUrl",
                &dusk.pinned_readme_url,
            ),
            (
                "phase1SourceProvenance.duskGroth16.pinnedDriveFileId",
                &dusk.pinned_drive_file_id,
            ),
        ] {
            validate_non_empty(value, field)?;
        }
        validate_sha256(
            &dusk.expected_source_sha256,
            "phase1SourceProvenance.duskGroth16.expectedSourceSha256",
        )?;
        validate_sha256(
            &dusk.actual_source_sha256,
            "phase1SourceProvenance.duskGroth16.actualSourceSha256",
        )?;
    }

    Ok(())
}

fn validate_rfc3339(value: &str, field: &str) -> Result<(), String> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|error| format!("{field} must be an RFC 3339 date-time: {error}"))
}

fn validate_non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(());
    }
    Err(format!(
        "{field} must be a lower-case 64-character SHA-256 digest"
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_crs_provenance_contract_definition, parse_final_mpc_crs_provenance,
        validate_supported_schema_keywords, CrsProvenance, DevelopmentOnlyReleaseEligibility,
        DevelopmentTrustedSetupSigmaProvenance, CRS_PROVENANCE_FILE_NAME,
        DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND, FINAL_MPC_CRS_DOCUMENT_KIND,
    };
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contract {
        file_name: String,
        document_kinds: serde_json::Map<String, serde_json::Value>,
    }

    #[test]
    fn conforms_to_the_backend_crs_provenance_contract() {
        let contract: Contract =
            serde_json::from_str(include_str!("../../contracts/crs-provenance-contract.json"))
                .expect("backend CRS provenance contract must be valid JSON");
        assert_eq!(contract.file_name, CRS_PROVENANCE_FILE_NAME);
        assert!(contract
            .document_kinds
            .contains_key(DEVELOPMENT_TRUSTED_SETUP_SIGMA_DOCUMENT_KIND));
        assert!(contract
            .document_kinds
            .contains_key(FINAL_MPC_CRS_DOCUMENT_KIND));
        ensure_crs_provenance_contract_definition()
            .expect("Rust provenance adapter must implement the checked-in contract");
    }

    #[test]
    fn rejects_unsupported_provenance_schema_keywords() {
        assert!(validate_supported_schema_keywords(
            &serde_json::json!({ "type": "string", "unsupportedKeyword": true }),
            "test"
        )
        .is_err());
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

    #[test]
    fn every_canonical_final_mpc_phase1_variant_round_trips_through_rust() {
        for fixture in [
            include_str!("../../contracts/fixtures/final-mpc-crs-provenance.json"),
            include_str!("../../contracts/fixtures/final-mpc-crs-provenance-native.json"),
            include_str!("../../contracts/fixtures/final-mpc-crs-provenance-null.json"),
        ] {
            let fixture: serde_json::Value =
                serde_json::from_str(fixture).expect("canonical fixture must be valid JSON");
            let bytes = serde_json::to_vec(&fixture).expect("fixture must serialize");
            let provenance = parse_final_mpc_crs_provenance(&bytes)
                .expect("canonical final MPC fixture must satisfy the Rust contract");
            assert_eq!(
                serde_json::to_value(CrsProvenance::FinalMpcCrs(provenance))
                    .expect("fixture must serialize"),
                fixture
            );
        }
    }

    #[test]
    fn rejects_malformed_and_legacy_final_mpc_fixtures() {
        for fixture in [
            include_str!("../../contracts/fixtures/final-mpc-crs-provenance-malformed.json"),
            include_str!("../../contracts/fixtures/final-mpc-crs-provenance-legacy.json"),
        ] {
            let provenance: serde_json::Value =
                serde_json::from_str(fixture).expect("negative fixture must be valid JSON");
            assert!(serde_json::from_value::<CrsProvenance>(provenance).is_err());
        }
    }

    #[test]
    fn rejects_every_semantic_final_mpc_contract_violation_fixture() {
        for fixture in [
            include_bytes!("../../contracts/fixtures/final-mpc-crs-provenance-leading-zero.json")
                as &[u8],
            include_bytes!("../../contracts/fixtures/final-mpc-crs-provenance-date-only.json"),
            include_bytes!("../../contracts/fixtures/final-mpc-crs-provenance-invalid-digest.json"),
            include_bytes!("../../contracts/fixtures/final-mpc-crs-provenance-empty-string.json"),
            include_bytes!("../../contracts/fixtures/final-mpc-crs-provenance-invalid-phase1.json"),
            include_bytes!("../../contracts/fixtures/final-mpc-crs-provenance-invalid-origin.json"),
        ] {
            assert!(parse_final_mpc_crs_provenance(fixture).is_err());
        }
    }
}
