use crate::flows::MpcSetupError;
use crate::sigma::{FinalCrsProvenance, SigmaV2, SubcircuitLibraryProvenance};
use crate::utils::StepTimer;
use crate::versioning::compatible_backend_version;
use chrono::Utc;
use libs::iotools::write_final_crs_artifacts;
use std::env;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Phase2GenFilesConfig {
    pub intermediate: String,
    pub output: String,
    pub contributor_index: usize,
}

pub fn run(config: &Phase2GenFilesConfig) -> Result<(), MpcSetupError> {
    let mut timer = StepTimer::new("phase2_gen_files");
    let base_path = env::current_dir().map_err(|source| MpcSetupError::Io {
        operation: "resolve current directory",
        path: PathBuf::from("."),
        source,
    })?;
    let start = std::time::Instant::now();
    let latest_acc = load_phase2_accumulator(&config.intermediate, config.contributor_index)?;
    timer.log_step("load latest phase-2 accumulator");

    let sigma = latest_acc.sigma;
    let output_dir = base_path.join(&config.output);
    let digests =
        write_final_crs_artifacts(&output_dir, &sigma).map_err(|source| MpcSetupError::Io {
            operation: "write final CRS artifacts",
            path: output_dir.clone(),
            source,
        })?;
    timer.log_step("write final CRS artifacts");

    let provenance = FinalCrsProvenance {
        release_eligible: true,
        generated_at_utc: Utc::now().to_rfc3339(),
        compatible_backend_version: compatible_backend_version().to_string(),
        subcircuit_library: SubcircuitLibraryProvenance {
            package_name: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME").to_string(),
            package_version: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION").to_string(),
        },
        phase1_source_provenance: latest_acc.phase1_source_provenance,
        combined_sigma_sha256: digests.combined_sigma_sha256,
        sigma_preprocess_sha256: digests.sigma_preprocess_sha256,
        sigma_verify_sha256: digests.sigma_verify_sha256,
        published_folder_url: None,
        published_archive_name: None,
        crs_download_url: None,
    };
    let bytes = serde_json::to_vec_pretty(&provenance).map_err(|error| MpcSetupError::State {
        phase: "phase-2 finalization",
        reason: format!("cannot serialize CRS provenance: {error}"),
    })?;
    let provenance_path = output_dir.join("crs_provenance.json");
    fs::write(&provenance_path, bytes).map_err(|source| MpcSetupError::Io {
        operation: "write CRS provenance",
        path: provenance_path,
        source,
    })?;
    timer.log_step("write CRS provenance");

    let lap = start.elapsed();
    println!("The sigma writing time: {:.6} seconds", lap.as_secs_f64());
    timer.log_total();
    Ok(())
}

fn load_phase2_accumulator(
    outfolder: &str,
    contributor_index: usize,
) -> Result<SigmaV2, MpcSetupError> {
    let path = PathBuf::from(format!(
        "{}/phase2_acc_{}.rkyv",
        outfolder, contributor_index
    ));
    SigmaV2::read_phase2_acc(path.to_string_lossy().as_ref()).map_err(|source| MpcSetupError::Io {
        operation: "read phase-2 accumulator",
        path,
        source,
    })
}
