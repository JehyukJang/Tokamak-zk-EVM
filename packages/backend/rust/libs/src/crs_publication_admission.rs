use crate::compatibility::compatibility_from_package_version;
use crate::crs_artifacts::{verify_final_crs_artifact_digests, FinalCrsDigests};
use crate::crs_provenance::{
    parse_final_mpc_crs_provenance, FinalMpcCrsProvenance, Phase1SourceProvenance,
    CRS_PROVENANCE_FILE_NAME,
};
use crate::input_origin::SubcircuitLibraryOrigin;
use std::fs;
use std::path::Path;

const SUBCIRCUIT_LIBRARY_PACKAGE_NAME: &str = "@tokamak-zk-evm/subcircuit-library";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationIdentity {
    pub compatible_backend_version: String,
    pub subcircuit_library_package_name: String,
    pub subcircuit_library_package_version: String,
}

impl PublicationIdentity {
    pub fn new(
        compatible_backend_version: impl Into<String>,
        subcircuit_library_package_name: impl Into<String>,
        subcircuit_library_package_version: impl Into<String>,
    ) -> Self {
        Self {
            compatible_backend_version: compatible_backend_version.into(),
            subcircuit_library_package_name: subcircuit_library_package_name.into(),
            subcircuit_library_package_version: subcircuit_library_package_version.into(),
        }
    }

    pub fn current_package() -> Result<Self, String> {
        let package_version = env!("CARGO_PKG_VERSION");
        let compatible_backend_version = compatibility_from_package_version(package_version)
            .map_err(|error| format!("backend package version {error}"))?
            .to_string();
        Ok(Self::new(
            compatible_backend_version,
            SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
            package_version,
        ))
    }
}

/// Admits a finalized CRS for public release without performing any Drive or
/// OAuth operation. This is the single publication policy shared by the local
/// publisher and the release-workflow validator.
pub fn admit_final_crs_publication(
    output_directory: &Path,
    expected: &PublicationIdentity,
) -> Result<FinalMpcCrsProvenance, String> {
    let provenance_path = output_directory.join(CRS_PROVENANCE_FILE_NAME);
    let provenance_bytes = fs::read(&provenance_path).map_err(|error| {
        format!(
            "cannot read final CRS provenance {}: {error}",
            provenance_path.display()
        )
    })?;
    let provenance = parse_final_mpc_crs_provenance(&provenance_bytes)?;

    if !provenance.release_eligible {
        return Err("only release-eligible CRS artifacts may be published".to_string());
    }
    let Some(Phase1SourceProvenance::DuskGroth16(dusk)) =
        provenance.phase1_source_provenance.as_ref()
    else {
        return Err("only Dusk-backed CRS artifacts may be published".to_string());
    };
    if dusk.expected_source_sha256 != dusk.actual_source_sha256 {
        return Err(
            "Dusk provenance expectedSourceSha256 must equal actualSourceSha256 for publication"
                .to_string(),
        );
    }
    if !dusk.transcript_consistency_verified {
        return Err(
            "Dusk provenance must record successful transcript consistency verification for publication"
                .to_string(),
        );
    }
    if provenance.subcircuit_library.origin != SubcircuitLibraryOrigin::NpmSnapshot {
        return Err(
            "only CRS artifacts generated from an npm subcircuit-library snapshot may be published"
                .to_string(),
        );
    }
    if provenance.compatible_backend_version != expected.compatible_backend_version {
        return Err(format!(
            "crs_provenance.json compatibleBackendVersion {} does not match expected backend compatibility version {}",
            provenance.compatible_backend_version, expected.compatible_backend_version
        ));
    }
    if provenance.subcircuit_library.package_name != expected.subcircuit_library_package_name {
        return Err(format!(
            "crs_provenance.json subcircuitLibrary packageName {} does not match expected package {}",
            provenance.subcircuit_library.package_name, expected.subcircuit_library_package_name
        ));
    }
    if provenance.subcircuit_library.package_version != expected.subcircuit_library_package_version
    {
        return Err(format!(
            "crs_provenance.json subcircuitLibrary packageVersion {} does not match expected package version {}",
            provenance.subcircuit_library.package_version,
            expected.subcircuit_library_package_version
        ));
    }

    let library_compatibility =
        compatibility_from_package_version(&provenance.subcircuit_library.package_version)
            .map_err(|error| {
                format!("crs_provenance.json subcircuitLibrary packageVersion {error}")
            })?
            .to_string();
    if library_compatibility != expected.compatible_backend_version {
        return Err(format!(
            "crs_provenance.json subcircuitLibrary packageVersion {} is outside compatibility class {}",
            provenance.subcircuit_library.package_version, expected.compatible_backend_version
        ));
    }

    verify_final_crs_artifact_digests(
        output_directory,
        &FinalCrsDigests {
            combined_sigma_sha256: provenance.combined_sigma_sha256.clone(),
            sigma_preprocess_sha256: provenance.sigma_preprocess_sha256.clone(),
            sigma_verify_sha256: provenance.sigma_verify_sha256.clone(),
        },
    )
    .map_err(|error| {
        format!("cannot publish CRS whose artifacts fail provenance digest validation: {error}")
    })?;

    Ok(provenance)
}

#[cfg(test)]
mod tests {
    use super::{admit_final_crs_publication, PublicationIdentity};
    use std::path::{Path, PathBuf};

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../common/contracts/fixtures/publication-admission")
            .join(name)
    }

    fn expected() -> PublicationIdentity {
        PublicationIdentity::new("2.1", "@tokamak-zk-evm/subcircuit-library", "2.1.5")
    }

    #[test]
    fn accepts_the_shared_canonical_publication_fixture() {
        admit_final_crs_publication(&fixture("accepted"), &expected())
            .expect("canonical Dusk-backed npm-snapshot fixture must be admitted");
    }

    #[test]
    fn rejects_the_shared_consumer_compatible_but_publication_ineligible_fixture() {
        let error =
            admit_final_crs_publication(&fixture("consumer-compatible-ineligible"), &expected())
                .expect_err("consumer compatibility must not imply publication eligibility");

        assert!(error.contains("only release-eligible CRS artifacts"));
    }
}
