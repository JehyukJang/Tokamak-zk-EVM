use clap::{Args, Parser, Subcommand};
use libs::cli::render_error;
use mpc_setup::operator::{
    adapt_dusk, append_chain, generate_final_artifacts, initialize_chain, initialize_native,
    prepare_circuit, prepare_dusk_phase1, verify_chain, OperatorError,
};
use mpc_setup::participant::{
    run_contribute, run_verify_transition, ContributeConfig, VerifyTransitionConfig,
};
use mpc_setup::protocol::Phase;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(author, version, about = "Tokamak two-phase MPC commands")]
struct Config {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Contribute to the profile authenticated by an immutable input state bundle.
    Contribute(ContributeArgs),
    /// Verify one contributed-state transition and its explicit incoming receipt.
    VerifyTransition(VerifyTransitionArgs),
    /// Create an immutable native Phase 1 genesis bundle.
    InitializeNative(InitializeNativeArgs),
    /// Verify and adapt the pinned Dusk tau into a non-ceremony bundle.
    AdaptDusk(AdaptDuskArgs),
    /// Create an immutable Dusk-backed Phase 1 prepared bundle.
    PrepareDusk(PrepareDuskArgs),
    /// Create an append-only ceremony workspace from an initial state bundle.
    WorkspaceInit(WorkspaceInitArgs),
    /// Verify and append one immutable state bundle to a ceremony workspace.
    WorkspaceAppend(WorkspaceAppendArgs),
    /// Reverify every state and transition in a ceremony workspace.
    WorkspaceVerify(WorkspaceVerifyArgs),
    /// Select a qualifying Phase 1 chain and prepare the circuit-bound Phase 2 state.
    PrepareCircuit(PrepareCircuitArgs),
    /// Generate the local four-file CRS from a qualifying Phase 2 workspace.
    GenerateFinal(GenerateFinalArgs),
}

#[derive(Args, Debug)]
struct ContributeArgs {
    /// Expected phase. The verified input state remains authoritative.
    #[arg(long, value_parser = clap::value_parser!(u8).range(1..=2))]
    phase: u8,
    /// Immutable previous-state bundle.
    #[arg(long, value_name = "PATH")]
    input: PathBuf,
    /// New immutable contributed-state bundle. Existing paths are rejected.
    #[arg(long, value_name = "PATH")]
    output: PathBuf,
    /// Optional participant entropy combined with system randomness.
    #[arg(long)]
    seed_input: Option<String>,
    /// Produce a deterministic, explicitly non-qualifying contribution.
    #[arg(long, default_value_t = false, requires = "seed_input")]
    beacon_mode: bool,
}

#[derive(Args, Debug)]
struct VerifyTransitionArgs {
    /// Immutable previous-state bundle.
    #[arg(long, value_name = "PATH")]
    previous: PathBuf,
    /// Immutable current-state bundle.
    #[arg(long, value_name = "PATH")]
    current: PathBuf,
    /// Canonical receipt.json from the current-state bundle.
    #[arg(long, value_name = "PATH")]
    receipt: PathBuf,
}

#[derive(Args, Debug)]
struct InitializeNativeArgs {
    #[arg(long)]
    ceremony_id: String,
    #[arg(long, value_name = "PATH")]
    qap: PathBuf,
    #[arg(long, value_name = "PATH")]
    output: PathBuf,
}

#[derive(Args, Debug)]
struct AdaptDuskArgs {
    #[arg(long, value_name = "PATH")]
    qap: PathBuf,
    #[arg(long, value_name = "PATH")]
    raw: PathBuf,
    #[arg(long, value_name = "PATH")]
    output: PathBuf,
}

#[derive(Args, Debug)]
struct PrepareDuskArgs {
    #[arg(long)]
    ceremony_id: String,
    #[arg(long, value_name = "PATH")]
    qap: PathBuf,
    #[arg(long, value_name = "PATH")]
    adapted_tau: PathBuf,
    #[arg(long, value_name = "PATH")]
    output: PathBuf,
}

#[derive(Args, Debug)]
struct WorkspaceInitArgs {
    #[arg(long, value_name = "PATH")]
    workspace: PathBuf,
    #[arg(long, value_name = "PATH")]
    initial: PathBuf,
}

#[derive(Args, Debug)]
struct WorkspaceAppendArgs {
    #[arg(long, value_name = "PATH")]
    workspace: PathBuf,
    #[arg(long, value_name = "PATH")]
    bundle: PathBuf,
}

#[derive(Args, Debug)]
struct WorkspaceVerifyArgs {
    #[arg(long, value_name = "PATH")]
    workspace: PathBuf,
}

#[derive(Args, Debug)]
struct PrepareCircuitArgs {
    #[arg(long, value_name = "PATH")]
    workspace: PathBuf,
    #[arg(long, value_name = "PATH")]
    qap: PathBuf,
    #[arg(long, value_name = "PATH")]
    output: PathBuf,
}

#[derive(Args, Debug)]
struct GenerateFinalArgs {
    #[arg(long, value_name = "PATH")]
    workspace: PathBuf,
    #[arg(long, value_name = "PATH")]
    output: PathBuf,
    /// Required for a Dusk-backed workspace and forbidden for a native workspace.
    #[arg(long, value_name = "PATH")]
    adapted_tau: Option<PathBuf>,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(CommandError::Participant(error)) => render_error(&error),
        Err(CommandError::Operator(error)) => render_error(&error),
    }
}

enum CommandError {
    Participant(mpc_setup::participant::ParticipantError),
    Operator(OperatorError),
}

fn run() -> Result<(), CommandError> {
    match Config::parse().command {
        Command::Contribute(args) => run_contribute(&ContributeConfig {
            expected_phase: if args.phase == 1 {
                Phase::Phase1
            } else {
                Phase::Phase2
            },
            input: args.input,
            output: args.output,
            seed_input: args.seed_input,
            beacon_mode: args.beacon_mode,
        })
        .map_err(CommandError::Participant),
        Command::VerifyTransition(args) => run_verify_transition(&VerifyTransitionConfig {
            previous: args.previous,
            current: args.current,
            receipt: args.receipt,
        })
        .map_err(CommandError::Participant),
        Command::InitializeNative(args) => {
            initialize_native(&args.ceremony_id, &args.qap, &args.output)
                .map_err(CommandError::Operator)
        }
        Command::AdaptDusk(args) => {
            adapt_dusk(&args.qap, &args.raw, &args.output).map_err(CommandError::Operator)
        }
        Command::PrepareDusk(args) => prepare_dusk_phase1(
            &args.ceremony_id,
            &args.qap,
            &args.adapted_tau,
            &args.output,
        )
        .map_err(CommandError::Operator),
        Command::WorkspaceInit(args) => {
            initialize_chain(&args.workspace, &args.initial).map_err(CommandError::Operator)
        }
        Command::WorkspaceAppend(args) => {
            append_chain(&args.workspace, &args.bundle).map_err(CommandError::Operator)
        }
        Command::WorkspaceVerify(args) => {
            verify_chain(&args.workspace).map_err(CommandError::Operator)
        }
        Command::PrepareCircuit(args) => prepare_circuit(&args.workspace, &args.qap, &args.output)
            .map_err(CommandError::Operator),
        Command::GenerateFinal(args) => {
            generate_final_artifacts(&args.workspace, &args.output, args.adapted_tau.as_deref())
                .map_err(CommandError::Operator)
        }
    }
}
