use super::{
    integrity, local_development_subcircuit_library_selected, prepare_local_subcircuit_library,
    prepare_release_subcircuit_library, read_cli_compatible_backend_version,
    LocalSubcircuitLibrary, ResolvedSubcircuitLibrary,
};
use std::env;
use std::io;

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
    if env::var("PROFILE").ok().as_deref() == Some("release")
        && !local_development_subcircuit_library_selected()
    {
        let snapshot = prepare_release_subcircuit_library()?.ok_or_else(|| {
            io::Error::other("release MPC setup requires an npm subcircuit-library snapshot")
        })?;
        integrity::validate_release_mpc_library_compatibility(
            &snapshot.version,
            &compatible_backend_version,
        )?;
        return Ok(MpcSubcircuitLibrarySelection {
            compatible_backend_version,
            source: MpcSubcircuitLibrary::NpmSnapshot(snapshot),
        });
    }

    super::emit_local_qap_rerun_rules();
    Ok(MpcSubcircuitLibrarySelection {
        compatible_backend_version,
        source: MpcSubcircuitLibrary::LocalQapCompiler(prepare_local_subcircuit_library()?),
    })
}
