use std::fs;
use std::path::PathBuf;
use thiserror::Error;

use crate::drive_upload::{preflight_drive_upload, publish_output_archive, DriveUploadError};
use crate::flows::phase1_next_contributor::ContributorError;
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
    #[error(transparent)]
    Contributor(#[from] ContributorError),
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    Crs(#[from] CrsError),
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error(transparent)]
    Publication(#[from] DriveUploadError),
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
            Self::Contributor(_) => {
                "Inspect the previous ceremony contribution and its artifact files before retrying."
            }
            Self::Artifact(_) => {
                "Regenerate or select the matching QAP artifacts before restarting the ceremony."
            }
            Self::Crs(_) => "Check the selected local subcircuit library path.",
            Self::Device(_) => "Check the ICICLE backend installation and selected device.",
            Self::Publication(_) => {
                "Check release metadata and Drive publication configuration before retrying publication."
            }
        }
    }
}

pub mod phase1_initialize;
pub mod phase1_next_contributor;
pub mod phase2_gen_files;
pub mod phase2_next_contributor;
pub mod phase2_prepare;

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
    ensure_directory(&config.output)?;
    ensure_directory(&config.intermediate)?;

    phase1_initialize::run(&phase1_initialize::Phase1InitializeConfig {
        qap_path: qap_path.clone(),
        setup_params_file: "setupParams.json".to_string(),
        outfolder: config.intermediate.clone(),
    })?;

    phase1_next_contributor::run(&phase1_next_contributor::Phase1NextContributorConfig {
        outfolder: config.intermediate.clone(),
        beacon_mode: config.beacon_mode,
        contributor_index: 1,
        random_seed_input: derive_stage_seed_input(config.seed_input.as_deref(), "phase1-next"),
    })?;

    run_single_contributor_phase2(
        &config.intermediate,
        &config.output,
        config.beacon_mode,
        Phase2SourceConfig::Native {
            qap_path: qap_path.clone(),
        },
        config.seed_input.as_deref(),
    )
}

pub fn run_dusk_backed_mpc_setup(config: &DuskBackedMpcSetupConfig) -> Result<(), MpcSetupError> {
    run_dusk_backed_ceremony(config)?;
    run_dusk_backed_publication(&DuskPublicationConfig {
        intermediate: config.intermediate.clone(),
        output: config.output.clone(),
    })
}

pub fn run_dusk_backed_ceremony(config: &DuskBackedMpcSetupConfig) -> Result<(), MpcSetupError> {
    let qap_path = canonicalize_existing_path(&config.qap_path)?;
    ensure_directory(&config.output)?;
    ensure_directory(&config.intermediate)?;
    let dusk_raw_file = format!("{}/dusk.response", config.intermediate);

    run_single_contributor_phase2(
        &config.intermediate,
        &config.output,
        config.beacon_mode,
        Phase2SourceConfig::DuskGroth16 {
            qap_path,
            dusk_raw_file,
        },
        config.seed_input.as_deref(),
    )
}

pub fn run_dusk_backed_publication(config: &DuskPublicationConfig) -> Result<(), MpcSetupError> {
    let upload_config = preflight_drive_upload()?;
    let upload_result =
        publish_output_archive(&upload_config, &config.intermediate, &config.output)?;
    println!(
        "Uploaded dusk-backed CRS archive {} to {}",
        upload_result.archive_name, upload_result.folder_url
    );
    Ok(())
}

enum Phase2SourceConfig {
    Native {
        qap_path: PathBuf,
    },
    DuskGroth16 {
        qap_path: PathBuf,
        dusk_raw_file: String,
    },
}

fn run_single_contributor_phase2(
    intermediate: &str,
    output: &str,
    beacon_mode: bool,
    source: Phase2SourceConfig,
    master_seed_input: Option<&str>,
) -> Result<(), MpcSetupError> {
    let (qap_path, phase1_source_mode, dusk_raw_file, prepare_contributor_index) = match source {
        Phase2SourceConfig::Native { qap_path } => {
            (qap_path, phase2_prepare::Phase1SourceMode::Native, None, 1)
        }
        Phase2SourceConfig::DuskGroth16 {
            qap_path,
            dusk_raw_file,
        } => (
            qap_path,
            phase2_prepare::Phase1SourceMode::DuskGroth16,
            Some(dusk_raw_file),
            0,
        ),
    };

    phase2_prepare::run(&phase2_prepare::Phase2PrepareConfig {
        qap_path,
        outfolder: intermediate.to_string(),
        contributor_index: prepare_contributor_index,
        is_checking: false,
        part_no: 0,
        total_part: 1,
        merge_parts: false,
        beacon_mode,
        phase1_source_mode,
        dusk_raw_file,
        y_hex: None,
        random_seed_input: derive_stage_seed_input(master_seed_input, "phase2-prepare"),
    })?;

    phase2_next_contributor::run(&phase2_next_contributor::Phase2NextContributorConfig {
        outfolder: intermediate.to_string(),
        beacon_mode,
        contributor_index: 1,
        random_seed_input: derive_stage_seed_input(master_seed_input, "phase2-next"),
    })?;

    phase2_gen_files::run(&phase2_gen_files::Phase2GenFilesConfig {
        intermediate: intermediate.to_string(),
        output: output.to_string(),
        contributor_index: 1,
    })
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

fn ensure_directory(path: &str) -> Result<(), MpcSetupError> {
    fs::create_dir_all(path).map_err(|source| MpcSetupError::Io {
        operation: "create directory",
        path: PathBuf::from(path),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        run_dusk_backed_ceremony, run_dusk_backed_mpc_setup, run_native_mpc_setup,
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

    #[test]
    fn dusk_composite_runs_ceremony_before_publication() {
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
            .expect_err("the ceremony must reject the missing QAP before publication");
        assert!(matches!(error, MpcSetupError::Io { .. }));
        assert!(!output.exists());
        assert!(!intermediate.exists());
    }
}
