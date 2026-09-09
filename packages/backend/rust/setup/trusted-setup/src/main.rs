use clap::{Args, Parser, Subcommand};
use libs::cli::render_error;
use libs::subcircuit_library::{try_resolve_subcircuit_library_path, SubcircuitLibraryArg};
use libs::univariate_crs::UnivariateTauCapacity;
use std::process::ExitCode;
use trusted_setup::{
    run_generate_tau_sequence, run_specialize_library, GenerateTauSequenceConfig,
    SpecializeLibraryConfig, TrustedSetupError,
};

#[derive(Parser, Debug)]
#[command(author, version, about = "Tokamak direct trusted-setup stages")]
struct Config {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Generate the reusable library-independent terminal tau sequences.
    GenerateTauSequence(GenerateTauSequenceArgs),
    /// Specialize a persisted tau sequence for one subcircuit library.
    SpecializeLibrary(SpecializeLibraryArgs),
}

#[derive(Args, Debug)]
struct GenerateTauSequenceArgs {
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
struct SpecializeLibraryArgs {
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
        Command::GenerateTauSequence(args) => {
            run_generate_tau_sequence(&GenerateTauSequenceConfig {
                capacity: UnivariateTauCapacity {
                    l0: args.l0,
                    l_xi: args.l_xi,
                    l_psi: args.l_psi,
                    l2: args.l2,
                },
                output_path: &args.output,
                fixed_tau: args.fixed_tau,
            })
        }
        Command::SpecializeLibrary(args) => {
            libs::utils::try_check_device()?;
            let qap = try_resolve_subcircuit_library_path(args.subcircuit_library.as_deref())?;
            let qap = qap.to_string_lossy();
            run_specialize_library(&SpecializeLibraryConfig {
                qap_path: &qap,
                tau_sequence_path: &args.tau_sequence,
                tau_provenance_path: &args.tau_provenance,
                output_path: &args.output,
                fixed_role_scalars: args.fixed_role_scalars,
            })
        }
    }
}
