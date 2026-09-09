use libs::cli::CliDiagnostic;
use libs::errors::{ArtifactError, CrsError, DeviceError};
use libs::univariate_crs::UnivariateCrsError;
use std::path::PathBuf;
use thiserror::Error;

mod execution;
mod univariate;

pub use univariate::{
    run_generate_tau_sequence, run_specialize_library, GenerateTauSequenceConfig,
    SpecializeLibraryConfig,
};

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
        execution::ensure_output_directory, run_generate_tau_sequence, GenerateTauSequenceConfig,
        TrustedSetupError,
    };
    use libs::univariate_crs::UnivariateTauCapacity;
    use std::fs;

    #[test]
    fn stage_one_runs_without_a_subcircuit_library() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let output = workspace.path().join("output");
        let output_path = output.to_string_lossy();
        let config = GenerateTauSequenceConfig {
            capacity: UnivariateTauCapacity {
                l0: 4,
                l_xi: 4,
                l_psi: 4,
                l2: 4,
            },
            output_path: &output_path,
            fixed_tau: true,
        };

        run_generate_tau_sequence(&config).expect("stage one must run independently");

        assert!(output.join("tau_sequence.rkyv").is_file());
        assert!(output.join("crs_provenance.json").is_file());
        assert!(!output.join("prover_keys.rkyv").exists());
        assert!(!output.join("verifier_keys.rkyv").exists());
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
        libs::subcircuit_library::write_development_only_univariate_tau_provenance(
            workspace.path(),
            UnivariateTauCapacity {
                l0: 1,
                l_xi: 2,
                l_psi: 3,
                l2: 4,
            },
            &"0".repeat(64),
        )
        .expect("must write univariate trusted-setup provenance");
        let provenance: serde_json::Value = serde_json::from_slice(
            &fs::read(workspace.path().join("crs_provenance.json"))
                .expect("must read univariate provenance"),
        )
        .expect("must parse univariate provenance");

        assert_eq!(
            provenance["documentKind"],
            "developmentTrustedSetupUnivariateTauSequence"
        );
        assert_eq!(provenance["tauSequenceRkyvSha256"], "0".repeat(64));
        assert_eq!(provenance["terminalCapacity"]["l0"], 1);
        assert_eq!(provenance["terminalCapacity"]["lXi"], 2);
        assert_eq!(provenance["terminalCapacity"]["lPsi"], 3);
        assert_eq!(provenance["terminalCapacity"]["l2"], 4);
        assert_eq!(provenance["protocolSchemaId"], "tokamak-zk-evm-univariate");
        assert_eq!(provenance["releaseEligible"], false);
    }
}
