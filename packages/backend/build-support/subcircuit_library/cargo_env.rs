use super::input_origin_contract::SubcircuitLibraryOrigin;
use super::{ResolvedSubcircuitLibrary, DECLARED_RANGE, PACKAGE_NAME, RUNTIME_MODE};
use std::fs;
use std::io;

pub(crate) fn emit_build_metadata(
    snapshot: &ResolvedSubcircuitLibrary,
    current_package_name: &str,
    current_package_version: &str,
    compatible_backend_version: &str,
) -> io::Result<()> {
    let metadata = serde_json::json!({
        "dependencies": {
            "subcircuitLibrary": {
                "buildVersion": snapshot.version,
                "declaredRange": DECLARED_RANGE,
                "packageName": PACKAGE_NAME,
                "runtimeMode": RUNTIME_MODE,
            }
        },
        "packageName": current_package_name,
        "packageVersion": current_package_version,
        "compatibleBackendVersion": compatible_backend_version,
    });
    fs::write(
        snapshot
            .release_dir
            .join(format!("build-metadata-{current_package_name}.json")),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&metadata).map_err(io::Error::other)?
        ),
    )
}

pub(crate) fn emit_subcircuit_library_build_env(version: &str, compatible_backend_version: &str) {
    println!(
        "cargo:rustc-env=TOKAMAK_ZKEVM_COMPATIBLE_BACKEND_VERSION={compatible_backend_version}"
    );
    println!("cargo:rustc-env=TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME={PACKAGE_NAME}");
    println!("cargo:rustc-env=TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION={version}");
}

pub(crate) fn emit_mpc_subcircuit_library_build_env(
    version: &str,
    compatible_backend_version: &str,
    origin: SubcircuitLibraryOrigin,
) {
    emit_subcircuit_library_build_env(version, compatible_backend_version);
    println!(
        "cargo:rustc-env=TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_ORIGIN={}",
        origin.as_str()
    );
}
