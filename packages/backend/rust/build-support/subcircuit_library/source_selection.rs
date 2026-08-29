use super::{
    integrity, local_qap, prepare_production_npm_subcircuit_library,
    read_cli_compatible_backend_version, types::LocalSubcircuitLibrary, ResolvedSubcircuitLibrary,
};
use std::env;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SelectedInputOrigin {
    LocalQapCompiler,
    NpmSnapshot,
}

pub(crate) fn selected_input_origin() -> io::Result<SelectedInputOrigin> {
    let local = env::var_os("CARGO_FEATURE_LOCAL_DEVELOPMENT_SUBCIRCUIT_LIBRARY").is_some();
    let production = env::var_os("CARGO_FEATURE_PRODUCTION_NPM_SUBCIRCUIT_LIBRARY").is_some();
    match (local, production) {
        (true, false) => Ok(SelectedInputOrigin::LocalQapCompiler),
        (false, true) => Ok(SelectedInputOrigin::NpmSnapshot),
        (true, true) => Err(io::Error::other(
            "local-development-subcircuit-library and production-npm-subcircuit-library cannot be enabled together",
        )),
        (false, false) => Err(io::Error::other(
            "select either local-development-subcircuit-library or production-npm-subcircuit-library",
        )),
    }
}

pub(crate) fn emit_input_origin_rerun_rules() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_LOCAL_DEVELOPMENT_SUBCIRCUIT_LIBRARY");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_PRODUCTION_NPM_SUBCIRCUIT_LIBRARY");
}

pub(crate) enum MpcSubcircuitLibrary {
    NpmSnapshot(ResolvedSubcircuitLibrary),
    LocalQapCompiler(LocalSubcircuitLibrary),
}

pub(crate) struct MpcSubcircuitLibrarySelection {
    pub(crate) compatible_backend_version: String,
    pub(crate) source: MpcSubcircuitLibrary,
}

pub(crate) fn select_mpc_subcircuit_library(
    package_version: &str,
) -> io::Result<MpcSubcircuitLibrarySelection> {
    let compatible_backend_version = read_cli_compatible_backend_version(package_version)?;
    match selected_input_origin()? {
        SelectedInputOrigin::NpmSnapshot => {
            let snapshot = prepare_production_npm_subcircuit_library(package_version)?;
            integrity::validate_release_mpc_library_compatibility(
                &snapshot.version,
                &compatible_backend_version,
            )?;
            println!("cargo:rustc-cfg=tokamak_production_npm_subcircuit_library");
            Ok(MpcSubcircuitLibrarySelection {
                compatible_backend_version,
                source: MpcSubcircuitLibrary::NpmSnapshot(snapshot),
            })
        }
        SelectedInputOrigin::LocalQapCompiler => {
            super::emit_local_qap_rerun_rules();
            Ok(MpcSubcircuitLibrarySelection {
                compatible_backend_version,
                source: MpcSubcircuitLibrary::LocalQapCompiler(
                    local_qap::prepare_local_subcircuit_library()?,
                ),
            })
        }
    }
}
