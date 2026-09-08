use clap::Parser;
use libs::cli::render_error;
use libs::errors::{ArtifactError, CrsError};
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use libs::crs_artifacts::{read_univariate_crs_artifact, UNIVARIATE_CRS_RKYV_FILE_NAME};
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::{read_placement_selector, Permutation, SubcircuitInfo};
use libs::r1cs::SubcircuitR1CS;
use libs::subcircuit_library::SubcircuitLibraryArg;
use libs::utils::{try_check_device, try_load_setup_params_from_qap_path};
use preprocess::{generate_univariate_preprocess, PreprocessError, PreprocessInputPaths};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Config {
    #[command(flatten)]
    subcircuit_library: SubcircuitLibraryArg,

    /// CRS output directory containing univariate_crs.rkyv
    #[arg(long, value_name = "PATH")]
    crs: String,

    /// Synthesizer output directory containing selector.json and permutation.json
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
    let qap_path = qap_library_path.to_string_lossy().into_owned();

    let paths = PreprocessInputPaths {
        qap_path: &qap_path,
        synthesizer_path: &config.synthesizer_stat,
        setup_path: &config.crs,
        output_path: &config.output,
    };

    try_check_device()?;

    let setup_params = try_load_setup_params_from_qap_path(paths.qap_path)?;
    let subcircuit_infos_path = PathBuf::from(paths.qap_path).join("subcircuitInfo.json");
    let subcircuit_infos = SubcircuitInfo::read_box_from_json(subcircuit_infos_path.clone())
        .map_err(|source| ArtifactError::Read {
            artifact: "subcircuit information",
            path: subcircuit_infos_path,
            source,
        })?;
    let global_wire_list_path = PathBuf::from(paths.qap_path).join("globalWireList.json");
    let global_wires =
        read_global_wires(&global_wire_list_path).map_err(|source| ArtifactError::Read {
            artifact: "global wire list",
            path: global_wire_list_path.clone(),
            source,
        })?;
    let public_wire_layout =
        PublicWireLayout::derive(&setup_params, &global_wires, &subcircuit_infos).map_err(
            |error| ArtifactError::Invalid {
                artifact: "public wire layout",
                path: global_wire_list_path,
                reason: error.to_string(),
            },
        )?;
    let r1cs = subcircuit_infos
        .iter()
        .enumerate()
        .map(|(index, info)| {
            if info.id != index {
                return Err(ArtifactError::Invalid {
                    artifact: "subcircuit information",
                    path: PathBuf::from(paths.qap_path).join("subcircuitInfo.json"),
                    reason: format!("catalog entry {index} declares subcircuit ID {}", info.id),
                });
            }
            let path = PathBuf::from(paths.qap_path).join(format!("r1cs/subcircuit{index}.r1cs"));
            SubcircuitR1CS::from_r1cs_sparse_only(path.clone(), &setup_params, info).map_err(
                |source| ArtifactError::Read {
                    artifact: "subcircuit R1CS",
                    path,
                    source,
                },
            )
        })
        .collect::<Result<Vec<_>, _>>()?;
    let subcircuits = r1cs
        .iter()
        .zip(subcircuit_infos.iter())
        .map(|(r1cs, info)| r1cs.as_univariate_subcircuit(info))
        .collect::<Vec<_>>();
    let crs_path = PathBuf::from(paths.setup_path).join(UNIVARIATE_CRS_RKYV_FILE_NAME);
    let crs =
        read_univariate_crs_artifact(&crs_path, &setup_params, &public_wire_layout, &subcircuits)
            .map_err(|source| CrsError::Read {
            path: crs_path,
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
    let output_path = PathBuf::from(paths.output_path).join("preprocess.json");
    let output =
        serde_json::to_vec_pretty(&preprocess).map_err(|source| PreprocessError::WriteOutput {
            path: output_path.clone(),
            source: std::io::Error::other(source),
        })?;
    fs::create_dir_all(PathBuf::from(paths.output_path)).map_err(|source| {
        PreprocessError::WriteOutput {
            path: PathBuf::from(paths.output_path),
            source,
        }
    })?;
    fs::write(&output_path, output).map_err(|source| PreprocessError::WriteOutput {
        path: output_path,
        source,
    })?;

    Ok(())
}
