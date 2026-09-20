//! Runtime circuit selection for repository-only MPC execution.
use clap::ValueEnum;
use libs::compatibility::{compatibility_from_package_version, parse_package_version};
use libs::crs_provenance::SubcircuitLibraryProvenance;
use libs::input_origin::SubcircuitLibraryOrigin;
use libs::subcircuit_library::digest_runtime_subcircuit_library;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const PACKAGE: &str = "@tokamak-zk-evm/subcircuit-library";

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub(crate) enum Mode {
    Development,
    Publish,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Publish => "publish",
        }
    }

    pub fn validate(self, version: Option<&str>) -> Result<(), String> {
        match (self, version) {
            (Self::Development, None) => Ok(()),
            (Self::Development, Some(_)) => {
                Err("--library-version is only valid in publish mode".into())
            }
            (Self::Publish, None) => {
                Err("publish mode requires --library-version MAJOR.MINOR.PATCH".into())
            }
            (Self::Publish, Some(version)) => {
                let selected = parse_package_version(version).map_err(|e| e.to_string())?;
                let backend = compatibility_from_package_version(env!("CARGO_PKG_VERSION"))
                    .map_err(|e| e.to_string())?;
                if selected.compatibility_version() != backend {
                    return Err(format!(
                        "library {version} is incompatible with backend class {backend}"
                    ));
                }
                Ok(())
            }
        }
    }
}

pub(crate) fn prepare(
    mode: Mode,
    version: Option<&str>,
    temporary: &Path,
) -> Result<(PathBuf, SubcircuitLibraryProvenance), String> {
    mode.validate(version)?;
    match mode {
        Mode::Development => {
            let qap =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../frontend/qap-compiler");
            let manifest: serde_json::Value = serde_json::from_slice(
                &fs::read(qap.join("package.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let version = manifest["version"]
                .as_str()
                .ok_or("QAP package version is missing")?;
            parse_package_version(version).map_err(|e| e.to_string())?;
            let snapshot = temporary.join("subcircuits");
            copy_local_snapshot(&qap.join("subcircuits"), &snapshot).map_err(|e| {
                format!("cannot copy local QAP build; build qap-compiler first: {e}")
            })?;
            describe(
                snapshot.join("library"),
                version,
                SubcircuitLibraryOrigin::LocalQapCompiler,
            )
        }
        Mode::Publish => {
            let version = version.ok_or("publish mode requires --library-version")?;
            // npm authenticates the registry tarball integrity. Lifecycle scripts
            // are disabled; no repository manifests or node_modules are changed.
            let output = Command::new("npm")
                .args([
                    "install",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--package-lock=false",
                    "--save=false",
                    "--workspaces=false",
                    "--prefix",
                ])
                .arg(temporary)
                .arg(format!("{PACKAGE}@{version}"))
                .current_dir(temporary)
                .output()
                .map_err(|e| format!("cannot run npm: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "npm snapshot acquisition failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            describe_npm(&temporary.join("node_modules").join(PACKAGE), version)
        }
    }
}

fn describe_npm(
    package: &Path,
    version: &str,
) -> Result<(PathBuf, SubcircuitLibraryProvenance), String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(package.join("package.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if manifest["name"].as_str() != Some(PACKAGE) || manifest["version"].as_str() != Some(version) {
        return Err(
            "npm snapshot package identity differs from the requested exact version".into(),
        );
    }
    describe(
        package.join("subcircuits/library"),
        version,
        SubcircuitLibraryOrigin::NpmSnapshot,
    )
}

fn describe(
    path: PathBuf,
    version: &str,
    origin: SubcircuitLibraryOrigin,
) -> Result<(PathBuf, SubcircuitLibraryProvenance), String> {
    let source_digest = digest_runtime_subcircuit_library(&path).map_err(|e| e.to_string())?;
    Ok((
        path,
        SubcircuitLibraryProvenance {
            package_name: PACKAGE.into(),
            package_version: version.into(),
            origin,
            source_digest,
        },
    ))
}

fn copy_local_snapshot(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir(destination)?;
    fs::create_dir(destination.join("circom"))?;
    fs::copy(
        source.join("circom/constants.circom"),
        destination.join("circom/constants.circom"),
    )?;
    let library = destination.join("library");
    fs::create_dir(&library)?;
    for name in [
        "frontendCfg.json",
        "setupParams.json",
        "subcircuitInfo.json",
    ] {
        fs::copy(source.join("library").join(name), library.join(name))?;
    }
    for directory in ["json", "r1cs", "wasm"] {
        fs::create_dir(library.join(directory))?;
        for entry in fs::read_dir(source.join("library").join(directory))? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                return Err(std::io::Error::other(
                    "QAP artifact directory contains a non-file entry",
                ));
            }
            fs::copy(
                entry.path(),
                library.join(directory).join(entry.file_name()),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_requires_an_exact_publish_version_and_forbids_development_override() {
        assert!(Mode::Development.validate(None).is_ok());
        assert!(Mode::Development.validate(Some("2.1.5")).is_err());
        assert!(Mode::Publish.validate(None).is_err());
        assert!(Mode::Publish
            .validate(Some(env!("CARGO_PKG_VERSION")))
            .is_ok());
        for value in ["latest", "^2.1.5", "02.1.5", "file:../library", "999.0.0"] {
            assert!(Mode::Publish.validate(Some(value)).is_err(), "{value}");
        }
    }

    #[test]
    fn local_snapshot_is_private_and_preserves_the_common_digest() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        fs::create_dir_all(source.join("circom")).unwrap();
        fs::create_dir(source.join("library")).unwrap();
        fs::write(source.join("circom/constants.circom"), b"constants").unwrap();
        for name in [
            "frontendCfg.json",
            "setupParams.json",
            "subcircuitInfo.json",
        ] {
            fs::write(source.join("library").join(name), b"{}").unwrap();
        }
        for name in ["json", "r1cs", "wasm"] {
            fs::create_dir(source.join("library").join(name)).unwrap();
            fs::write(source.join("library").join(name).join("artifact"), b"data").unwrap();
        }
        let snapshot = directory.path().join("snapshot");
        copy_local_snapshot(&source, &snapshot).unwrap();
        let (_, provenance) = describe(
            snapshot.join("library"),
            "2.1.5",
            SubcircuitLibraryOrigin::LocalQapCompiler,
        )
        .unwrap();
        assert_eq!(
            provenance.source_digest,
            digest_runtime_subcircuit_library(&source.join("library")).unwrap()
        );
        fs::write(source.join("library/setupParams.json"), b"changed").unwrap();
        assert_eq!(
            fs::read(snapshot.join("library/setupParams.json")).unwrap(),
            b"{}"
        );
        assert_eq!(provenance.origin, SubcircuitLibraryOrigin::LocalQapCompiler);
        fs::write(
            directory.path().join("package.json"),
            br#"{"name":"wrong","version":"2.1.5"}"#,
        )
        .unwrap();
        assert!(describe_npm(directory.path(), "2.1.5")
            .unwrap_err()
            .contains("identity"));
    }
}
