//! Repository-owned contract for backend runtime build metadata.
//!
//! Only the production preprocess, prove, and verify binaries write this
//! document. It is build identity metadata for the CLI installer, not CRS
//! provenance and not a compatibility input for cryptographic workflows.

use serde::{Deserialize, Serialize};

pub const BACKEND_BUILD_METADATA_FILE_PREFIX: &str = "build-metadata-";
pub const BACKEND_BUILD_METADATA_FILE_SUFFIX: &str = ".json";
pub const BACKEND_RUNTIME_PACKAGE_NAMES: [&str; 3] = ["preprocess", "prove", "verify"];
pub const SUBCIRCUIT_LIBRARY_PACKAGE_NAME: &str = "@tokamak-zk-evm/subcircuit-library";
pub const SUBCIRCUIT_LIBRARY_DECLARED_RANGE: &str = "latest";
pub const SUBCIRCUIT_LIBRARY_RUNTIME_MODE: &str = "bundled";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendBuildMetadata {
    pub dependencies: BackendBuildMetadataDependencies,
    pub package_name: String,
    pub package_version: String,
    pub compatible_backend_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendBuildMetadataDependencies {
    pub subcircuit_library: SubcircuitLibraryBuildMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubcircuitLibraryBuildMetadata {
    pub build_version: String,
    pub declared_range: String,
    pub package_name: String,
    pub runtime_mode: String,
}

impl BackendBuildMetadata {
    pub fn new(
        package_name: &str,
        package_version: &str,
        compatible_backend_version: &str,
        subcircuit_library_build_version: &str,
    ) -> Result<Self, String> {
        ensure_runtime_package(package_name)?;
        for (field, value) in [
            ("packageVersion", package_version),
            ("compatibleBackendVersion", compatible_backend_version),
            (
                "dependencies.subcircuitLibrary.buildVersion",
                subcircuit_library_build_version,
            ),
        ] {
            if value.is_empty() {
                return Err(format!("backend build metadata {field} must not be empty"));
            }
        }
        Ok(Self {
            dependencies: BackendBuildMetadataDependencies {
                subcircuit_library: SubcircuitLibraryBuildMetadata {
                    build_version: subcircuit_library_build_version.to_string(),
                    declared_range: SUBCIRCUIT_LIBRARY_DECLARED_RANGE.to_string(),
                    package_name: SUBCIRCUIT_LIBRARY_PACKAGE_NAME.to_string(),
                    runtime_mode: SUBCIRCUIT_LIBRARY_RUNTIME_MODE.to_string(),
                },
            },
            package_name: package_name.to_string(),
            package_version: package_version.to_string(),
            compatible_backend_version: compatible_backend_version.to_string(),
        })
    }
}

pub fn ensure_runtime_package(package_name: &str) -> Result<(), String> {
    if BACKEND_RUNTIME_PACKAGE_NAMES.contains(&package_name) {
        return Ok(());
    }
    Err(format!(
        "backend build metadata is defined only for {}; received {package_name}",
        BACKEND_RUNTIME_PACKAGE_NAMES.join(", ")
    ))
}

pub fn metadata_file_name(package_name: &str) -> Result<String, String> {
    ensure_runtime_package(package_name)?;
    Ok(format!(
        "{BACKEND_BUILD_METADATA_FILE_PREFIX}{package_name}{BACKEND_BUILD_METADATA_FILE_SUFFIX}"
    ))
}

#[cfg(test)]
mod tests {
    use super::{metadata_file_name, BackendBuildMetadata};
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contract {
        file_name_pattern: String,
        backend_package_names: Vec<String>,
        schema: serde_json::Value,
    }

    #[test]
    fn conforms_to_the_root_metadata_contract() {
        let contract: Contract =
            serde_json::from_str(include_str!("backend-build-metadata-contract.json"))
                .expect("root backend build metadata contract must be valid JSON");
        assert_eq!(
            contract.file_name_pattern,
            "build-metadata-{backendPackageName}.json"
        );
        assert_eq!(
            contract.backend_package_names,
            ["preprocess", "prove", "verify"]
        );
        assert!(contract.schema.is_object());
    }

    #[test]
    fn accepts_the_canonical_fixture_and_rejects_the_invalid_fixture() {
        let fixture: BackendBuildMetadata =
            serde_json::from_str(include_str!("fixtures/backend-build-metadata-valid.json"))
                .expect("canonical backend build metadata fixture must satisfy the contract");
        assert_eq!(fixture.package_name, "prove");
        assert!(serde_json::from_str::<BackendBuildMetadata>(include_str!(
            "fixtures/backend-build-metadata-invalid.json"
        ))
        .is_err());
    }

    #[test]
    fn limits_metadata_to_runtime_consumers() {
        assert_eq!(
            metadata_file_name("verify").unwrap(),
            "build-metadata-verify.json"
        );
        assert!(metadata_file_name("trusted-setup").is_err());
        assert!(BackendBuildMetadata::new("trusted-setup", "2.1.5", "2.1", "2.1.5").is_err());
    }
}
