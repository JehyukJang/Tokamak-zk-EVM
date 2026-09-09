use libs::cli::CliDiagnostic;
use libs::errors::{ArtifactError, CrsError, DeviceError};
use libs::univariate_crs::UnivariateCrsError;
use std::path::PathBuf;
use thiserror::Error;

mod execution;
mod univariate;

pub use execution::{run_trusted_setup, TrustedSetupConfig};

pub struct SetupInputPaths<'a> {
    pub qap_path: &'a str,
    pub output_path: &'a str,
    #[cfg(feature = "testing-mode")]
    pub synthesizer_path: &'a str,
}

#[derive(Debug, Error)]
pub enum TrustedSetupError {
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    Crs(#[from] CrsError),
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error(transparent)]
    UnivariateCrs(#[from] UnivariateCrsError),
    #[error("failed to write final CRS artifact at {}: {source}", path.display())]
    WriteOutput {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl CliDiagnostic for TrustedSetupError {
    fn hint(&self) -> &'static str {
        match self {
            Self::Artifact(_) => {
                "Regenerate the frontend artifacts and provide the matching subcircuit library."
            }
            Self::Crs(_) => "Check the selected subcircuit library and CRS output path.",
            Self::Device(_) => "Check the ICICLE backend installation and the selected device.",
            Self::UnivariateCrs(_) => {
                "Check the selected library's univariate domain requirements and regenerate the CRS."
            }
            Self::WriteOutput { .. } => {
                "Create or grant write access to the requested output directory, then retry."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        execution::ensure_output_directory, run_trusted_setup, TrustedSetupConfig,
        TrustedSetupError,
    };
    use std::fs;

    #[test]
    fn library_api_rejects_a_missing_qap_before_device_initialization() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let missing_qap = workspace.path().join("missing-qap");
        let output = workspace.path().join("output");
        let qap_path = missing_qap.to_string_lossy();
        let output_path = output.to_string_lossy();
        let config = TrustedSetupConfig {
            qap_path: &qap_path,
            output_path: &output_path,
            fixed_tau: false,
            #[cfg(feature = "testing-mode")]
            synthesizer_path: &qap_path,
        };

        let error = run_trusted_setup(&config).expect_err("missing QAP must fail");

        assert!(matches!(error, TrustedSetupError::Artifact(_)));
        assert!(!output.exists());
    }

    #[test]
    fn output_directory_error_is_reported_by_the_library_boundary() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let output_file = workspace.path().join("not-a-directory");
        fs::write(&output_file, "not a directory").expect("must create output file");

        let error = ensure_output_directory(&output_file)
            .expect_err("an existing file must not be accepted as an output directory");

        assert!(matches!(error, TrustedSetupError::WriteOutput { .. }));
    }

    #[test]
    fn trusted_setup_provenance_is_never_release_eligible() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        libs::subcircuit_library::write_development_only_trusted_setup_provenance(workspace.path())
            .expect("must write trusted-setup provenance");
        let provenance: serde_json::Value = serde_json::from_slice(
            &fs::read(workspace.path().join("crs_provenance.json"))
                .expect("must read trusted-setup provenance"),
        )
        .expect("must parse trusted-setup provenance");

        assert_eq!(provenance["documentKind"], "developmentTrustedSetupSigma");
        assert_eq!(provenance["releaseEligible"], false);
    }

    #[test]
    fn univariate_trusted_setup_provenance_identifies_its_artifact_family() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        libs::subcircuit_library::write_development_only_univariate_crs_provenance(
            workspace.path(),
            &libs::crs_artifacts::UnivariateCrsDigests {
                tau_sequence_sha256: "0".repeat(64),
                prover_keys_sha256: "1".repeat(64),
                verifier_keys_sha256: "2".repeat(64),
            },
        )
        .expect("must write univariate trusted-setup provenance");
        let provenance: serde_json::Value = serde_json::from_slice(
            &fs::read(workspace.path().join("crs_provenance.json"))
                .expect("must read univariate provenance"),
        )
        .expect("must parse univariate provenance");

        assert_eq!(
            provenance["documentKind"],
            "developmentTrustedSetupUnivariateCrs"
        );
        assert_eq!(provenance["tauSequenceRkyvSha256"], "0".repeat(64));
        assert_eq!(provenance["proverKeysRkyvSha256"], "1".repeat(64));
        assert_eq!(provenance["verifierKeysRkyvSha256"], "2".repeat(64));
        assert_eq!(provenance["protocolSchemaId"], "tokamak-zk-evm-univariate");
        assert_eq!(provenance["releaseEligible"], false);
    }
}
