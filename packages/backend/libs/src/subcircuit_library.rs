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
const CRS_PROVENANCE_FILE_NAME: &str = "crs_provenance.json";
const RELEASE_ELIGIBLE_FIELD: &str = "releaseEligible";

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

pub fn resolve_subcircuit_library_path(local_path: Option<&str>) -> PathBuf {
    try_resolve_subcircuit_library_path(local_path).unwrap_or_else(|error| panic!("{error}"))
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
    let provenance = read_json(&provenance_path, "CRS provenance")?;
    let crs_compatible_version = provenance
        .get("compatibleBackendVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            std::io::Error::other(format!(
                "{} is missing compatibleBackendVersion",
                provenance_path.display()
            ))
        })?;
    let crs_compatible_version = normalize_compatible_version(
        crs_compatible_version,
        "CRS provenance compatibleBackendVersion",
    )?;
    let library_version = selected_library_package_version(library_dir)?;
    let library_compatible_version =
        package_compatible_version(&library_version, "subcircuit-library package version")?;

    if crs_compatible_version != library_compatible_version {
        return Err(std::io::Error::other(format!(
            "CRS compatibility version {} does not match subcircuit-library package version {} (compatibility class {})",
            crs_compatible_version, library_version, library_compatible_version
        )));
    }

    Ok(())
}

pub fn write_development_only_trusted_setup_provenance(output_dir: &Path) -> std::io::Result<()> {
    let provenance = serde_json::json!({
        "producer": "trusted-setup",
        RELEASE_ELIGIBLE_FIELD: false,
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
                let manifest = read_json(&manifest_path, "subcircuit-library package manifest")?;
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

fn read_json(path: &Path, label: &str) -> std::io::Result<serde_json::Value> {
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

fn normalize_compatible_version(value: &str, label: &str) -> std::io::Result<String> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 2
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return Err(std::io::Error::other(format!(
            "{label} must be strict MAJOR.MINOR, got {value:?}"
        )));
    }
    let major = parts[0]
        .parse::<u64>()
        .map_err(|err| std::io::Error::other(format!("{label} major version is invalid: {err}")))?;
    let minor = parts[1]
        .parse::<u64>()
        .map_err(|err| std::io::Error::other(format!("{label} minor version is invalid: {err}")))?;
    Ok(format!("{major}.{minor}"))
}

fn package_compatible_version(value: &str, label: &str) -> std::io::Result<String> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return Err(std::io::Error::other(format!(
            "{label} must be strict MAJOR.MINOR.PATCH, got {value:?}"
        )));
    }
    let major = parts[0]
        .parse::<u64>()
        .map_err(|err| std::io::Error::other(format!("{label} major version is invalid: {err}")))?;
    let minor = parts[1]
        .parse::<u64>()
        .map_err(|err| std::io::Error::other(format!("{label} minor version is invalid: {err}")))?;
    parts[2]
        .parse::<u64>()
        .map_err(|err| std::io::Error::other(format!("{label} patch version is invalid: {err}")))?;
    Ok(format!("{major}.{minor}"))
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
    use std::fs;
    use std::path::PathBuf;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "tokamak-zk-evm-crs-compatibility-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time must be after Unix epoch")
                .as_nanos()
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
        release_eligible: serde_json::Value,
        compatible_version: &str,
    ) {
        fs::write(
            crs_dir.join(super::CRS_PROVENANCE_FILE_NAME),
            serde_json::json!({
                "releaseEligible": release_eligible,
                "compatibleBackendVersion": compatible_version,
            })
            .to_string(),
        )
        .expect("must write CRS provenance");
    }

    #[test]
    fn rejects_crs_without_compatibility_version() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, "3.0.0");
        write_development_only_trusted_setup_provenance(&crs_dir)
            .expect("must write trusted setup provenance");

        let error = validate_crs_compatibility(&crs_dir, &library_dir)
            .expect_err("CRS without a compatibility version must be rejected");
        assert!(error.to_string().contains("compatibleBackendVersion"));
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn ignores_publication_eligibility_during_compatibility_validation() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, "3.0.0");

        write_provenance(&crs_dir, serde_json::Value::Bool(false), "3.0");
        validate_crs_compatibility(&crs_dir, &library_dir)
            .expect("non-eligible CRS must be accepted by algorithm workflows");

        write_provenance(
            &crs_dir,
            serde_json::Value::String("not-a-publication-flag".to_string()),
            "3.0",
        );
        validate_crs_compatibility(&crs_dir, &library_dir)
            .expect("publication eligibility encoding must not affect compatibility");
        fs::remove_dir_all(root).expect("must remove test directory");
    }

    #[test]
    fn validates_crs_against_library_compatibility_class() {
        let root = test_root();
        let library_dir = root.join("subcircuits").join("library");
        let crs_dir = root.join("crs");
        fs::create_dir_all(&library_dir).expect("must create library directory");
        fs::create_dir_all(&crs_dir).expect("must create CRS directory");
        write_package_manifest(&root, "2.1.7");
        write_provenance(&crs_dir, serde_json::Value::Bool(true), "2.1");

        validate_crs_compatibility(&crs_dir, &library_dir)
            .expect("matching CRS and library compatibility classes must be accepted");

        write_provenance(&crs_dir, serde_json::Value::Bool(true), "3.0");
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
        write_package_manifest(&root, "3.0.0");
        write_provenance(&crs_dir, serde_json::Value::Bool(false), "3.0");

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
