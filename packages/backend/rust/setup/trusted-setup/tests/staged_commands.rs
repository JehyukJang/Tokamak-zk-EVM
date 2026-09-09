use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[test]
fn stage_two_reuses_a_persisted_stage_one_generation() {
    let workspace = tempfile::tempdir().expect("must create temporary workspace");
    let library = create_minimal_library(workspace.path());
    let tau_output = workspace.path().join("tau-active");
    let keys_a = workspace.path().join("keys-a");
    let keys_b = workspace.path().join("keys-b");

    run(&[
        "generate-tau-sequence",
        "--l0",
        "16",
        "--l-xi",
        "9",
        "--l-psi",
        "19",
        "--l2",
        "10",
        "--output",
        path(&tau_output),
        "--fixed-tau",
    ]);
    assert!(tau_output.join("tau_sequence.rkyv").is_file());
    assert!(tau_output.join("crs_provenance.json").is_file());
    let original_tau = fs::read(tau_output.join("tau_sequence.rkyv")).unwrap();

    for output in [&keys_a, &keys_b] {
        run(&[
            "specialize-library",
            "--subcircuit-library",
            path(&library),
            "--tau-sequence",
            path(&tau_output.join("tau_sequence.rkyv")),
            "--tau-provenance",
            path(&tau_output.join("crs_provenance.json")),
            "--output",
            path(output),
        ]);
        assert!(output.join("prover_keys.rkyv").is_file());
        assert!(output.join("verifier_keys.rkyv").is_file());
        assert!(output.join("crs_provenance.json").is_file());
        assert!(!output.join("tau_sequence.rkyv").exists());
    }

    assert_eq!(
        fs::read(tau_output.join("tau_sequence.rkyv")).unwrap(),
        original_tau,
        "stage two must not alter the persisted stage-one generation"
    );
    assert_ne!(
        fs::read(keys_a.join("prover_keys.rkyv")).unwrap(),
        fs::read(keys_b.join("prover_keys.rkyv")).unwrap(),
        "fresh stage-two role scalars must specialize the same tau sequence differently"
    );
}

#[test]
fn stage_two_rejects_insufficient_terminal_capacities() {
    let workspace = tempfile::tempdir().expect("must create temporary workspace");
    let library = create_minimal_library(workspace.path());
    for (label, l0, l_xi, l_psi, l2) in [
        ("l0", 15, 9, 19, 10),
        ("l-xi", 16, 8, 19, 10),
        ("l-psi", 16, 9, 18, 10),
        ("l2", 16, 9, 19, 9),
    ] {
        let tau_output = workspace.path().join(format!("tau-{label}"));
        let keys_output = workspace.path().join(format!("keys-{label}"));
        let capacities = [
            l0.to_string(),
            l_xi.to_string(),
            l_psi.to_string(),
            l2.to_string(),
        ];
        run(&[
            "generate-tau-sequence",
            "--l0",
            &capacities[0],
            "--l-xi",
            &capacities[1],
            "--l-psi",
            &capacities[2],
            "--l2",
            &capacities[3],
            "--output",
            path(&tau_output),
            "--fixed-tau",
        ]);
        run_expect_failure(&[
            "specialize-library",
            "--subcircuit-library",
            path(&library),
            "--tau-sequence",
            path(&tau_output.join("tau_sequence.rkyv")),
            "--tau-provenance",
            path(&tau_output.join("crs_provenance.json")),
            "--output",
            path(&keys_output),
        ]);
        assert!(!keys_output.exists());
    }
}

#[test]
fn stage_two_rejects_a_tau_provenance_digest_mismatch() {
    let workspace = tempfile::tempdir().expect("must create temporary workspace");
    let library = create_minimal_library(workspace.path());
    let tau_output = workspace.path().join("tau-active");
    let keys_output = workspace.path().join("keys-active");
    run(&[
        "generate-tau-sequence",
        "--l0",
        "16",
        "--l-xi",
        "9",
        "--l-psi",
        "19",
        "--l2",
        "10",
        "--output",
        path(&tau_output),
        "--fixed-tau",
    ]);
    let provenance_path = tau_output.join("crs_provenance.json");
    let mut provenance: serde_json::Value =
        serde_json::from_slice(&fs::read(&provenance_path).unwrap()).unwrap();
    provenance["tauSequenceRkyvSha256"] = serde_json::Value::String("0".repeat(64));
    fs::write(
        &provenance_path,
        serde_json::to_vec_pretty(&provenance).unwrap(),
    )
    .unwrap();
    run_expect_failure(&[
        "specialize-library",
        "--subcircuit-library",
        path(&library),
        "--tau-sequence",
        path(&tau_output.join("tau_sequence.rkyv")),
        "--tau-provenance",
        path(&provenance_path),
        "--output",
        path(&keys_output),
    ]);
    assert!(!keys_output.exists());
}

#[test]
fn stage_two_rejects_a_corrupt_tau_archive() {
    let workspace = tempfile::tempdir().expect("must create temporary workspace");
    let library = create_minimal_library(workspace.path());
    let tau_output = workspace.path().join("tau-active");
    let keys_output = workspace.path().join("keys-active");
    generate_minimal_tau(&tau_output);
    let archive_path = tau_output.join("tau_sequence.rkyv");
    let mut archive = fs::read(&archive_path).unwrap();
    let final_byte = archive.last_mut().expect("tau archive must not be empty");
    *final_byte ^= 1;
    fs::write(&archive_path, archive).unwrap();
    run_expect_failure(&[
        "specialize-library",
        "--subcircuit-library",
        path(&library),
        "--tau-sequence",
        path(&archive_path),
        "--tau-provenance",
        path(&tau_output.join("crs_provenance.json")),
        "--output",
        path(&keys_output),
    ]);
    assert!(!keys_output.exists());
}

#[test]
fn operational_admission_rejects_library_and_key_generation_mismatches() {
    let workspace = tempfile::tempdir().expect("must create temporary workspace");
    let library = create_minimal_library(workspace.path());
    let tau_output = workspace.path().join("tau-active");
    let keys_a = workspace.path().join("keys-a");
    let keys_b = workspace.path().join("keys-b");
    generate_minimal_tau(&tau_output);
    for output in [&keys_a, &keys_b] {
        run(&[
            "specialize-library",
            "--subcircuit-library",
            path(&library),
            "--tau-sequence",
            path(&tau_output.join("tau_sequence.rkyv")),
            "--tau-provenance",
            path(&tau_output.join("crs_provenance.json")),
            "--output",
            path(output),
        ]);
    }
    let development = libs::subcircuit_library::DevelopmentCrsProvenanceArg::default();
    let tau_path = tau_output.join("tau_sequence.rkyv");
    libs::subcircuit_library::validate_operational_univariate_crs_compatibility(
        &development,
        &tau_path,
        &keys_a,
        &library,
    )
    .expect("matching stage artifacts and library must be admitted");

    let constants = library.parent().unwrap().join("circom/constants.circom");
    let original_constants = fs::read(&constants).unwrap();
    fs::write(&constants, b"pragma circom 2.1.5;\n// changed library\n").unwrap();
    assert!(
        libs::subcircuit_library::validate_operational_univariate_crs_compatibility(
            &development,
            &tau_path,
            &keys_a,
            &library,
        )
        .is_err()
    );
    fs::write(constants, original_constants).unwrap();

    fs::copy(
        keys_b.join("verifier_keys.rkyv"),
        keys_a.join("verifier_keys.rkyv"),
    )
    .unwrap();
    assert!(
        libs::subcircuit_library::validate_operational_univariate_crs_compatibility(
            &development,
            &tau_path,
            &keys_a,
            &library,
        )
        .is_err()
    );
}

#[test]
#[ignore = "build release binaries first; this is the explicit native reference E2E"]
fn native_reference_e2e_uses_online_only_verification() {
    let workspace = tempfile::tempdir()
        .expect("must create temporary workspace")
        .keep();
    eprintln!("native reference E2E workspace: {}", workspace.display());
    let library = create_minimal_library(&workspace);
    let synthesizer = create_minimal_synthesizer_output(&workspace);
    let tau_output = workspace.join("tau-active");
    let keys_output = workspace.join("keys-active");
    let preprocess_output = workspace.join("preprocess");
    let proof_output = workspace.join("proof");

    run_release(
        "trusted-setup",
        &[
            "generate-tau-sequence",
            "--l0",
            "16",
            "--l-xi",
            "9",
            "--l-psi",
            "19",
            "--l2",
            "10",
            "--output",
            path(&tau_output),
            "--fixed-tau",
        ],
    );
    run_release(
        "trusted-setup",
        &[
            "specialize-library",
            "--subcircuit-library",
            path(&library),
            "--tau-sequence",
            path(&tau_output.join("tau_sequence.rkyv")),
            "--tau-provenance",
            path(&tau_output.join("crs_provenance.json")),
            "--output",
            path(&keys_output),
            "--fixed-role-scalars",
        ],
    );
    run_release(
        "preprocess",
        &[
            "--subcircuit-library",
            path(&library),
            "--tau-sequence",
            path(&tau_output.join("tau_sequence.rkyv")),
            "--keys",
            path(&keys_output),
            "--synthesizer-stat",
            path(&synthesizer),
            "--output",
            path(&preprocess_output),
        ],
    );
    run_release(
        "prove",
        &[
            "--subcircuit-library",
            path(&library),
            "--tau-sequence",
            path(&tau_output.join("tau_sequence.rkyv")),
            "--keys",
            path(&keys_output),
            "--synthesizer-stat",
            path(&synthesizer),
            "--output",
            path(&proof_output),
        ],
    );
    let verifier_config = preprocess_output.join("verifier_config.json");
    let instance = synthesizer.join("instance.json");
    let proof = proof_output.join("univariate_proof.json");
    let verify_args = [
        "--verifier-config",
        path(&verifier_config),
        "--instance",
        path(&instance),
        "--proof",
        path(&proof),
    ];
    let first = run_release("verify", &verify_args);
    let second = run_release("verify", &verify_args);
    assert!(
        String::from_utf8_lossy(&first.stdout).contains("true"),
        "first online verification did not accept:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(
        String::from_utf8_lossy(&second.stdout).contains("true"),
        "second online verification did not accept:\n{}",
        String::from_utf8_lossy(&second.stdout)
    );
}

fn run(args: &[&str]) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_trusted-setup"));
    command.args(args);
    let backend_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../external-lib/mac/lib/backend");
    if backend_dir.is_dir() {
        command.env("ICICLE_BACKEND_INSTALL_DIR", backend_dir);
    }
    let output = command.output().expect("trusted-setup command must start");
    assert!(
        output.status.success(),
        "trusted-setup failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn generate_minimal_tau(output: &Path) {
    run(&[
        "generate-tau-sequence",
        "--l0",
        "16",
        "--l-xi",
        "9",
        "--l-psi",
        "19",
        "--l2",
        "10",
        "--output",
        path(output),
        "--fixed-tau",
    ]);
}

fn run_expect_failure(args: &[&str]) {
    let output = trusted_setup_command(args)
        .output()
        .expect("trusted-setup command must start");
    assert!(
        !output.status.success(),
        "trusted-setup unexpectedly accepted invalid stage input\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn trusted_setup_command(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_trusted-setup"));
    command.args(args);
    let backend_dir =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../external-lib/mac/lib/backend");
    if backend_dir.is_dir() {
        command.env("ICICLE_BACKEND_INSTALL_DIR", backend_dir);
    }
    command
}

fn run_release(binary: &str, args: &[&str]) -> std::process::Output {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let executable = manifest.join("../../../target/release").join(binary);
    assert!(
        executable.is_file(),
        "missing release binary {}; run cargo build --release first",
        executable.display()
    );
    let mut command = Command::new(executable);
    command.args(args);
    if binary == "verify" {
        command.env("TOKAMAK_VERIFY_TRACE", "1");
    }
    let library_dir = manifest.join("../../../external-lib/mac/lib");
    let backend_dir = library_dir.join("backend");
    if backend_dir.is_dir() {
        command
            .env("ICICLE_BACKEND_INSTALL_DIR", backend_dir)
            .env("DYLD_LIBRARY_PATH", &library_dir);
    }
    let output = command.output().expect("release command must start");
    assert!(
        output.status.success(),
        "{binary} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn path(path: &Path) -> &str {
    path.to_str().expect("temporary path must be UTF-8")
}

fn create_minimal_library(root: &Path) -> PathBuf {
    let snapshot = root.join("subcircuits");
    let library = snapshot.join("library");
    for directory in [
        snapshot.join("circom"),
        library.join("json"),
        library.join("r1cs"),
        library.join("wasm"),
    ] {
        fs::create_dir_all(directory).unwrap();
    }
    fs::write(
        snapshot.join("circom/constants.circom"),
        b"pragma circom 2.1.5;\n",
    )
    .unwrap();
    fs::write(library.join("frontendCfg.json"), b"{}").unwrap();
    fs::write(
        library.join("setupParams.json"),
        br#"{
          "l_free": 0,
          "l_user_out": 0,
          "l_user": 0,
          "l": 1,
          "l_D": 3,
          "m_D": 3,
          "n": 2,
          "s_D": 1,
          "s_max": 2
        }"#,
    )
    .unwrap();
    fs::write(
        library.join("subcircuitInfo.json"),
        br#"[{
          "id": 0,
          "name": "public-buffer",
          "Nwires": 3,
          "Nconsts": 0,
          "Out_idx": [],
          "In_idx": [1, 1],
          "flattenMap": [2, 0, 1],
          "bufferDirection": "in"
        }]"#,
    )
    .unwrap();
    fs::write(library.join("globalWireList.json"), b"[[0,1],[0,2],[0,0]]").unwrap();
    fs::write(library.join("r1cs/subcircuit0.r1cs"), empty_r1cs()).unwrap();
    library
}

fn create_minimal_synthesizer_output(root: &Path) -> PathBuf {
    let output = root.join("synthesizer");
    fs::create_dir_all(&output).unwrap();
    fs::write(output.join("selector.json"), b"[0,4294967295]").unwrap();
    fs::write(output.join("permutation.json"), b"[]").unwrap();
    fs::write(
        output.join("placementVariables.json"),
        br#"[{"subcircuitId":0,"variables":["0x0","0x5","0x0"]}]"#,
    )
    .unwrap();
    fs::write(
        output.join("instance.json"),
        br#"{"a_pub_user":[],"a_pub_block":[],"a_pub_function":["0x5"]}"#,
    )
    .unwrap();
    output
}

fn empty_r1cs() -> Vec<u8> {
    let mut header = Vec::new();
    header.extend_from_slice(&32u32.to_le_bytes());
    header.extend_from_slice(&[0u8; 32]);
    header.extend_from_slice(&3u32.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());
    header.extend_from_slice(&3u64.to_le_bytes());
    header.extend_from_slice(&0u32.to_le_bytes());

    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"r1cs");
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&1u32.to_le_bytes());
    bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&2u32.to_le_bytes());
    bytes.extend_from_slice(&0u64.to_le_bytes());
    bytes
}
