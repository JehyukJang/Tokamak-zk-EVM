use clap::Parser;
use libs::cli::render_error;
use libs::subcircuit_library::{try_resolve_subcircuit_library_path, SubcircuitLibraryArg};
use std::process::ExitCode;
use trusted_setup::{run_trusted_setup, TrustedSetupConfig, TrustedSetupError};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    #[command(flatten)]
    subcircuit_library: SubcircuitLibraryArg,

    #[cfg(feature = "testing-mode")]
    #[arg(long, value_name = "PATH")]
    synthesizer_stat: String,

    #[arg(long, value_name = "PATH")]
    output: String,

    #[arg(long, default_value_t = false)]
    fixed_tau: bool,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => render_error(&error),
    }
}

fn run() -> Result<(), TrustedSetupError> {
    let config = Config::parse();
    let qap_path = try_resolve_subcircuit_library_path(config.subcircuit_library.as_deref())?;
    let qap_path = qap_path.to_string_lossy();
    let setup_config = TrustedSetupConfig {
        qap_path: &qap_path,
        output_path: &config.output,
        fixed_tau: config.fixed_tau,
        #[cfg(feature = "testing-mode")]
        synthesizer_path: &config.synthesizer_stat,
    };
    run_trusted_setup(&setup_config)
}
