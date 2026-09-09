use clap::{Args, Parser, Subcommand};
use libs::cli::render_error;
use libs::subcircuit_library::{try_resolve_subcircuit_library_path, SubcircuitLibraryArg};
use libs::univariate_crs::UnivariateTauCapacity;
use std::process::ExitCode;
use trusted_setup::{run_phase_1, run_phase_2, Phase1Config, Phase2Config, TrustedSetupError};

#[derive(Parser, Debug)]
#[command(author, version, about = "Tokamak direct trusted-setup phases")]
struct Config {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Phase 1: generate the reusable library-independent terminal tau sequences.
    #[command(name = "phase-1")]
    Phase1(Phase1Args),
    /// Phase 2: specialize a persisted Phase 1 sequence for one subcircuit library.
    #[command(name = "phase-2")]
    Phase2(Phase2Args),
}

#[derive(Args, Debug)]
struct Phase1Args {
    #[arg(long)]
    l0: usize,
    #[arg(long = "l-xi")]
    l_xi: usize,
    #[arg(long = "l-psi")]
    l_psi: usize,
    #[arg(long)]
    l2: usize,
    #[arg(long, value_name = "PATH")]
    output: String,
    #[arg(long, default_value_t = false)]
    fixed_tau: bool,
}

#[derive(Args, Debug)]
struct Phase2Args {
    #[command(flatten)]
    subcircuit_library: SubcircuitLibraryArg,
    #[arg(long, value_name = "FILE")]
    tau_sequence: String,
    #[arg(long, value_name = "FILE")]
    tau_provenance: String,
    #[arg(long, value_name = "PATH")]
    output: String,
    #[arg(long, default_value_t = false)]
    fixed_role_scalars: bool,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => render_error(&error),
    }
}

fn run() -> Result<(), TrustedSetupError> {
    match Config::parse().command {
        Command::Phase1(args) => run_phase_1(&Phase1Config {
            capacity: UnivariateTauCapacity {
                l0: args.l0,
                l_xi: args.l_xi,
                l_psi: args.l_psi,
                l2: args.l2,
            },
            output_path: &args.output,
            fixed_tau: args.fixed_tau,
        }),
        Command::Phase2(args) => {
            libs::utils::try_check_device()?;
            let qap = try_resolve_subcircuit_library_path(args.subcircuit_library.as_deref())?;
            let qap = qap.to_string_lossy();
            run_phase_2(&Phase2Config {
                qap_path: &qap,
                tau_sequence_path: &args.tau_sequence,
                tau_provenance_path: &args.tau_provenance,
                output_path: &args.output,
                fixed_role_scalars: args.fixed_role_scalars,
            })
        }
    }
}
