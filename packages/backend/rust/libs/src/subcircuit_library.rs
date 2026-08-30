use crate::compatibility::{compatibility_from_package_version, parse_compatible_backend_version};
use crate::crs_provenance::{
    ensure_crs_provenance_contract_definition, parse_final_mpc_crs_provenance, CrsProvenance,
    DevelopmentOnlyReleaseEligibility, DevelopmentTrustedSetupSigmaProvenance,
    CRS_PROVENANCE_FILE_NAME,
};
use crate::errors::CrsError;
use clap::Args;
use std::env;
use std::fs;
#[cfg(tokamak_embedded_subcircuit_library)]
use std::io;
use std::path::{Path, PathBuf};
#[cfg(tokamak_embedded_subcircuit_library)]
use std::sync::OnceLock;
#[cfg(tokamak_embedded_subcircuit_library)]
use std::time::Duration;

include!(concat!(env!("OUT_DIR"), "/embedded_subcircuit_library.rs"));

#[cfg(not(tokamak_embedded_subcircuit_library))]
const SUBCIRCUIT_LIBRARY_PACKAGE_NAME: &str = "@tokamak-zk-evm/subcircuit-library";

#[cfg(tokamak_embedded_subcircuit_library)]
static MATERIALIZED_PATH: OnceLock<PathBuf> = OnceLock::new();

#[cfg(not(tokamak_embedded_subcircuit_library))]
#[derive(Args, Debug, Clone)]
pub struct SubcircuitLibraryArg {
    /// Subcircuit library directory produced by the QAP compiler
    #[arg(long, value_name = "PATH")]
    pub subcircuit_library: String,
}

#[cfg(tokamak_embedded_subcircuit_library)]
#[derive(Args, Debug, Clone, Default)]
pub struct SubcircuitLibraryArg {}

impl SubcircuitLibraryArg {
    #[cfg(not(tokamak_embedded_subcircuit_library))]
    pub fn as_deref(&self) -> Option<&str> {
        Some(self.subcircuit_library.as_str())
    }

    #[cfg(tokamak_embedded_subcircuit_library)]
    pub fn as_deref(&self) -> Option<&str> {
        None
    }
}

/// Development-only opt-in for skipping CRS compatibility validation.
#[cfg(all(
    feature = "development-crs-bypass",
    not(tokamak_embedded_subcircuit_library)
))]
#[derive(Args, Debug, Clone, Default)]
pub struct DevelopmentCrsProvenanceArg {
    /// Skip CRS compatibility validation for local development only
    #[arg(long)]
    allow_unverified_crs: bool,
}

#[cfg(not(all(
    feature = "development-crs-bypass",
    not(tokamak_embedded_subcircuit_library)
)))]
#[derive(Args, Debug, Clone, Default)]
pub struct DevelopmentCrsProvenanceArg {}

impl DevelopmentCrsProvenanceArg {
    pub fn allows_unverified_crs(&self) -> bool {
        #[cfg(all(
            feature = "development-crs-bypass",
            not(tokamak_embedded_subcircuit_library)
        ))]
        {
            return self.allow_unverified_crs;
        }

        #[cfg(not(all(
            feature = "development-crs-bypass",
            not(tokamak_embedded_subcircuit_library)
        )))]
        false
    }
}

pub fn try_resolve_subcircuit_library_path(local_path: Option<&str>) -> Result<PathBuf, CrsError> {
    if let Some(path) = local_path {
        return fs::canonicalize(path).map_err(|source| CrsError::Read {
            path: PathBuf::from(path),
            source,
        });
    }

    #[cfg(tokamak_embedded_subcircuit_library)]
    {
        return materialize_embedded_subcircuit_library().map_err(|source| CrsError::Read {
            path: PathBuf::from("embedded subcircuit library"),
            source,
        });
    }

    #[cfg(not(tokamak_embedded_subcircuit_library))]
    {
        Err(CrsError::Compatibility(
            "--subcircuit-library is required for non-release backend binaries".to_string(),
        ))
    }
}

pub fn validate_crs_compatibility(crs_dir: &Path, library_dir: &Path) -> std::io::Result<()> {
    let provenance_path = crs_dir.join(CRS_PROVENANCE_FILE_NAME);
    let provenance_bytes = fs::read(&provenance_path).map_err(|source| {
        std::io::Error::new(
            source.kind(),
            format!(
                "cannot read CRS provenance {}: {source}",
                provenance_path.display()
            ),
        )
    })?;
    let provenance = parse_final_mpc_crs_provenance(&provenance_bytes).map_err(|reason| {
        std::io::Error::other(format!(
            "cannot validate CRS provenance {}: {reason}",
            provenance_path.display()
        ))
    })?;
    let crs_compatible_version = provenance.compatible_backend_version;
    let crs_compatible_version = parse_compatible_backend_version(&crs_compatible_version)
        .map(|version| version.to_string())
        .map_err(|error| {
            std::io::Error::other(format!("CRS provenance compatibleBackendVersion {error}"))
        })?;
    let compiled_backend_version = compatibility_from_package_version(env!("CARGO_PKG_VERSION"))
        .map(|version| version.to_string())
        .map_err(|error| {
            std::io::Error::other(format!("compiled backend package version {error}"))
        })?;

    if crs_compatible_version != compiled_backend_version {
        return Err(std::io::Error::other(format!(
            "CRS compatibility version {} does not match compiled backend compatibility class {}",
            crs_compatible_version, compiled_backend_version
        )));
    }

    let library_version = selected_library_package_version(library_dir)?;
    let library_compatible_version = compatibility_from_package_version(&library_version)
        .map(|version| version.to_string())
        .map_err(|error| {
            std::io::Error::other(format!("subcircuit-library package version {error}"))
        })?;

    if crs_compatible_version != library_compatible_version {
        return Err(std::io::Error::other(format!(
            "CRS compatibility version {} does not match subcircuit-library package version {} (compatibility class {})",
            crs_compatible_version, library_version, library_compatible_version
        )));
    }

    Ok(())
}

pub fn write_development_only_trusted_setup_provenance(output_dir: &Path) -> std::io::Result<()> {
    ensure_crs_provenance_contract_definition().map_err(std::io::Error::other)?;
    let provenance =
        CrsProvenance::DevelopmentTrustedSetupSigma(DevelopmentTrustedSetupSigmaProvenance {
            release_eligible: DevelopmentOnlyReleaseEligibility,
        });
    let bytes = serde_json::to_vec_pretty(&provenance).map_err(std::io::Error::other)?;
    fs::write(output_dir.join(CRS_PROVENANCE_FILE_NAME), bytes)
}

pub fn validate_operational_crs_compatibility(
    development: &DevelopmentCrsProvenanceArg,
    crs_dir: &Path,
    library_dir: &Path,
) -> Result<(), CrsError> {
    if development.allows_unverified_crs() {
        eprintln!(
            "WARNING: skipping CRS provenance compatibility validation for local development"
        );
        return Ok(());
    }

    validate_crs_compatibility(crs_dir, library_dir)
        .map_err(|error| CrsError::Compatibility(error.to_string()))
}

fn selected_library_package_version(library_dir: &Path) -> std::io::Result<String> {
    #[cfg(tokamak_embedded_subcircuit_library)]
    {
        let _ = library_dir;
        return Ok(SUBCIRCUIT_LIBRARY_BUILD_VERSION.to_string());
    }

    #[cfg(not(tokamak_embedded_subcircuit_library))]
    {
        let mut current = Some(library_dir);
        while let Some(directory) = current {
            let manifest_path = directory.join("package.json");
            if manifest_path.is_file() {
                let manifest: serde_json::Value =
                    read_json(&manifest_path, "subcircuit-library package manifest")?;
                let package_name = manifest
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        std::io::Error::other(format!(
                            "{} is missing package name",
                            manifest_path.display()
                        ))
                    })?;
                if package_name == SUBCIRCUIT_LIBRARY_PACKAGE_NAME {
                    let package_version = manifest
                        .get("version")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| {
                            std::io::Error::other(format!(
                                "{} is missing package version",
                                manifest_path.display()
                            ))
                        })?;
                    return Ok(package_version.to_string());
                }
            }
            current = directory.parent();
        }

        Err(std::io::Error::other(format!(
            "cannot find a {} package manifest above subcircuit library {}",
            SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
            library_dir.display()
        )))
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, label: &str) -> std::io::Result<T> {
    let bytes = fs::read(path).map_err(|err| {
        std::io::Error::new(
            err.kind(),
            format!("cannot read {label} {}: {err}", path.display()),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|err| {
        std::io::Error::other(format!("cannot parse {label} {}: {err}", path.display()))
    })
}

#[cfg(tokamak_embedded_subcircuit_library)]
fn materialize_embedded_subcircuit_library() -> io::Result<PathBuf> {
    if let Some(path) = MATERIALIZED_PATH.get() {
        return Ok(path.clone());
    }

    let cache_root = cache_root_dir()?
        .join("tokamak-zk-evm")
        .join("subcircuit-library")
        .join(snapshot_directory_name());
    let library_root = cache_root.join("library");
    let sentinel = library_root.join("setupParams.json");
    if !sentinel.exists() {
        fs::create_dir_all(&cache_root)?;
        let staging_root = cache_root.join(format!(
            "staging-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_nanos()
        ));
        let staging_library = staging_root.join("library");
        fs::create_dir_all(&staging_library)?;

        for file in EMBEDDED_SUBCIRCUIT_LIBRARY_FILES {
            let target_path = staging_library.join(file.relative_path);
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(target_path, file.bytes)?;
        }

        match fs::rename(&staging_library, &library_root) {
            Ok(_) => {
                let _ = fs::remove_dir_all(&staging_root);
            }
            Err(err) if library_root.exists() => {
                let _ = fs::remove_dir_all(&staging_root);
                if !sentinel.exists() {
                    return Err(err);
                }
            }
            Err(err) => {
                let _ = fs::remove_dir_all(&staging_root);
                return Err(err);
            }
        }
    }

    let _ = MATERIALIZED_PATH.set(library_root.clone());
    Ok(MATERIALIZED_PATH.get().cloned().unwrap_or(library_root))
}

#[cfg(tokamak_embedded_subcircuit_library)]
fn cache_root_dir() -> io::Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = env::var_os("HOME") {
            return Ok(PathBuf::from(home).join("Library").join("Caches"));
        }
    }

    if let Some(cache_home) = env::var_os("XDG_CACHE_HOME") {
        return Ok(PathBuf::from(cache_home));
    }

    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".cache"));
    }

    Ok(env::temp_dir())
}

#[cfg(tokamak_embedded_subcircuit_library)]
fn snapshot_directory_name() -> String {
    let integrity_fragment: String = SUBCIRCUIT_LIBRARY_INTEGRITY
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!(
        "{}-{}",
        sanitize_component(SUBCIRCUIT_LIBRARY_BUILD_VERSION),
        if integrity_fragment.is_empty() {
            "snapshot".to_string()
        } else {
            integrity_fragment.to_ascii_lowercase()
        }
    )
}

#[cfg(tokamak_embedded_subcircuit_library)]
fn sanitize_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        validate_crs_compatibility, validate_operational_crs_compatibility,
        write_development_only_trusted_setup_provenance, DevelopmentCrsProvenanceArg,
    };
    use crate::crs_provenance::{
        CrsProvenance, FinalMpcCrsProvenance, SubcircuitLibraryProvenance,
    };
    use crate::input_origin::SubcircuitLibraryOrigin;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "tokamak-zk-evm-crs-compatibility-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time must be after Unix epoch")
                .as_nanos(),
            TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ))
    }

    fn write_package_manifest(root: &std::path::Path, version: &str) {
        fs::write(
            root.join("package.json"),
            format!(r#"{{"name":"@tokamak-zk-evm/subcircuit-library","version":"{version}"}}"#),
        )
        .expect("must write package manifest");
    }

    fn write_provenance(
        crs_dir: &std::path::Path,
        release_eligible: bool,
        compatible_version: &str,
    ) {
        let provenance = CrsProvenance::FinalMpcCrs(FinalMpcCrsProvenance {
            release_eligible,
            generated_at_utc: "2026-08-24T00:00:00Z".to_string(),
            compatible_backend_version: compatible_version.to_string(),
            subcircuit_library: SubcircuitLibraryProvenance {
                package_name: "@tokamak-zk-evm/subcircuit-library".to_string(),
                package_version: format!("{compatible_version}.0"),
                origin: SubcircuitLibraryOrigin::LocalQapCompiler,
            },
            phase1_source_provenance: None,
            combined_sigma_sha256: "0".repeat(64),
            sigma_preprocess_sha256: "0".repeat(64),
            sigma_verify_sha256: "0".repeat(64),
        });
        fs::write(
            crs_dir.join(super::CRS_PROVENANCE_FILE_NAME),
            serde_json::to_vec(&provenance).expect("must serialize CRS provenance"),
        )
        .expect("must write CRS provenance");
    }

    fn compiled_backend_compatible_version() -> String {
        crate::compatibility::compatibility_from_package_version(env!("CARGO_PKG_VERSION"))
            .expect("the compiled backend package version must be canonical")
            .to_string()
    }

    fn compiled_backend_package_version() -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    #[test]
    fn rejects_crs_without_compatibility_version() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, compiled_backend_package_version());
        write_development_only_trusted_setup_provenance(&crs_dir)
            .expect("must write trusted setup provenance");

        let error = validate_crs_compatibility(&crs_dir, &library_dir)
            .expect_err("development-only CRS must be rejected without the explicit bypass");
        assert!(error
            .to_string()
            .contains("documentKind must equal finalMpcCrs"));
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn ignores_publication_eligibility_during_compatibility_validation() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, compiled_backend_package_version());

        write_provenance(&crs_dir, false, &compiled_backend_compatible_version());
        validate_crs_compatibility(&crs_dir, &library_dir)
            .expect("non-eligible CRS must be accepted by algorithm workflows");

        write_provenance(&crs_dir, true, &compiled_backend_compatible_version());
        validate_crs_compatibility(&crs_dir, &library_dir)
            .expect("release eligibility must not affect compatibility");
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn validates_crs_against_the_compiled_backend_compatibility_class() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, compiled_backend_package_version());
        let compiled_version = compiled_backend_compatible_version();
        write_provenance(&crs_dir, true, &compiled_version);

        validate_crs_compatibility(&crs_dir, &library_dir)
            .expect("matching CRS and compiled backend compatibility classes must be accepted");

        let mut components = compiled_version.split('.').map(|component| {
            component
                .parse::<u64>()
                .expect("compatibility components are numeric")
        });
        let incompatible_version = format!(
            "{}.{}",
            components.next().expect("major component") + 1,
            components.next().expect("minor component")
        );
        write_provenance(&crs_dir, true, &incompatible_version);
        let error = validate_crs_compatibility(&crs_dir, &library_dir)
            .expect_err("a CRS from another backend release line must be rejected");
        assert!(error
            .to_string()
            .contains("compiled backend compatibility class"));
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn accepts_every_canonical_final_mpc_phase1_variant_at_the_algorithm_boundary() {
        for fixture in [
            include_str!("../../../common/contracts/fixtures/final-mpc-crs-provenance.json"),
            include_str!("../../../common/contracts/fixtures/final-mpc-crs-provenance-native.json"),
            include_str!("../../../common/contracts/fixtures/final-mpc-crs-provenance-null.json"),
        ] {
            let root = test_root();
            let library_dir = root.join("subcircuits").join("library");
            let crs_dir = root.join("crs");
            fs::create_dir_all(&library_dir).expect("must create library directory");
            fs::create_dir_all(&crs_dir).expect("must create CRS directory");
            write_package_manifest(&root, compiled_backend_package_version());
            let mut provenance: serde_json::Value =
                serde_json::from_str(fixture).expect("canonical fixture must be valid JSON");
            provenance["compatibleBackendVersion"] =
                serde_json::Value::String(compiled_backend_compatible_version());
            fs::write(
                crs_dir.join(super::CRS_PROVENANCE_FILE_NAME),
                serde_json::to_vec(&provenance).expect("adjusted fixture must serialize"),
            )
            .expect("must write canonical provenance fixture");

            validate_crs_compatibility(&crs_dir, &library_dir)
                .expect("canonical final MPC fixture must be accepted");
            fs::remove_dir_all(root).expect("must remove test directory");
        }
    }

    #[test]
    fn rejects_the_malformed_final_mpc_fixture_at_the_algorithm_boundary() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, compiled_backend_package_version());
        fs::write(
            crs_dir.join(super::CRS_PROVENANCE_FILE_NAME),
            include_str!(
                "../../../common/contracts/fixtures/final-mpc-crs-provenance-malformed.json"
            ),
        )
        .expect("must write malformed provenance fixture");

        assert!(validate_crs_compatibility(&crs_dir, &library_dir).is_err());
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn rejects_noncanonical_crs_compatibility_versions() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, "2.1.5");
        fs::write(
            crs_dir.join(super::CRS_PROVENANCE_FILE_NAME),
            include_str!(
                "../../../common/contracts/fixtures/final-mpc-crs-provenance-leading-zero.json"
            ),
        )
        .expect("must write leading-zero provenance fixture");

        let error = validate_crs_compatibility(&crs_dir, &library_dir)
            .expect_err("noncanonical compatibility versions must be rejected");
        assert!(error
            .to_string()
            .contains("leading zeroes are not canonical"));
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn rejects_semantically_invalid_final_mpc_fixtures_at_the_algorithm_boundary() {
        let fixtures = [
            include_str!(
                "../../../common/contracts/fixtures/final-mpc-crs-provenance-date-only.json"
            ),
            include_str!(
                "../../../common/contracts/fixtures/final-mpc-crs-provenance-invalid-digest.json"
            ),
            include_str!(
                "../../../common/contracts/fixtures/final-mpc-crs-provenance-empty-string.json"
            ),
            include_str!(
                "../../../common/contracts/fixtures/final-mpc-crs-provenance-invalid-origin.json"
            ),
        ];

        for fixture in fixtures {
            let root = test_root();
            let library_dir = root.join("subcircuits").join("library");
            let crs_dir = root.join("crs");
            fs::create_dir_all(&library_dir).expect("must create library directory");
            fs::create_dir_all(&crs_dir).expect("must create CRS directory");
            write_package_manifest(&root, compiled_backend_package_version());
            fs::write(crs_dir.join(super::CRS_PROVENANCE_FILE_NAME), fixture)
                .expect("must write semantically invalid provenance fixture");

            assert!(validate_crs_compatibility(&crs_dir, &library_dir).is_err());
            fs::remove_dir_all(root).expect("must remove test directory");
        }
    }

    #[test]
    fn rejects_legacy_snake_case_dusk_provenance_at_the_algorithm_boundary() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, compiled_backend_package_version());

        fs::write(
            crs_dir.join(super::CRS_PROVENANCE_FILE_NAME),
            include_str!("../../../common/contracts/fixtures/final-mpc-crs-provenance-legacy.json"),
        )
        .expect("must write legacy provenance");

        assert!(validate_crs_compatibility(&crs_dir, &library_dir).is_err());
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn operational_validation_accepts_a_noneligible_crs_with_matching_compatibility() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, compiled_backend_package_version());
        write_provenance(&crs_dir, false, &compiled_backend_compatible_version());

        validate_operational_crs_compatibility(
            &DevelopmentCrsProvenanceArg::default(),
            &crs_dir,
            &library_dir,
        )
        .expect("non-eligible CRS must be accepted without a bypass");
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[cfg(all(
        feature = "development-crs-bypass",
        not(tokamak_embedded_subcircuit_library)
    ))]
    #[test]
    fn development_opt_in_allows_a_development_only_crs() {
        #[derive(clap::Parser)]
        struct TestConfig {
            #[command(flatten)]
            development: DevelopmentCrsProvenanceArg,
        }

        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_development_only_trusted_setup_provenance(&crs_dir)
            .expect("must write development-only trusted setup provenance");

        let config = <TestConfig as clap::Parser>::try_parse_from([
            "test-command",
            "--allow-unverified-crs",
        ])
        .expect("development opt-in must be accepted");
        assert!(config.development.allows_unverified_crs());
        validate_operational_crs_compatibility(&config.development, &crs_dir, &library_dir)
            .expect("development opt-in must bypass compatibility validation");
        fs::remove_dir_all(root).expect("must remove test directory");
    }
}
