//! Resumable operations with contributor-local input authentication on every run.
use crate::{
    filecoin_source,
    phase2_engine::Engine,
    phase2_transcript::{Identity, Transcript},
};
use backend_univariate_crs_interface::archive;
use clap::{Parser, Subcommand};
use libs::crs_provenance::{
    write_crs_provenance, CrsGenerationMethod, CrsProvenance, FilecoinSourceProvenance,
    Phase1SourceProvenance, CEREMONY_PROTOCOL_VERSION, CRS_DOCUMENT_KIND,
};
use libs::frontend_artifacts::{
    public_wire_layout::{read_global_wires, PublicWireLayout},
    SetupParams, SubcircuitInfo,
};
use libs::input_origin::SubcircuitLibraryOrigin;
use libs::r1cs::SubcircuitR1CS;
use libs::subcircuit_library::prepare_mpc_subcircuit_library;
use libs::univariate_crs::{UnivariateCrsShape, UNIVARIATE_CRS_SCHEMA_ID};
use libs::univariate_setup::{stage_artifacts, SetupCrs};
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser)]
#[command(
    name = "mpc",
    about = "Tokamak phase 2 using independently authenticated Filecoin input"
)]
struct Args {
    /// Original Filecoin challenge_19 acquired by this participant. Omit to
    /// download the pinned original. The full digest is checked on every run.
    #[arg(long, global = true)]
    filecoin_source: Option<PathBuf>,
    #[command(subcommand)]
    operation: Operation,
}

#[derive(Subcommand)]
enum Operation {
    /// Derive deterministic public initialization; this is not a contribution.
    Init {
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify the incoming chain, sample fresh shares and write a new record.
    Contribute {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Independently rederive initialization and verify every contribution.
    Verify {
        #[arg(long)]
        input: PathBuf,
    },
    /// Verify contributions and atomically activate the four common CRS files.
    Finalize {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

pub fn run() -> Result<(), String> {
    execute(Args::parse())
}

fn execute(args: Args) -> Result<(), String> {
    let all = Instant::now();
    let started = Instant::now();
    let directory = tempfile::Builder::new()
        .prefix("tokamak-mpc-input-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let path = directory.path().join("library");
    let library = prepare_mpc_subcircuit_library(&path).map_err(|e| e.to_string())?;
    if library.origin != SubcircuitLibraryOrigin::NpmSnapshot {
        return Err(
            "MPC accepts only the participant's independently resolved npm snapshot".into(),
        );
    }
    let setup = SetupParams::read_from_json(path.join("setupParams.json")).map_err(|e| {
        format!(
            "npm snapshot {} is incompatible with the current protocol: {e}",
            library.package_version
        )
    })?;
    UnivariateCrsShape::from_setup_params(&setup)
        .map_err(|e| format!("npm snapshot is incompatible with the current protocol: {e}"))?;
    let infos = SubcircuitInfo::read_box_from_json(path.join("subcircuitInfo.json"))
        .map_err(|e| e.to_string())?;
    let globals =
        read_global_wires(&path.join("globalWireList.json")).map_err(|e| e.to_string())?;
    let public = PublicWireLayout::derive(&setup, &globals, &infos).map_err(|e| e.to_string())?;
    let r1cs = infos
        .par_iter()
        .enumerate()
        .map(|(k, info)| {
            if info.id != k {
                return Err("npm catalog ID/order mismatch".into());
            }
            SubcircuitR1CS::from_r1cs_sparse_only(
                path.join(format!("r1cs/subcircuit{k}.r1cs")),
                &setup,
                info,
            )
            .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let circuits = r1cs
        .iter()
        .zip(infos.iter())
        .map(|(r, i)| r.as_univariate_subcircuit(i))
        .collect::<Vec<_>>();
    println!(
        "[mpc] npm input {} in {:.6}s",
        library.package_version,
        started.elapsed().as_secs_f64()
    );

    // There is no branch accepting a tau artifact, subset digest, verification
    // receipt or previous participant's source check. No share is sampled yet.
    let started = Instant::now();
    println!(
        "[mpc] authenticating Filecoin source (producer revision {})",
        filecoin_source::SOURCE_REVISION
    );
    let tau = match args.filecoin_source {
        Some(path) => filecoin_source::prepare_local(&path, &setup),
        None => filecoin_source::prepare_download(&setup),
    }
    .map_err(|e| e.to_string())?;
    println!(
        "[mpc] original source authentication and derivation in {:.6}s",
        started.elapsed().as_secs_f64()
    );
    let identity = Identity {
        version: library.package_version.clone(),
        library_digest: hex::decode(
            library
                .source_digest
                .strip_prefix("sha256:")
                .ok_or("invalid npm source digest")?,
        )
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid npm source digest length")?,
        tau_digest: Sha256::digest(
            archive::to_bytes::<archive::rancor::Error>(&tau).map_err(|e| e.to_string())?,
        )
        .into(),
    };
    let started = Instant::now();
    let engine = Engine::initialize(&setup, &public, &circuits, &tau)?;
    println!(
        "[mpc] encoded-power initialization in {:.6}s",
        started.elapsed().as_secs_f64()
    );
    let started = Instant::now();
    let input = match &args.operation {
        Operation::Init { .. } => None,
        Operation::Contribute { input, .. }
        | Operation::Verify { input }
        | Operation::Finalize { input, .. } => Some(input),
    };
    let transcript = if let Some(input) = input {
        Transcript::read(
            std::fs::read(input).map_err(|e| e.to_string())?,
            &engine,
            &identity,
        )?
    } else {
        Transcript::initialize(&engine, &identity)?
    };
    println!(
        "[mpc] verified {} contributions in {:.6}s",
        transcript.contributions,
        started.elapsed().as_secs_f64()
    );
    let started = Instant::now();
    match args.operation {
        Operation::Init { output } => transcript.write_new(&output)?,
        Operation::Contribute { output, .. } => {
            transcript
                .contribute(&engine, &identity, &mut rand::rngs::OsRng)?
                .write_new(&output)?;
        }
        Operation::Verify { .. } => {}
        Operation::Finalize { output, .. } => {
            if transcript.contributions == 0 {
                return Err("finalization requires a verified participant contribution".into());
            }
            let (prover, preprocess, verifier) =
                engine.final_keys(&transcript.state, &tau, &setup)?;
            let crs = SetupCrs {
                tau,
                prover,
                preprocess,
                verifier,
            };
            let (stage, digests) = stage_artifacts(&output, &crs).map_err(|e| e.to_string())?;
            let provenance = CrsProvenance {
                document_kind: CRS_DOCUMENT_KIND.into(),
                protocol_schema_id: UNIVARIATE_CRS_SCHEMA_ID.into(),
                generation_method: CrsGenerationMethod::Mpc,
                release_eligible: false,
                generated_at_utc: chrono::Utc::now().to_rfc3339(),
                compatible_backend_version:
                    libs::compatibility::compatibility_from_package_version(env!(
                        "CARGO_PKG_VERSION"
                    ))
                    .map_err(|e| e.to_string())?
                    .to_string(),
                subcircuit_library: library,
                phase1_source_provenance: Some(Phase1SourceProvenance::Filecoin(
                    FilecoinSourceProvenance {
                        source_url: filecoin_source::SOURCE_URL.into(),
                        source_blake2b512: filecoin_source::SOURCE_DIGEST.into(),
                    },
                )),
                ceremony_protocol_version: Some(CEREMONY_PROTOCOL_VERSION.into()),
                ceremony_transcript_sha256: Some(transcript.file_digest()),
                artifacts: [
                    ("tau_sequence.rkyv".into(), digests.tau_sequence_sha256),
                    ("prover_keys.rkyv".into(), digests.prover_keys_sha256),
                    (
                        "preprocess_keys.rkyv".into(),
                        digests.preprocess_keys_sha256,
                    ),
                    ("verifier_keys.rkyv".into(), digests.verifier_keys_sha256),
                ]
                .into(),
            };
            write_crs_provenance(
                stage.staging_directory().map_err(|e| e.to_string())?,
                &provenance,
            )
            .map_err(|e| e.to_string())?;
            stage.activate().map_err(|e| e.to_string())?;
        }
    }
    println!(
        "[mpc] operation/output in {:.6}s; total {:.6}s",
        started.elapsed().as_secs_f64(),
        all.elapsed().as_secs_f64()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_surface_has_no_source_pin_or_subset_bypass() {
        for command in ["init", "contribute", "verify", "finalize"] {
            assert!(
                Args::try_parse_from(["mpc", command, "--tau-sequence", "coordinator.rkyv"])
                    .is_err()
            );
            assert!(Args::try_parse_from(["mpc", command, "--skip-source-verification"]).is_err());
        }
        assert!(Args::try_parse_from(["mpc", "phase1"]).is_err());
    }
    #[cfg(not(feature = "production-npm-subcircuit-library"))]
    #[test]
    fn local_build_stops_before_source_io_or_output() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("must-not-exist");
        let error = execute(Args {
            filecoin_source: Some(dir.path().join("missing-source")),
            operation: Operation::Init {
                output: output.clone(),
            },
        })
        .unwrap_err();
        assert!(error.contains("production-npm-subcircuit-library"));
        assert!(!output.exists());
    }
}
