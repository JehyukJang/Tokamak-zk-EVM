use clap::Parser;
use libs::cli::render_error;
use libs::subcircuit_library::try_resolve_subcircuit_library_path;
use mpc_setup::{
    run_dusk_backed_mpc_setup, DuskBackedMpcSetupConfig, LOCAL_SUBCIRCUIT_LIBRARY_PATH,
};
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
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

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => render_error(&error),
    }
}

fn run() -> Result<(), mpc_setup::MpcSetupError> {
    let config = Config::parse();
    let qap_path = try_resolve_subcircuit_library_path(Some(LOCAL_SUBCIRCUIT_LIBRARY_PATH))?
        .to_string_lossy()
        .into_owned();
    run_dusk_backed_mpc_setup(&DuskBackedMpcSetupConfig {
        qap_path,
        intermediate: config.intermediate,
        output: config.output.clone(),
        beacon_mode: config.beacon_mode,
        seed_input: config.seed_input,
    })?;

    println!(
        "Dusk-backed single-contributor MPC setup completed. Downstream preprocess/prove/verify can now use {}",
        config.output
    );
    Ok(())
}
