use clap::{Args, Parser, Subcommand};
use libs::cli::render_error;
use libs::subcircuit_library::try_resolve_subcircuit_library_path;
use mpc_setup::{
    run_dusk_backed_ceremony, run_dusk_backed_mpc_setup, run_dusk_backed_publication,
    DuskBackedMpcSetupConfig, DuskPublicationConfig, MPC_SUBCIRCUIT_LIBRARY_PATH,
};
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Create a local final CRS from the pinned Dusk source.
    Ceremony(CeremonyConfig),
    /// Publish an existing local CRS when it satisfies the publisher provenance requirements.
    Publish(PublicationConfig),
    /// Create a local CRS and publish it after the ceremony succeeds.
    Run(CeremonyConfig),
}

#[derive(Args, Debug)]
struct CeremonyConfig {
    /// Intermediate ceremony artifact directory, also used for dusk.response
    #[arg(long, value_name = "PATH")]
    intermediate: String,

    /// Final output directory for trusted-setup-compatible setup artifacts
    #[arg(long, value_name = "PATH")]
    output: String,

    /// Optional seed input consumed once by the wrapper and derived per phase
    #[arg(long)]
    seed_input: Option<String>,

    /// Use deterministic beacon mode instead of the default random mode
    #[arg(long, default_value_t = false)]
    beacon_mode: bool,
}

#[derive(Args, Debug)]
struct PublicationConfig {
    /// Intermediate directory used to create the published CRS archive
    #[arg(long, value_name = "PATH")]
    intermediate: String,

    /// Existing final CRS directory produced by the ceremony command
    #[arg(long, value_name = "PATH")]
    output: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => render_error(&error),
    }
}

fn run() -> Result<(), mpc_setup::MpcSetupError> {
    let config = Config::parse();
    match config.command {
        Command::Ceremony(config) => {
            run_dusk_backed_ceremony(&ceremony_config(config)?)?;
            println!(
                "Dusk-backed ceremony completed. The local CRS is final; Google Drive publication additionally requires npm-snapshot input provenance."
            );
        }
        Command::Publish(config) => {
            run_dusk_backed_publication(&DuskPublicationConfig {
                intermediate: config.intermediate,
                output: config.output,
            })?;
        }
        Command::Run(config) => {
            let output = config.output.clone();
            run_dusk_backed_mpc_setup(&ceremony_config(config)?)?;
            println!(
                "Dusk-backed ceremony and publication completed. Downstream preprocess/prove/verify can now use {output}"
            );
        }
    }
    Ok(())
}

fn ceremony_config(
    config: CeremonyConfig,
) -> Result<DuskBackedMpcSetupConfig, mpc_setup::MpcSetupError> {
    let qap_path = try_resolve_subcircuit_library_path(Some(MPC_SUBCIRCUIT_LIBRARY_PATH))?
        .to_string_lossy()
        .into_owned();
    Ok(DuskBackedMpcSetupConfig {
        qap_path,
        intermediate: config.intermediate,
        output: config.output,
        beacon_mode: config.beacon_mode,
        seed_input: config.seed_input,
    })
}
