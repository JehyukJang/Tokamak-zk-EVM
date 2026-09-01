//! Final CRS construction from a verified two-phase ceremony workspace.

use crate::flows::MpcSetupError;
use crate::phase2_circuit::CircuitSigmaPoints;
use crate::protocol::{validate_state_selection, Phase, SourceProvenance, PROTOCOL_VERSION};
use crate::state_bundle::StateArtifact;
use crate::transcript::CeremonyTranscript;
use crate::versioning::compatible_backend_version;
use chrono::Utc;
use libs::crs_artifacts::{stage_final_crs_artifacts, FinalCrsDigests};
use libs::crs_provenance::{
    parse_final_mpc_crs_provenance, validate_final_mpc_crs_provenance, CrsProvenance,
    FinalMpcCrsProvenance, Phase1SourceProvenance, SubcircuitLibraryProvenance,
};
use libs::input_origin::SubcircuitLibraryOrigin;
use std::env;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::str::FromStr;

#[derive(Debug, Clone)]
pub struct TwoPhaseFinalConfig {
    pub workspace: PathBuf,
    pub output: PathBuf,
    pub adapted_tau: Option<PathBuf>,
}

pub fn run_two_phase(config: &TwoPhaseFinalConfig) -> Result<(), MpcSetupError> {
    let adapted_tau = config
        .adapted_tau
        .as_ref()
        .map(|path| {
            crate::alpha_x_basis::verify_adapted_tau_bundle(path).map_err(|source| {
                MpcSetupError::Io {
                    operation: "verify adapted tau bundle",
                    path: path.clone(),
                    source,
                }
            })
        })
        .transpose()?;
    let transcript = CeremonyTranscript::build(&config.workspace, adapted_tau.clone())?;
    let bundles = crate::ceremony_workspace::verified_bundles(&config.workspace)?;
    let selected = bundles.last().ok_or_else(|| MpcSetupError::State {
        phase: "two-phase final CRS generation",
        reason: "ceremony workspace contains no states".to_string(),
    })?;
    let phase2_receipts = bundles
        .iter()
        .filter(|bundle| bundle.state().phase == Phase::Phase2)
        .filter_map(|bundle| bundle.incoming_receipt.clone())
        .collect::<Vec<_>>();
    validate_state_selection(selected.state(), &phase2_receipts)?;
    let (points, layout) = match &selected.artifact {
        StateArtifact::Phase2(artifact) => (&artifact.points, &artifact.layout),
        StateArtifact::Phase1(_) => {
            return Err(MpcSetupError::State {
                phase: "two-phase final CRS generation",
                reason: "selected state is not Phase 2".to_string(),
            })
        }
    };
    let sigma = final_sigma(points, layout);
    transcript.persist(&config.workspace)?;
    let transcript = CeremonyTranscript::verify_persisted(&config.workspace, adapted_tau)?;
    let transcript_digest = transcript.digest()?;
    let phase1_source_provenance = match (&transcript.source_provenance, &transcript.adapted_tau) {
        (SourceProvenance::Native, None) => Some(Phase1SourceProvenance::Native),
        (SourceProvenance::DuskAdapted { .. }, Some(adapted)) => Some(
            Phase1SourceProvenance::DuskGroth16(adapted.source_provenance.clone()),
        ),
        _ => {
            return Err(MpcSetupError::State {
                phase: "two-phase final CRS generation",
                reason: "transcript source provenance is inconsistent".to_string(),
            })
        }
    };
    stage_final_output(
        &config.output,
        &sigma,
        phase1_source_provenance,
        transcript_digest
            .as_str()
            .strip_prefix("sha256:")
            .expect("validated transcript digest has prefix")
            .to_string(),
    )
}

fn final_sigma(
    points: &CircuitSigmaPoints,
    layout: &crate::universal_tau::MonomialLayout,
) -> libs::group_structures::Sigma {
    libs::group_structures::Sigma {
        G: points.g1,
        H: points.g2,
        sigma_1: libs::group_structures::Sigma1 {
            xy_powers: points.xy_powers.clone().into_boxed_slice(),
            x: points.x_g1,
            y: points.y_g1,
            delta: points.delta_g1,
            eta: points.eta_g1,
            gamma_inv_o_inst: points.gamma_inv_o_inst.clone().into_boxed_slice(),
            eta_inv_li_o_inter_alpha4_kj: rows(&points.eta_inv_li_o_inter_alpha4_kj, layout.s),
            delta_inv_li_o_prv: rows(&points.delta_inv_li_o_prv, layout.s),
            delta_inv_alphak_xh_tx: rows(&points.delta_inv_alphak_xh_tx, 3),
            delta_inv_alpha4_xj_tx: points.delta_inv_alpha4_xj_tx.clone().into_boxed_slice(),
            delta_inv_alphak_yi_ty: rows(&points.delta_inv_alphak_yi_ty, 3),
        },
        sigma_2: libs::group_structures::Sigma2 {
            alpha: points.alpha_g2[0],
            alpha2: points.alpha_g2[1],
            alpha3: points.alpha_g2[2],
            alpha4: points.alpha_g2[3],
            gamma: points.gamma_g2,
            delta: points.delta_g2,
            eta: points.eta_g2,
            x: points.x_g2,
            y: points.y_g2,
        },
        lagrange_KL: points.lagrange_kl,
    }
}

fn rows(
    points: &[libs::group_structures::G1serde],
    width: usize,
) -> Box<[Box<[libs::group_structures::G1serde]>]> {
    if points.is_empty() {
        return Vec::new().into_boxed_slice();
    }
    assert!(width > 0 && points.len() % width == 0);
    points
        .chunks(width)
        .map(|row| row.to_vec().into_boxed_slice())
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

fn stage_final_output(
    output_dir: &Path,
    sigma: &libs::group_structures::Sigma,
    phase1_source_provenance: Option<Phase1SourceProvenance>,
    ceremony_transcript_sha256: String,
) -> Result<(), MpcSetupError> {
    let release_eligible = is_release_eligible(phase1_source_provenance.as_ref());
    let subcircuit_library_origin = subcircuit_library_origin_from_build()?;
    let (staged_crs, digests) =
        stage_final_crs_artifacts(output_dir, sigma).map_err(|source| MpcSetupError::Io {
            operation: "stage final CRS artifacts",
            path: output_dir.to_path_buf(),
            source,
        })?;
    let provenance = CrsProvenance::FinalMpcCrs(FinalMpcCrsProvenance {
        release_eligible,
        generated_at_utc: Utc::now().to_rfc3339(),
        compatible_backend_version: compatible_backend_version().to_string(),
        subcircuit_library: SubcircuitLibraryProvenance {
            package_name: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME").to_string(),
            package_version: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION").to_string(),
            origin: subcircuit_library_origin,
            source_digest: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_SOURCE_DIGEST").to_string(),
        },
        phase1_source_provenance,
        ceremony_protocol_version: PROTOCOL_VERSION.to_string(),
        ceremony_transcript_sha256,
        combined_sigma_sha256: digests.combined_sigma_sha256,
        sigma_preprocess_sha256: digests.sigma_preprocess_sha256,
        sigma_verify_sha256: digests.sigma_verify_sha256,
    });
    let CrsProvenance::FinalMpcCrs(final_provenance) = &provenance else {
        unreachable!()
    };
    validate_final_mpc_crs_provenance(final_provenance).map_err(|reason| MpcSetupError::State {
        phase: "two-phase final CRS generation",
        reason,
    })?;
    staged_crs
        .write_provenance(&serde_json::to_vec_pretty(&provenance).map_err(|error| {
            MpcSetupError::State {
                phase: "two-phase final CRS generation",
                reason: format!("cannot serialize CRS provenance: {error}"),
            }
        })?)
        .map_err(|source| MpcSetupError::Io {
            operation: "stage CRS provenance",
            path: output_dir.to_path_buf(),
            source,
        })?;
    let provenance_path = staged_crs
        .staging_directory()
        .map_err(|source| MpcSetupError::Io {
            operation: "locate staged CRS provenance",
            path: output_dir.to_path_buf(),
            source,
        })?
        .join("crs_provenance.json");
    let parsed = parse_final_mpc_crs_provenance(&fs::read(&provenance_path).map_err(|source| {
        MpcSetupError::Io {
            operation: "read staged CRS provenance",
            path: provenance_path.clone(),
            source,
        }
    })?)
    .map_err(|reason| MpcSetupError::State {
        phase: "two-phase final CRS generation",
        reason,
    })?;
    staged_crs
        .verify_artifact_digests(&FinalCrsDigests {
            combined_sigma_sha256: parsed.combined_sigma_sha256,
            sigma_preprocess_sha256: parsed.sigma_preprocess_sha256,
            sigma_verify_sha256: parsed.sigma_verify_sha256,
        })
        .map_err(|source| MpcSetupError::Io {
            operation: "validate staged final CRS artifacts",
            path: output_dir.to_path_buf(),
            source,
        })?;
    staged_crs.activate().map_err(|source| MpcSetupError::Io {
        operation: "activate final CRS generation",
        path: output_dir.to_path_buf(),
        source,
    })
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

#[cfg(test)]
mod tests {
    use super::{is_release_eligible, run_two_phase, TwoPhaseFinalConfig};
    use crate::transcript::CeremonyTranscript;
    use libs::crs_provenance::parse_final_mpc_crs_provenance;
    use libs::crs_provenance::{DuskSourceProvenance, Phase1SourceProvenance};
    use std::collections::BTreeSet;
    use std::fs;

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

    #[test]
    fn two_phase_finalization_binds_transcript_and_keeps_four_file_archive() {
        let (root, workspace) = crate::transcript::tests::fixture();
        let output = root.path().join("final-crs");
        run_two_phase(&TwoPhaseFinalConfig {
            workspace: workspace.clone(),
            output: output.clone(),
            adapted_tau: None,
        })
        .unwrap();

        let files = fs::read_dir(&output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            files,
            BTreeSet::from([
                "combined_sigma.rkyv".to_string(),
                "crs_provenance.json".to_string(),
                "sigma_preprocess.rkyv".to_string(),
                "sigma_verify.json".to_string(),
            ])
        );

        let provenance =
            parse_final_mpc_crs_provenance(&fs::read(output.join("crs_provenance.json")).unwrap())
                .unwrap();
        let transcript = CeremonyTranscript::verify_persisted(&workspace, None).unwrap();
        assert_eq!(
            provenance.ceremony_protocol_version,
            crate::protocol::PROTOCOL_VERSION
        );
        assert_eq!(
            provenance.ceremony_transcript_sha256,
            transcript
                .digest()
                .unwrap()
                .as_str()
                .strip_prefix("sha256:")
                .unwrap()
        );
    }

    #[test]
    fn dusk_backed_two_phase_finalization_binds_the_verified_adaptor() {
        let (root, workspace, adapted_tau) = crate::transcript::tests::dusk_fixture();
        let output = root.path().join("dusk-final-crs");
        run_two_phase(&TwoPhaseFinalConfig {
            workspace: workspace.clone(),
            output: output.clone(),
            adapted_tau: Some(adapted_tau.clone()),
        })
        .unwrap();

        let transcript = CeremonyTranscript::verify_persisted(
            &workspace,
            Some(crate::alpha_x_basis::verify_adapted_tau_bundle(&adapted_tau).unwrap()),
        )
        .unwrap();
        assert!(transcript.adapted_tau.is_some());
        let provenance =
            parse_final_mpc_crs_provenance(&fs::read(output.join("crs_provenance.json")).unwrap())
                .unwrap();
        assert!(matches!(
            provenance.phase1_source_provenance,
            Some(Phase1SourceProvenance::DuskGroth16(_))
        ));
        assert!(provenance.release_eligible);
    }
}
