use clap::Parser;
use libs::cli::render_error;
use libs::subcircuit_library::try_resolve_subcircuit_library_path;
use mpc_setup::{run_native_mpc_setup, NativeMpcSetupConfig, LOCAL_SUBCIRCUIT_LIBRARY_PATH};
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    /// Intermediate ceremony artifact directory
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
    run_native_mpc_setup(&NativeMpcSetupConfig {
        qap_path,
        intermediate: config.intermediate,
        output: config.output.clone(),
        beacon_mode: config.beacon_mode,
        seed_input: config.seed_input,
    })?;

    println!(
        "Native single-contributor MPC setup completed. Its CRS is not publication-eligible, but downstream preprocess, prove, and verify may use it when its compatibility metadata matches the selected subcircuit library: {}",
        config.output
    );
    Ok(())
}
