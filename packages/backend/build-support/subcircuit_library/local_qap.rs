use super::{
    acquire_lock, ensure_qap_compiler_dependencies, integrity, qap_compiler_root,
    read_qap_compiler_version, release_dir_from_out_dir, run_qap_compiler_build,
    LocalSubcircuitLibrary, LOCAL_BUILD_LOCK_FILE, LOCAL_BUILD_ROOT_DIR, SNAPSHOT_CIRCOM_DIR,
    SNAPSHOT_CONSTANTS_FILE,
};
use std::fs;
use std::io;
use std::time::Duration;

pub(crate) fn prepare_local_subcircuit_library() -> io::Result<LocalSubcircuitLibrary> {
    let profile_dir = release_dir_from_out_dir()?;
    let build_root = profile_dir.join(LOCAL_BUILD_ROOT_DIR);
    fs::create_dir_all(&build_root)?;
    let _guard = acquire_lock(&build_root.join(LOCAL_BUILD_LOCK_FILE))?;

    let qap_root = qap_compiler_root()?;
    let version = read_qap_compiler_version(&qap_root)?;
    ensure_qap_compiler_dependencies(&qap_root)?;
    let staging_root = build_root.join(format!(
        "staging-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_nanos()
    ));
    let staging_library_dir = staging_root.join("library");
    if staging_root.exists() {
        fs::remove_dir_all(&staging_root)?;
    }
    run_qap_compiler_build(&qap_root, &staging_library_dir)?;
    let staging_constants_path = staging_root
        .join(SNAPSHOT_CIRCOM_DIR)
        .join(SNAPSHOT_CONSTANTS_FILE);
    fs::create_dir_all(staging_root.join(SNAPSHOT_CIRCOM_DIR))?;
    fs::copy(
        qap_root
            .join("subcircuits")
            .join(SNAPSHOT_CIRCOM_DIR)
            .join(SNAPSHOT_CONSTANTS_FILE),
        &staging_constants_path,
    )?;
    if !staging_library_dir.join("setupParams.json").exists() {
        return Err(io::Error::other(format!(
            "local qap-compiler build did not produce {}",
            staging_library_dir.join("setupParams.json").display()
        )));
    }

    let source_digest =
        integrity::digest_subcircuit_source(&staging_constants_path, &staging_library_dir)?;
    let snapshot_dir = build_root.join(format!(
        "{}-{}",
        integrity::sanitize(&version),
        integrity::sanitize(&source_digest)
    ));
    let library_dir = snapshot_dir.join("library");
    if !library_dir.exists() {
        if snapshot_dir.exists() {
            fs::remove_dir_all(&snapshot_dir)?;
        }
        fs::rename(&staging_root, &snapshot_dir)?;
    } else {
        let _ = fs::remove_dir_all(&staging_root);
    }
    Ok(LocalSubcircuitLibrary {
        version,
        library_dir,
    })
}
