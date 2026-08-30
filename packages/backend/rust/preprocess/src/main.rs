use clap::Parser;
use libs::cli::render_error;
use libs::errors::{ArtifactError, CrsError};
use std::fs::File;
use std::path::PathBuf;
use std::process::ExitCode;

use libs::crs_artifacts::SigmaPreprocessRkyv;
use libs::frontend_artifacts::{Instance, Permutation};
use libs::subcircuit_library::{
    validate_operational_crs_compatibility, DevelopmentCrsProvenanceArg, SubcircuitLibraryArg,
};
use libs::utils::{try_check_device, try_load_setup_params_from_qap_path};
use memmap2::Mmap;
use preprocess::{generate_preprocess, PreprocessError, PreprocessInputPaths};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    #[command(flatten)]
    subcircuit_library: SubcircuitLibraryArg,

    #[command(flatten)]
    development_crs_provenance: DevelopmentCrsProvenanceArg,

    /// CRS output directory containing sigma_preprocess.rkyv
    #[arg(long, value_name = "PATH")]
    crs: String,

    /// Synthesizer output directory containing instance and permutation JSON files
    #[arg(long, value_name = "PATH")]
    synthesizer_stat: String,

    /// Output directory for preprocess.json
    #[arg(long, value_name = "PATH")]
    output: String,
}

fn main() -> ExitCode {
    match libs::cli::print_backend_build_identity_if_requested(
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        option_env!("TOKAMAK_ZKEVM_COMPATIBLE_BACKEND_VERSION"),
        option_env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION"),
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

fn run() -> Result<(), PreprocessError> {
    let config = Config::parse();
    let qap_library_path = libs::subcircuit_library::try_resolve_subcircuit_library_path(
        config.subcircuit_library.as_deref(),
    )?;
    validate_operational_crs_compatibility(
        &config.development_crs_provenance,
        PathBuf::from(&config.crs).as_path(),
        qap_library_path.as_path(),
    )?;
    let qap_path = qap_library_path.to_string_lossy().into_owned();

    let paths = PreprocessInputPaths {
        qap_path: &qap_path,
        synthesizer_path: &config.synthesizer_stat,
        setup_path: &config.crs,
        output_path: &config.output,
    };

    try_check_device()?;

    let setup_params = try_load_setup_params_from_qap_path(paths.qap_path)?;
    let sigma_path = PathBuf::from(paths.setup_path).join("sigma_preprocess.rkyv");
    let file = File::open(&sigma_path).map_err(|source| CrsError::Read {
        path: sigma_path.clone(),
        source,
    })?;
    let mmap = unsafe { Mmap::map(&file) }.map_err(|error| CrsError::Invalid {
        path: sigma_path.clone(),
        reason: format!("failed to memory-map archive: {error}"),
    })?;
    let sigma = rkyv::check_archived_root::<SigmaPreprocessRkyv>(&mmap).map_err(|error| {
        CrsError::Invalid {
            path: sigma_path,
            reason: format!("invalid rkyv archive: {error}"),
        }
    })?;

    let permutation_path = PathBuf::from(paths.synthesizer_path).join("permutation.json");
    let permutation_raw =
        Permutation::read_box_from_json(permutation_path.clone()).map_err(|source| {
            ArtifactError::Read {
                artifact: "permutation",
                path: permutation_path,
                source,
            }
        })?;
    let instance_path = PathBuf::from(paths.synthesizer_path).join("instance.json");
    let instance =
        Instance::read_from_json(instance_path.clone()).map_err(|source| ArtifactError::Read {
            artifact: "public instance",
            path: instance_path,
            source,
        })?;
    let preprocess = generate_preprocess(&sigma, &permutation_raw, &instance, &setup_params)
        .map_err(|reason| ArtifactError::Invalid {
            artifact: "preprocess frontend input",
            path: PathBuf::from(paths.synthesizer_path),
            reason,
        })?;
    let formatted_preprocess = preprocess.convert_format_for_solidity_verifier();
    let output_path = PathBuf::from(paths.output_path).join("preprocess.json");
    formatted_preprocess
        .write_into_json(output_path.clone())
        .map_err(|source| PreprocessError::WriteOutput {
            path: output_path,
            source,
        })?;

    Ok(())
}
