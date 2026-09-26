//! Resumable operations with contributor-local input authentication on every run.
use crate::{
    circuit_input::{self, Mode},
    filecoin_source,
    phase2_engine::Engine,
    phase2_transcript::{Identity, Transcript},
};
use backend_univariate_crs_interface::archive;
use clap::{Parser, Subcommand};
use libs::crs_provenance::{
    CrsGenerationMethod, CrsProvenance, FilecoinSourceProvenance, Phase1SourceProvenance,
    CEREMONY_PROTOCOL_VERSION, CRS_DOCUMENT_KIND,
};
use libs::frontend_artifacts::normalized_library::NormalizedSubcircuitLibrary;
use libs::r1cs::SubcircuitR1CS;
use libs::univariate_crs::{UnivariateCrsShape, UNIVARIATE_CRS_SCHEMA_ID};
use libs::univariate_setup::SetupCrs;
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
    /// Select local QAP testing or npm-backed publication preparation.
    /// Only upload sends finalized CRS artifacts to Google Drive.
    #[arg(long, value_enum)]
    mode: Mode,
    /// Exact npm library version for publish init only; defaults to the latest compatible release.
    #[arg(long)]
    library_version: Option<String>,
    /// Local QAP library directory; required only with --mode development.
    #[arg(long, value_name = "PATH")]
    subcircuit_library: Option<PathBuf>,
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
    /// Verify every contribution, then atomically activate the four common CRS files.
    Finalize {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Upload a completed, release-eligible CRS directory to Google Drive.
    Upload {
        #[arg(long)]
        crs_directory: PathBuf,
    },
}

pub fn run() -> Result<(), String> {
    execute(Args::parse())
}

fn execute(args: Args) -> Result<(), String> {
    if let Operation::Upload { crs_directory } = &args.operation {
        if args.mode != Mode::Publish {
            return Err("the upload operation requires --mode publish".into());
        }
        if args.library_version.is_some()
            || args.subcircuit_library.is_some()
            || args.filecoin_source.is_some()
        {
            return Err(
                "upload accepts only --mode publish and --crs-directory; setup inputs are not used"
                    .into(),
            );
        }
        let mut snapshot = crate::publication::read_finalized_snapshot(crs_directory)?;
        let mut drive = crate::drive::GoogleDrive::connect()?;
        let root = drive.root.clone();
        let url = crate::publication::upload(&mut drive, &root, &mut snapshot)?;
        println!("[mpc] upload complete: {url}");
        return Ok(());
    }
    let library_version = library_version_for_run(&args)?;
    let all = Instant::now();
    let started = Instant::now();
    let directory = tempfile::Builder::new()
        .prefix("tokamak-mpc-input-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let (path, library) = circuit_input::prepare(
        args.mode,
        library_version.as_deref(),
        args.subcircuit_library.as_deref(),
        directory.path(),
    )?;
    let normalized_library =
        NormalizedSubcircuitLibrary::read_from_qap_path(&path).map_err(|e| {
            format!(
                "circuit library {} is incompatible with the current protocol: {e}",
                library.package_version
            )
        })?;
    let shape = UnivariateCrsShape::from_normalized_setup(
        &normalized_library.setup,
        normalized_library.public.free_public_len(),
    )
    .map_err(|e| format!("circuit library is incompatible with the current protocol: {e}"))?;
    let r1cs = normalized_library
        .subcircuits
        .par_iter()
        .enumerate()
        .map(|(k, info)| {
            if info.id != k {
                return Err("circuit catalog ID/order mismatch".into());
            }
            SubcircuitR1CS::from_normalized_r1cs_sparse_only(
                path.join(format!("r1cs/subcircuit{k}.r1cs")),
                &normalized_library.setup,
                info,
            )
            .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let circuits = r1cs
        .iter()
        .zip(normalized_library.subcircuits.iter())
        .map(|(r, i)| r.as_normalized_univariate_subcircuit(i))
        .collect::<Vec<_>>();
    println!(
        "[mpc] {} input {} in {:.6}s",
        args.mode.name(),
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
        Some(path) => filecoin_source::prepare_local(&path, &shape),
        None => filecoin_source::prepare_download(&shape),
    }
    .map_err(|e| e.to_string())?;
    println!(
        "[mpc] original source authentication and derivation in {:.6}s",
        started.elapsed().as_secs_f64()
    );
    let identity = Identity {
        mode: args.mode,
        version: library.package_version.clone(),
        library_digest: hex::decode(
            library
                .source_digest
                .strip_prefix("sha256:")
                .ok_or("invalid circuit source digest")?,
        )
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid circuit source digest length")?,
        tau_digest: Sha256::digest(
            archive::to_bytes::<archive::rancor::Error>(&tau).map_err(|e| e.to_string())?,
        )
        .into(),
    };
    let started = Instant::now();
    let engine = Engine::initialize(&normalized_library, &circuits, &tau)?;
    println!(
        "[mpc] encoded-power initialization in {:.6}s",
        started.elapsed().as_secs_f64()
    );
    let started = Instant::now();
    let input = match &args.operation {
        Operation::Init { .. } => None,
        Operation::Contribute { input, .. } | Operation::Finalize { input, .. } => Some(input),
        Operation::Upload { .. } => unreachable!("upload handled before MPC setup"),
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
        transcript.contributions(),
        started.elapsed().as_secs_f64()
    );
    let started = Instant::now();
    match args.operation {
        Operation::Init { output } => transcript.write_new(&output)?,
        Operation::Contribute { output, .. } => {
            transcript
                .contribute(&mut rand::rngs::OsRng)?
                .write_new(&output)?;
        }
        Operation::Finalize { output, .. } => {
            if transcript.contributions() == 0 {
                return Err("finalization requires a verified participant contribution".into());
            }
            let (prover, preprocess, verifier) =
                transcript.state().final_keys(&tau, &normalized_library)?;
            let crs = SetupCrs {
                tau,
                prover,
                preprocess,
                verifier,
            };
            let provenance = CrsProvenance {
                document_kind: CRS_DOCUMENT_KIND.into(),
                protocol_schema_id: UNIVARIATE_CRS_SCHEMA_ID.into(),
                generation_method: CrsGenerationMethod::Mpc,
                release_eligible: args.mode == Mode::Publish,
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
                phase2_contribution_count: Some(transcript.contributions() as u64),
                artifacts: Default::default(),
            };
            let release_eligible = args.mode == Mode::Publish;
            crate::publication::finalize(&output, &crs, provenance, release_eligible)?;
            if release_eligible {
                println!(
                    "[mpc] finalized release-eligible CRS at {}; run the upload operation to send it to Google Drive",
                    output.display()
                );
            } else {
                println!("[mpc] finalized local CRS; releaseEligible=false, no upload requested");
            }
        }
        Operation::Upload { .. } => unreachable!("upload handled before MPC setup"),
    }
    println!(
        "[mpc] operation/output in {:.6}s; total {:.6}s",
        started.elapsed().as_secs_f64(),
        all.elapsed().as_secs_f64()
    );
    Ok(())
}

fn library_version_for_run(args: &Args) -> Result<Option<String>, String> {
    let is_init = matches!(&args.operation, Operation::Init { .. });
    if args.library_version.is_some() && (args.mode != Mode::Publish || !is_init) {
        return Err("--library-version is only accepted with --mode publish init".into());
    }
    args.mode.validate(
        args.library_version.as_deref(),
        args.subcircuit_library.as_deref(),
    )?;

    if args.mode == Mode::Development {
        return Ok(None);
    }
    if is_init {
        return Ok(args.library_version.clone());
    }

    let input = match &args.operation {
        Operation::Contribute { input, .. } | Operation::Finalize { input, .. } => input,
        Operation::Init { .. } => unreachable!("init handled above"),
        Operation::Upload { .. } => unreachable!("upload handled before MPC setup"),
    };
    let version = Transcript::library_version_from_file(input)?
        .ok_or("input transcript does not record a publish-mode library version")?;
    args.mode.validate(Some(&version), None)?;
    Ok(Some(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_surface_has_no_source_pin_or_subset_bypass() {
        for command in ["init", "contribute", "finalize"] {
            let mut valid = vec![
                "mpc",
                "--mode",
                "development",
                "--subcircuit-library",
                "local-library",
                command,
            ];
            if command != "init" {
                valid.extend(["--input", "previous.mpc"]);
            }
            valid.extend(["--output", "next"]);
            assert!(Args::try_parse_from(&valid).is_ok());
            for extra in [
                vec!["--tau-sequence", "coordinator.rkyv"],
                vec!["--skip-source-verification"],
            ] {
                let mut invalid = valid.clone();
                invalid.extend(extra);
                assert!(Args::try_parse_from(invalid).is_err());
            }
        }
        assert!(Args::try_parse_from([
            "mpc",
            "--mode",
            "development",
            "--subcircuit-library",
            "local-library",
            "verify",
            "--input",
            "previous.mpc"
        ])
        .is_err());
        assert!(Args::try_parse_from([
            "mpc",
            "--mode",
            "publish",
            "upload",
            "--crs-directory",
            "./final-crs"
        ])
        .is_ok());
        assert!(Args::try_parse_from(["mpc", "phase1"]).is_err());
    }
    #[test]
    fn publish_init_can_omit_or_pin_the_library_version() {
        let args = Args::try_parse_from([
            "mpc",
            "--mode",
            "publish",
            "init",
            "--output",
            "initial.mpc",
        ])
        .unwrap();
        assert_eq!(library_version_for_run(&args).unwrap(), None);
        let mut pinned = args;
        pinned.library_version = Some(env!("CARGO_PKG_VERSION").into());
        assert_eq!(
            library_version_for_run(&pinned).unwrap(),
            Some(env!("CARGO_PKG_VERSION").into())
        );
    }

    #[test]
    fn publish_contribution_uses_transcript_version_and_rejects_override() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("initial.mpc");
        let version = env!("CARGO_PKG_VERSION");
        let mut header = b"TOKAMAK_MPC_PHASE2_TRANSCRIPT_V1\0".to_vec();
        header.extend([1, 1]);
        header.extend_from_slice(&(version.len() as u16).to_be_bytes());
        header.extend_from_slice(version.as_bytes());
        std::fs::write(&input, header).unwrap();
        let mut args = Args {
            mode: Mode::Publish,
            library_version: None,
            subcircuit_library: None,
            filecoin_source: None,
            operation: Operation::Contribute {
                input,
                output: dir.path().join("next.mpc"),
            },
        };
        assert_eq!(
            library_version_for_run(&args).unwrap(),
            Some(version.to_owned())
        );
        args.library_version = Some(version.into());
        assert!(library_version_for_run(&args)
            .unwrap_err()
            .contains("only accepted with --mode publish init"));
    }

    #[test]
    fn execution_mode_is_explicit_and_independent_of_the_build() {
        assert!(Args::try_parse_from(["mpc", "init", "--output", "initial.mpc"]).is_err());
        for (mode, source_args) in [
            ("development", vec!["--subcircuit-library", "local-library"]),
            ("publish", vec![]),
        ] {
            let mut argv = vec!["mpc", "--mode", mode];
            argv.extend(source_args);
            argv.extend(["init", "--output", "initial.mpc"]);
            let args = Args::try_parse_from(argv).unwrap();
            assert_eq!(args.mode.name(), mode);
        }
    }

    #[test]
    fn development_requires_a_local_library_before_source_io_or_output() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("must-not-exist");
        let error = execute(Args {
            mode: Mode::Development,
            library_version: None,
            subcircuit_library: None,
            filecoin_source: Some(dir.path().join("missing-source")),
            operation: Operation::Init {
                output: output.clone(),
            },
        })
        .unwrap_err();
        assert!(error.contains("--subcircuit-library"));
        assert!(!output.exists());
    }

    #[test]
    fn development_upload_fails_before_crs_or_drive_access() {
        let dir = tempfile::tempdir().unwrap();
        let error = execute(Args {
            mode: Mode::Development,
            library_version: None,
            subcircuit_library: Some(dir.path().join("local-library")),
            filecoin_source: None,
            operation: Operation::Upload {
                crs_directory: dir.path().join("missing"),
            },
        })
        .unwrap_err();
        assert!(error.contains("requires --mode publish"));
    }

    #[test]
    fn upload_rejects_ceremony_inputs_before_reading_the_crs_or_connecting_to_drive() {
        let dir = tempfile::tempdir().unwrap();
        let error = execute(Args {
            mode: Mode::Publish,
            library_version: None,
            subcircuit_library: None,
            filecoin_source: Some(dir.path().join("unused-source")),
            operation: Operation::Upload {
                crs_directory: dir.path().join("missing-crs"),
            },
        })
        .unwrap_err();
        assert!(error.contains("setup inputs are not used"));
    }
}
