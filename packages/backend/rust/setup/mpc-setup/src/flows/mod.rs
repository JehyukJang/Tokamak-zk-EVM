use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

use crate::drive_upload::{preflight_drive_upload, publish_output_archive, DriveUploadError};
use libs::cli::CliDiagnostic;
use libs::errors::ArtifactError;
use libs::errors::CrsError;
use libs::errors::DeviceError;

#[derive(Debug, Error)]
pub enum MpcSetupError {
    #[error("failed to {operation} at {}: {source}", path.display())]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid MPC state during {phase}: {reason}")]
    State { phase: &'static str, reason: String },
    #[error("production Dusk MPC preflight failed: {reason}")]
    ProductionPreflight { reason: String },
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    Crs(#[from] CrsError),
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error(transparent)]
    Publication(#[from] DriveUploadError),
    #[error(transparent)]
    CeremonyWorkspace(#[from] crate::ceremony_workspace::CeremonyWorkspaceError),
    #[error(transparent)]
    Transcript(#[from] crate::transcript::TranscriptError),
    #[error(transparent)]
    StateBundle(#[from] crate::state_bundle::StateBundleError),
    #[error(transparent)]
    Protocol(#[from] crate::protocol::ProtocolError),
}

impl CliDiagnostic for MpcSetupError {
    fn hint(&self) -> &'static str {
        match self {
            Self::Io { .. } => {
                "Check the QAP, intermediate, and output paths and their read/write permissions."
            }
            Self::State { .. } => {
                "Use a complete, matching ceremony intermediate directory and retry from its required phase."
            }
            Self::ProductionPreflight { .. } => {
                "Build the composite command with the production npm feature and configure Google Drive publication before retrying."
            }
            Self::Artifact(_) => {
                "Regenerate or select the matching QAP artifacts before restarting the ceremony."
            }
            Self::Crs(_) => "Check the selected local subcircuit library path.",
            Self::Device(_) => "Check the ICICLE backend installation and selected device.",
            Self::Publication(_) => {
                "Check release metadata and Drive publication configuration before retrying publication."
            }
            Self::CeremonyWorkspace(_)
            | Self::Transcript(_)
            | Self::StateBundle(_)
            | Self::Protocol(_) => {
                "Use a complete verified two-phase ceremony workspace and reject legacy intermediates."
            }
        }
    }
}

pub mod final_artifacts;
pub mod qap_circuit;

#[derive(Debug, Clone)]
pub struct NativeMpcSetupConfig {
    pub qap_path: String,
    pub intermediate: String,
    pub output: String,
    pub beacon_mode: bool,
    pub seed_input: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DuskBackedMpcSetupConfig {
    pub qap_path: String,
    pub intermediate: String,
    pub output: String,
    pub beacon_mode: bool,
    pub seed_input: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DuskPublicationConfig {
    pub intermediate: String,
    pub output: String,
}

pub fn run_native_mpc_setup(config: &NativeMpcSetupConfig) -> Result<(), MpcSetupError> {
    let qap_path = canonicalize_existing_path(&config.qap_path)?;
    run_two_phase_single_contributor(
        &qap_path,
        Path::new(&config.intermediate),
        Path::new(&config.output),
        config.beacon_mode,
        config.seed_input.as_deref(),
        CeremonyRoute::Native,
    )
}

pub fn run_dusk_backed_mpc_setup(config: &DuskBackedMpcSetupConfig) -> Result<(), MpcSetupError> {
    preflight_composite_dusk_production()?;
    run_dusk_backed_ceremony(config)?;
    run_dusk_backed_publication(&DuskPublicationConfig {
        intermediate: config.intermediate.clone(),
        output: config.output.clone(),
    })
}

fn preflight_composite_dusk_production() -> Result<(), MpcSetupError> {
    ensure_composite_dusk_build_policy()?;
    preflight_drive_upload()?;
    Ok(())
}

#[cfg(all(tokamak_release_profile, tokamak_production_npm_subcircuit_library))]
fn ensure_composite_dusk_build_policy() -> Result<(), MpcSetupError> {
    Ok(())
}

#[cfg(not(all(tokamak_release_profile, tokamak_production_npm_subcircuit_library)))]
fn ensure_composite_dusk_build_policy() -> Result<(), MpcSetupError> {
    Err(MpcSetupError::ProductionPreflight {
        reason: "the composite `run` command requires a release build with the production-npm-subcircuit-library feature".to_string(),
    })
}

pub fn run_dusk_backed_ceremony(config: &DuskBackedMpcSetupConfig) -> Result<(), MpcSetupError> {
    let qap_path = canonicalize_existing_path(&config.qap_path)?;
    run_two_phase_single_contributor(
        &qap_path,
        Path::new(&config.intermediate),
        Path::new(&config.output),
        config.beacon_mode,
        config.seed_input.as_deref(),
        CeremonyRoute::Dusk,
    )
}

pub fn run_dusk_backed_publication(config: &DuskPublicationConfig) -> Result<(), MpcSetupError> {
    let upload_config = preflight_drive_upload()?;
    let upload_result =
        publish_output_archive(&upload_config, &config.intermediate, &config.output)?;
    println!(
        "Uploaded dusk-backed CRS archive {}\nDrive folder: {}\nDownload URL: {}",
        upload_result.archive_name, upload_result.folder_url, upload_result.crs_download_url
    );
    Ok(())
}

#[derive(Clone, Copy)]
enum CeremonyRoute {
    Native,
    Dusk,
}

fn run_two_phase_single_contributor(
    qap_path: &Path,
    intermediate: &Path,
    output: &Path,
    beacon_mode: bool,
    master_seed_input: Option<&str>,
    route: CeremonyRoute,
) -> Result<(), MpcSetupError> {
    if beacon_mode && master_seed_input.is_none() {
        return Err(MpcSetupError::State {
            phase: "two-phase ceremony preflight",
            reason: "beacon mode requires seed input and remains non-qualifying".to_string(),
        });
    }
    fs::create_dir_all(intermediate).map_err(|source| MpcSetupError::Io {
        operation: "create intermediate directory",
        path: intermediate.to_path_buf(),
        source,
    })?;
    let workspace = intermediate.join("ceremony-workspace");
    let staging = tempfile::Builder::new()
        .prefix(".two-phase-staging-")
        .tempdir_in(intermediate)
        .map_err(|source| MpcSetupError::Io {
            operation: "create ceremony staging directory",
            path: intermediate.to_path_buf(),
            source,
        })?;
    let ceremony_id = format!(
        "tokamak-{}-{}-{}",
        match route {
            CeremonyRoute::Native => "native",
            CeremonyRoute::Dusk => "dusk",
        },
        chrono::Utc::now().timestamp_micros(),
        std::process::id()
    );
    let initial = staging.path().join("phase1-initial");
    let adapted_tau = match route {
        CeremonyRoute::Native => {
            crate::operator::initialize_native(&ceremony_id, qap_path, &initial)
                .map_err(operator_state_error)?;
            None
        }
        CeremonyRoute::Dusk => {
            let adapted = intermediate.join("adapted-tau");
            let raw = intermediate.join("dusk.response");
            crate::operator::adapt_dusk(qap_path, &raw, &adapted).map_err(operator_state_error)?;
            crate::operator::prepare_dusk_phase1(&ceremony_id, qap_path, &adapted, &initial)
                .map_err(operator_state_error)?;
            Some(adapted)
        }
    };
    crate::ceremony_workspace::initialize_workspace(&workspace, &initial)?;

    let phase1_contributed = staging.path().join("phase1-contributed");
    crate::participant::run_contribute(&crate::participant::ContributeConfig {
        expected_phase: crate::protocol::Phase::Phase1,
        input: initial,
        output: phase1_contributed.clone(),
        seed_input: derive_stage_seed_input(master_seed_input, "phase1-contribution"),
        beacon_mode,
    })
    .map_err(participant_state_error)?;
    crate::ceremony_workspace::append_bundle(&workspace, &phase1_contributed)?;

    let phase2_prepared = staging.path().join("phase2-prepared");
    crate::operator::prepare_circuit(&workspace, qap_path, &phase2_prepared)
        .map_err(operator_state_error)?;
    crate::ceremony_workspace::append_bundle(&workspace, &phase2_prepared)?;

    let phase2_contributed = staging.path().join("phase2-contributed");
    crate::participant::run_contribute(&crate::participant::ContributeConfig {
        expected_phase: crate::protocol::Phase::Phase2,
        input: phase2_prepared,
        output: phase2_contributed.clone(),
        seed_input: derive_stage_seed_input(master_seed_input, "phase2-contribution"),
        beacon_mode,
    })
    .map_err(participant_state_error)?;
    crate::ceremony_workspace::append_bundle(&workspace, &phase2_contributed)?;

    final_artifacts::run_two_phase(&final_artifacts::TwoPhaseFinalConfig {
        workspace,
        output: output.to_path_buf(),
        adapted_tau,
    })
}

fn operator_state_error(error: crate::operator::OperatorError) -> MpcSetupError {
    MpcSetupError::State {
        phase: "two-phase operator action",
        reason: error.to_string(),
    }
}

fn participant_state_error(error: crate::participant::ParticipantError) -> MpcSetupError {
    MpcSetupError::State {
        phase: "two-phase participant action",
        reason: error.to_string(),
    }
}

fn derive_stage_seed_input(master_seed_input: Option<&str>, stage: &str) -> Option<String> {
    master_seed_input.map(|seed| format!("{seed}:{stage}"))
}

fn canonicalize_existing_path(path: &str) -> Result<PathBuf, MpcSetupError> {
    fs::canonicalize(path).map_err(|source| MpcSetupError::Io {
        operation: "resolve QAP path",
        path: PathBuf::from(path),
        source,
    })
}

#[cfg(test)]
mod tests {
    #[cfg(not(all(tokamak_release_profile, tokamak_production_npm_subcircuit_library)))]
    use super::run_dusk_backed_mpc_setup;
    use super::{
        ensure_composite_dusk_build_policy, run_dusk_backed_ceremony, run_native_mpc_setup,
        DuskBackedMpcSetupConfig, MpcSetupError, NativeMpcSetupConfig,
    };

    #[test]
    fn native_setup_rejects_an_absent_qap_path_before_creating_output() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let output = workspace.path().join("output");
        let intermediate = workspace.path().join("intermediate");
        let missing_qap = workspace.path().join("missing-qap");
        let config = NativeMpcSetupConfig {
            qap_path: missing_qap.to_string_lossy().into_owned(),
            intermediate: intermediate.to_string_lossy().into_owned(),
            output: output.to_string_lossy().into_owned(),
            beacon_mode: false,
            seed_input: None,
        };

        let error = run_native_mpc_setup(&config).expect_err("missing QAP must fail");
        assert!(matches!(error, MpcSetupError::Io { .. }));
        assert!(!output.exists());
        assert!(!intermediate.exists());
    }

    #[test]
    fn dusk_ceremony_rejects_an_absent_qap_path_before_creating_output() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let output = workspace.path().join("output");
        let intermediate = workspace.path().join("intermediate");
        let missing_qap = workspace.path().join("missing-qap");
        let config = DuskBackedMpcSetupConfig {
            qap_path: missing_qap.to_string_lossy().into_owned(),
            intermediate: intermediate.to_string_lossy().into_owned(),
            output: output.to_string_lossy().into_owned(),
            beacon_mode: false,
            seed_input: None,
        };

        let error = run_dusk_backed_ceremony(&config).expect_err("missing QAP must fail");
        assert!(matches!(error, MpcSetupError::Io { .. }));
        assert!(!output.exists());
        assert!(!intermediate.exists());
    }

    #[cfg(not(all(tokamak_release_profile, tokamak_production_npm_subcircuit_library)))]
    #[test]
    fn dusk_composite_rejects_a_local_build_before_creating_ceremony_state() {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let output = workspace.path().join("output");
        let intermediate = workspace.path().join("intermediate");
        let config = DuskBackedMpcSetupConfig {
            qap_path: workspace
                .path()
                .join("missing-qap")
                .to_string_lossy()
                .into_owned(),
            intermediate: intermediate.to_string_lossy().into_owned(),
            output: output.to_string_lossy().into_owned(),
            beacon_mode: false,
            seed_input: None,
        };

        let error = run_dusk_backed_mpc_setup(&config)
            .expect_err("the composite command must reject a local build before ceremony work");
        assert!(matches!(error, MpcSetupError::ProductionPreflight { .. }));
        assert!(!output.exists());
        assert!(!intermediate.exists());
    }

    #[test]
    fn composite_dusk_build_policy_matches_compilation_mode() {
        #[cfg(all(tokamak_release_profile, tokamak_production_npm_subcircuit_library))]
        assert!(ensure_composite_dusk_build_policy().is_ok());

        #[cfg(not(all(tokamak_release_profile, tokamak_production_npm_subcircuit_library)))]
        assert!(matches!(
            ensure_composite_dusk_build_policy(),
            Err(MpcSetupError::ProductionPreflight { .. })
        ));
    }
}
