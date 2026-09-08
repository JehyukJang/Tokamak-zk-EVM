use clap::Parser;
use libs::cli::render_error;
use libs::subcircuit_library::{
    try_resolve_subcircuit_library_path, validate_operational_crs_compatibility,
    DevelopmentCrsProvenanceArg, SubcircuitLibraryArg,
};
use libs::utils::try_check_device;
use std::path::PathBuf;
use std::process::ExitCode;
use verify::{univariate_cli, VerifyError, VerifyInputPaths};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    #[command(flatten)]
    subcircuit_library: SubcircuitLibraryArg,

    #[command(flatten)]
    development_crs_provenance: DevelopmentCrsProvenanceArg,

    /// CRS output directory containing univariate_crs.rkyv
    #[arg(long, value_name = "PATH")]
    crs: String,

    /// Synthesizer output directory containing selector, permutation, and instance
    #[arg(long, value_name = "PATH")]
    synthesizer_stat: String,

    /// Preprocess output directory containing preprocess.json
    #[arg(long, value_name = "PATH")]
    preprocess: String,

    /// Proof output directory containing univariate_proof.json
    #[arg(long, value_name = "PATH")]
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
    let qap_library_path =
        try_resolve_subcircuit_library_path(config.subcircuit_library.as_deref())?;
    validate_operational_crs_compatibility(
        &config.development_crs_provenance,
        PathBuf::from(&config.crs).as_path(),
        qap_library_path.as_path(),
    )?;
    let qap_path = qap_library_path.to_string_lossy().into_owned();

    let paths = VerifyInputPaths {
        qap_path: &qap_path,
        synthesizer_path: &config.synthesizer_stat,
        setup_path: &config.crs,
        preprocess_path: &config.preprocess,
        proof_path: &config.proof,
    };

    try_check_device()?;

    if !verification_result_json {
        println!("Univariate verifier configuration admission...");
    }
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
