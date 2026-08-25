use crate::flows::MpcSetupError;
use crate::sigma::{Phase1SourceProvenance, SigmaV2, SubcircuitLibraryOrigin};
use crate::utils::StepTimer;
use crate::versioning::compatible_backend_version;
use chrono::Utc;
use libs::crs_artifacts::write_final_crs_artifacts;
use libs::crs_provenance::{CrsProvenance, FinalMpcCrsProvenance, SubcircuitLibraryProvenance};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

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

    let phase1_source_provenance = latest_acc.phase1_source_provenance.clone();
    let release_eligible = is_release_eligible(phase1_source_provenance.as_ref());
    let subcircuit_library_origin = subcircuit_library_origin_from_build()?;
    let sigma = latest_acc.sigma;
    let output_dir = base_path.join(&config.output);
    let digests =
        write_final_crs_artifacts(&output_dir, &sigma).map_err(|source| MpcSetupError::Io {
            operation: "write final CRS artifacts",
            path: output_dir.clone(),
            source,
        })?;
    timer.log_step("write final CRS artifacts");

    let provenance = CrsProvenance::FinalMpcCrs(FinalMpcCrsProvenance {
        release_eligible,
        generated_at_utc: Utc::now().to_rfc3339(),
        compatible_backend_version: compatible_backend_version().to_string(),
        subcircuit_library: SubcircuitLibraryProvenance {
            package_name: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME").to_string(),
            package_version: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION").to_string(),
            origin: subcircuit_library_origin,
        },
        phase1_source_provenance,
        combined_sigma_sha256: digests.combined_sigma_sha256,
        sigma_preprocess_sha256: digests.sigma_preprocess_sha256,
        sigma_verify_sha256: digests.sigma_verify_sha256,
    });
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

fn is_release_eligible(phase1_source_provenance: Option<&Phase1SourceProvenance>) -> bool {
    matches!(
        phase1_source_provenance,
        Some(Phase1SourceProvenance::DuskGroth16(_))
    )
}

fn subcircuit_library_origin_from_build() -> Result<SubcircuitLibraryOrigin, MpcSetupError> {
    match option_env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_ORIGIN") {
        Some(origin) => {
            SubcircuitLibraryOrigin::from_str(origin).map_err(|error| MpcSetupError::State {
                phase: "phase-2 finalization",
                reason: error.to_string(),
            })
        }
        None => Err(MpcSetupError::State {
            phase: "phase-2 finalization",
            reason: "missing subcircuit-library build origin".to_string(),
        }),
    }
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

#[cfg(test)]
mod tests {
    use super::is_release_eligible;
    use crate::sigma::{DuskSourceProvenance, Phase1SourceProvenance};

    #[test]
    fn release_eligibility_rejects_missing_and_native_sources() {
        assert!(!is_release_eligible(None));
        assert!(!is_release_eligible(Some(&Phase1SourceProvenance::Native)));
    }

    #[test]
    fn release_eligibility_accepts_dusk_backed_sources() {
        let dusk = Phase1SourceProvenance::DuskGroth16(DuskSourceProvenance {
            source_url: "https://example.invalid/dusk.response".to_string(),
            source_size_bytes: 0,
            raw_encoding: "test".to_string(),
            pinned_contribution: "test".to_string(),
            pinned_readme_url: "https://example.invalid/readme".to_string(),
            pinned_drive_file_id: "test".to_string(),
            expected_source_sha256: "test".to_string(),
            actual_source_sha256: "test".to_string(),
            auto_downloaded: false,
            downloaded_contribution: None,
            downloaded_readme_url: None,
            downloaded_drive_file_id: None,
            max_g1_exp_used: 0,
            max_g2_exp_used: 0,
            transcript_consistency_verified: true,
        });

        assert!(is_release_eligible(Some(&dusk)));
    }
}
