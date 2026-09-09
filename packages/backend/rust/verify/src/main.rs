use clap::Parser;
use libs::cli::render_error;
use libs::utils::try_check_device;
use std::process::ExitCode;
use verify::{univariate_cli, OnlineVerifyInputPaths, VerifyError};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    /// Admitted verifier_config.json emitted by preprocess
    #[arg(long, value_name = "FILE")]
    verifier_config: String,

    /// Public instance.json emitted by the synthesizer
    #[arg(long, value_name = "FILE")]
    instance: String,

    /// univariate_proof.json emitted by prove
    #[arg(long, value_name = "FILE")]
    proof: String,

    /// Emit only the versioned machine-readable verification result on stdout
    #[arg(long, hide = true)]
    verification_result_json: bool,
}

fn main() -> ExitCode {
    match libs::cli::print_backend_build_identity_if_requested(
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        option_env!("TOKAMAK_ZKEVM_COMPATIBLE_BACKEND_VERSION"),
        option_env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION"),
        option_env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_SOURCE_DIGEST"),
    ) {
        Ok(true) => return ExitCode::SUCCESS,
        Ok(false) => {}
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => render_error(&error),
    }
}

fn run() -> Result<(), VerifyError> {
    let config = Config::parse();
    let verification_result_json = config.verification_result_json;
    let paths = OnlineVerifyInputPaths {
        verifier_config_path: &config.verifier_config,
        instance_path: &config.instance,
        proof_path: &config.proof,
    };

    try_check_device()?;

    if !verification_result_json {
        println!("Verifying the proof...");
    }
    let res_snark = univariate_cli::verify(&paths)?;
    if verification_result_json {
        libs::cli::print_verification_result(res_snark)
            .map_err(|reason| VerifyError::MachineResult { reason })?;
    } else {
        println!("{}", res_snark);
    }

    Ok(())
}
