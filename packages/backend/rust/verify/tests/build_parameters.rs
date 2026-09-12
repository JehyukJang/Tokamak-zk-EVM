#[path = "../build_parameters.rs"]
mod build_parameters;

fn setup() -> serde_json::Value {
    serde_json::json!({"n": 1024, "s_max": 256, "l": 396, "l_D": 1420, "l_free": 256})
}

#[test]
fn derives_only_the_three_runtime_constants() {
    let source = build_parameters::generate(&serde_json::to_vec(&setup()).unwrap()).unwrap();
    assert!(source.contains("N_A: u64 = 262144;"));
    assert!(source.contains("N_C: u64 = 262144;"));
    assert!(source.contains("L_FREE: u64 = 256;"));
    assert_eq!(source.matches("pub const").count(), 3);
    let mut changed = setup();
    changed["s_max"] = 512.into();
    let updated = build_parameters::generate(&serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(updated.contains("N_A: u64 = 524288;"));
    assert!(updated.contains("N_C: u64 = 524288;"));
}

#[test]
fn rejects_invalid_metadata_without_defaults() {
    for (name, value) in [
        ("n", serde_json::Value::Null),
        ("n", serde_json::json!("1024")),
        ("n", serde_json::json!(-1)),
        ("n", serde_json::json!(1.5)),
        ("n", serde_json::json!(u64::MAX)),
        ("n", serde_json::json!(1u64 << 32)),
        ("s_max", serde_json::json!(0)),
        ("l_D", serde_json::json!(395)),
        ("l_D", serde_json::json!(1421)),
        ("l_free", serde_json::json!(0)),
        ("l_free", serde_json::json!(255)),
        ("l_free", serde_json::json!(512)),
    ] {
        let mut invalid = setup();
        invalid[name] = value;
        assert!(
            build_parameters::generate(&serde_json::to_vec(&invalid).unwrap()).is_err(),
            "{invalid}"
        );
    }
    assert!(build_parameters::generate(b"not JSON").is_err());
}

#[test]
fn verifier_contains_build_time_constants() {
    mod parameters {
        include!(concat!(env!("OUT_DIR"), "/verifier_parameters.rs"));
    }
    assert!(parameters::N_A.is_power_of_two());
    assert!(parameters::N_C.is_power_of_two());
    assert!(parameters::L_FREE.is_power_of_two());
}
