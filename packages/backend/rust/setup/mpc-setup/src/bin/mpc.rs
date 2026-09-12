use clap::{Args, Parser, Subcommand};
use mpc_setup::filecoin_phase1;
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(version, about = "Tokamak MPC: pinned Filecoin phase 1 import")]
struct Config {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Convert and verify Filecoin challenge_19; this does not run a new ceremony.
    Phase1(Phase1),
}

#[derive(Args)]
struct Phase1 {
    /// Local uncompressed challenge_19 (the full pinned source file).
    #[arg(
        long,
        required_unless_present = "download",
        conflicts_with = "download"
    )]
    source: Option<PathBuf>,
    /// Stream the pinned source from Filecoin; no full-source disk copy is kept.
    #[arg(long)]
    download: bool,
    /// Maximum tagged/G2 exponent P; ordinary G1 includes exponents through 2P.
    #[arg(long)]
    capacity: usize,
    /// New output directory for tau_sequence.rkyv and import_receipt.json.
    #[arg(long)]
    output: PathBuf,
}

fn main() -> ExitCode {
    let Command::Phase1(args) = Config::parse().command;
    let result = match args.source {
        Some(path) => filecoin_phase1::import_local(&path, args.capacity, &args.output),
        None => filecoin_phase1::import_download(args.capacity, &args.output),
    };
    match result {
        Ok(receipt) => {
            println!("Phase 1 import complete: {}", args.output.display());
            println!("tau_sequence SHA-256: {}", receipt.tau_sequence_sha256);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_selection_is_explicit_and_has_no_legacy_routes() {
        for source in [vec!["--source", "challenge_19"], vec!["--download"]] {
            let mut args = vec!["mpc", "phase1", "--capacity", "3", "--output", "out"];
            args.extend(source);
            assert!(Config::try_parse_from(args).is_ok());
        }
        for args in [
            vec!["mpc", "phase1", "--capacity", "3", "--output", "out"],
            vec![
                "mpc",
                "phase1",
                "--capacity",
                "3",
                "--output",
                "out",
                "--source",
                "input",
                "--download",
            ],
            vec!["mpc", "adapt-dusk"],
            vec!["mpc", "initialize-native"],
        ] {
            assert!(Config::try_parse_from(args).is_err());
        }
    }
}
