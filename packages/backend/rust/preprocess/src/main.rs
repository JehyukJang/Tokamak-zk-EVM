use clap::Parser;
use libs::cli::render_error;
use libs::errors::{ArtifactError, CrsError};
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use libs::crs_artifacts::{
    read_univariate_tau_sequence_with_digest, read_univariate_verifier_keys,
    VERIFIER_KEYS_RKYV_FILE_NAME,
};
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::{read_placement_selector, Permutation, SubcircuitInfo};
use libs::subcircuit_library::{
    validate_operational_univariate_crs_compatibility, DevelopmentCrsProvenanceArg,
    SubcircuitLibraryArg,
};
use libs::univariate_preprocess::AdmittedUnivariateVerifierConfig;
use libs::utils::{try_check_device, try_load_setup_params_from_qap_path};
use preprocess::{generate_univariate_preprocess, PreprocessError, PreprocessInputPaths};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    #[command(flatten)]
    subcircuit_library: SubcircuitLibraryArg,

    #[command(flatten)]
    development_crs_provenance: DevelopmentCrsProvenanceArg,

    /// Phase 1 tau_sequence.rkyv file
    #[arg(long, value_name = "FILE")]
    tau_sequence: String,

    /// Phase 2 output directory containing verifier_keys.rkyv
    #[arg(long, value_name = "PATH")]
    keys: String,

    /// Synthesizer output directory containing selector.json and permutation.json
    #[arg(long, value_name = "PATH")]
    synthesizer_stat: String,

    /// Output directory for verifier_config.json
    #[arg(long, value_name = "PATH")]
    output: String,
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

fn run() -> Result<(), PreprocessError> {
    let config = Config::parse();
    let qap_library_path = libs::subcircuit_library::try_resolve_subcircuit_library_path(
        config.subcircuit_library.as_deref(),
    )?;
    validate_operational_univariate_crs_compatibility(
        &config.development_crs_provenance,
        PathBuf::from(&config.tau_sequence).as_path(),
        PathBuf::from(&config.keys).as_path(),
        qap_library_path.as_path(),
    )?;
    let qap_path = qap_library_path.to_string_lossy().into_owned();

    let paths = PreprocessInputPaths {
        qap_path: &qap_path,
        synthesizer_path: &config.synthesizer_stat,
        tau_sequence_path: &config.tau_sequence,
        keys_path: &config.keys,
        output_path: &config.output,
    };

    try_check_device()?;

    let setup_params = try_load_setup_params_from_qap_path(paths.qap_path)?;
    let tau_path = PathBuf::from(paths.tau_sequence_path);
    let (crs, tau_digest) =
        read_univariate_tau_sequence_with_digest(&tau_path).map_err(|source| CrsError::Read {
            path: tau_path,
            source,
        })?;

    let info_path = PathBuf::from(paths.qap_path).join("subcircuitInfo.json");
    let infos = SubcircuitInfo::read_box_from_json(info_path.clone()).map_err(|source| {
        ArtifactError::Read {
            artifact: "subcircuit information",
            path: info_path,
            source,
        }
    })?;
    let global_wire_path = PathBuf::from(paths.qap_path).join("globalWireList.json");
    let global_wires =
        read_global_wires(&global_wire_path).map_err(|source| ArtifactError::Read {
            artifact: "global wire list",
            path: global_wire_path.clone(),
            source,
        })?;
    let public_layout =
        PublicWireLayout::derive(&setup_params, &global_wires, &infos).map_err(|error| {
            ArtifactError::Invalid {
                artifact: "public wire layout",
                path: global_wire_path,
                reason: error.to_string(),
            }
        })?;
    let keys_dir = PathBuf::from(paths.keys_path);
    let verifier_keys =
        read_univariate_verifier_keys(&keys_dir, &setup_params, &public_layout, tau_digest)
            .map_err(|source| CrsError::Read {
                path: keys_dir.join(VERIFIER_KEYS_RKYV_FILE_NAME),
                source,
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
    let selector_path = PathBuf::from(paths.synthesizer_path).join("selector.json");
    let selector = read_placement_selector(&selector_path, setup_params.s_max, setup_params.s_D)
        .map_err(|source| ArtifactError::Read {
            artifact: "placement selector",
            path: selector_path,
            source,
        })?;
    let preprocess =
        generate_univariate_preprocess(&crs, &selector, &permutation_raw, &setup_params).map_err(
            |reason| ArtifactError::Invalid {
                artifact: "preprocess frontend input",
                path: PathBuf::from(paths.synthesizer_path),
                reason: reason.to_string(),
            },
        )?;
    let admitted = AdmittedUnivariateVerifierConfig::from_admitted_circuit(
        &verifier_keys,
        preprocess,
        &public_layout,
    )
    .map_err(|reason| ArtifactError::Invalid {
        artifact: "univariate verifier keys",
        path: keys_dir.join(VERIFIER_KEYS_RKYV_FILE_NAME),
        reason,
    })?;
    let output_path = PathBuf::from(paths.output_path).join("verifier_config.json");
    let output =
        serde_json::to_vec_pretty(&admitted).map_err(|source| PreprocessError::WriteOutput {
            path: output_path.clone(),
            source: std::io::Error::other(source),
        })?;
    fs::create_dir_all(PathBuf::from(paths.output_path)).map_err(|source| {
        PreprocessError::WriteOutput {
            path: PathBuf::from(paths.output_path),
            source,
        }
    })?;
    let temporary_path = output_path.with_extension(format!("json.tmp-{}", std::process::id()));
    fs::write(&temporary_path, output).map_err(|source| PreprocessError::WriteOutput {
        path: temporary_path.clone(),
        source,
    })?;
    fs::rename(&temporary_path, &output_path).map_err(|source| PreprocessError::WriteOutput {
        path: output_path,
        source,
    })?;

    Ok(())
}
