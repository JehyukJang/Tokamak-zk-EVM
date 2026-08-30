use std::path::{Path, PathBuf};
use std::process::Command;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../common/contracts/fixtures/publication-admission")
        .join(name)
}

#[test]
fn workflow_command_accepts_the_shared_publication_fixture() {
    let result = Command::new(env!("CARGO_BIN_EXE_check_crs_publication"))
        .arg(fixture("accepted"))
        .output()
        .expect("publication admission command must run");

    assert!(
        result.status.success(),
        "accepted fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn workflow_command_rejects_the_shared_consumer_only_fixture() {
    let result = Command::new(env!("CARGO_BIN_EXE_check_crs_publication"))
        .arg(fixture("consumer-compatible-ineligible"))
        .output()
        .expect("publication admission command must run");

    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr)
        .contains("only release-eligible CRS artifacts may be published"));
}
