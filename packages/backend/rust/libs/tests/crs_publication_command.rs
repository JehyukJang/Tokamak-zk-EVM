#![cfg(feature = "testing-mode")]

use libs::compatibility::compatibility_from_package_version;
use libs::crs_provenance::final_mpc_crs_archive_root_file_names;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const SOURCE_DIGEST: &str =
    "sha256:2222222222222222222222222222222222222222222222222222222222222222";

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../common/contracts/fixtures/publication-admission")
        .join(name)
}

fn current_compatibility() -> String {
    compatibility_from_package_version(env!("CARGO_PKG_VERSION"))
        .expect("crate version must be canonical")
        .to_string()
}

fn prepare_fixture(
    name: &str,
    compatible_version: &str,
    package_version: &str,
    source_digest: &str,
) -> tempfile::TempDir {
    let workspace = tempfile::tempdir().expect("must create command fixture workspace");
    for file_name in
        final_mpc_crs_archive_root_file_names().expect("archive contract must be valid")
    {
        fs::copy(
            fixture(name).join(&file_name),
            workspace.path().join(&file_name),
        )
        .expect("must copy stable semantic fixture");
    }

    let provenance_path = workspace.path().join("crs_provenance.json");
    let mut provenance: Value = serde_json::from_slice(
        &fs::read(&provenance_path).expect("must read copied provenance"),
    )
    .expect("must parse copied provenance");
    provenance["compatibleBackendVersion"] = Value::String(compatible_version.to_string());
    provenance["subcircuitLibrary"]["packageName"] =
        Value::String("@tokamak-zk-evm/subcircuit-library".to_string());
    provenance["subcircuitLibrary"]["packageVersion"] =
        Value::String(package_version.to_string());
    provenance["subcircuitLibrary"]["sourceDigest"] =
        Value::String(source_digest.to_string());
    fs::write(
        provenance_path,
        serde_json::to_vec_pretty(&provenance).expect("must serialize current identity fixture"),
    )
    .expect("must write current identity fixture");
    workspace
}

fn run_command(
    fixture_directory: &Path,
    compatible_version: &str,
    package_version: &str,
    source_digest: &str,
) -> Output {
    Command::new(env!("CARGO_BIN_EXE_check_crs_publication"))
        .arg(fixture_directory)
        .env(
            "TOKAMAK_ZKEVM_TEST_PUBLICATION_COMPATIBILITY",
            compatible_version,
        )
        .env(
            "TOKAMAK_ZKEVM_TEST_PUBLICATION_PACKAGE_VERSION",
            package_version,
        )
        .env(
            "TOKAMAK_ZKEVM_TEST_PUBLICATION_SOURCE_DIGEST",
            source_digest,
        )
        .output()
        .expect("publication admission command must run")
}

#[test]
fn workflow_command_accepts_the_shared_fixture_with_the_crate_identity() {
    let compatibility = current_compatibility();
    let fixture = prepare_fixture(
        "accepted",
        &compatibility,
        env!("CARGO_PKG_VERSION"),
        SOURCE_DIGEST,
    );
    let result = run_command(
        fixture.path(),
        &compatibility,
        env!("CARGO_PKG_VERSION"),
        SOURCE_DIGEST,
    );

    assert!(
        result.status.success(),
        "accepted fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn workflow_command_rejects_the_shared_consumer_only_fixture() {
    let compatibility = current_compatibility();
    let fixture = prepare_fixture(
        "consumer-compatible-ineligible",
        &compatibility,
        env!("CARGO_PKG_VERSION"),
        SOURCE_DIGEST,
    );
    let result = run_command(
        fixture.path(),
        &compatibility,
        env!("CARGO_PKG_VERSION"),
        SOURCE_DIGEST,
    );

    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("only release-eligible CRS artifacts may be published"));
}

#[test]
fn actual_command_accepts_an_isolated_3_0_0_transition_fixture() {
    let fixture = prepare_fixture("accepted", "3.0", "3.0.0", SOURCE_DIGEST);
    let result = run_command(fixture.path(), "3.0", "3.0.0", SOURCE_DIGEST);

    assert!(
        result.status.success(),
        "3.0.0 transition fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("compatibility=3.0"));
}
