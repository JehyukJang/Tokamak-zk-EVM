use libs::cli::CliDiagnostic;
use libs::errors::{ArtifactError, CrsError, DeviceError};
use std::path::PathBuf;
use thiserror::Error;

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
            Self::WriteOutput { .. } => {
                "Create or grant write access to the requested output directory, then retry."
            }
        }
    }
}
