//! Opt-in current-protocol fixture qualification. Supply existing artifacts;
//! this test never generates a ceremony or reads the circuit library.
use ark_bls12_381::Fr;
use ark_ff::{BigInteger, PrimeField};
use backend_interface::{PreprocessBytes, ProofBytes};
use std::{fs, path::PathBuf};
use verify::{univariate_cli::read_public_inputs, Verifier};

fn input(name: &str) -> PathBuf {
    std::env::var_os(name)
        .unwrap_or_else(|| panic!("set {name}"))
        .into()
}

#[test]
#[ignore = "requires matching current-protocol local fixture paths"]
fn accepts_real_proof_and_rejects_tampering() {
    let preprocess = fs::read(input("VERIFY_TEST_PREPROCESS")).unwrap();
    let proof = fs::read(input("VERIFY_TEST_PROOF")).unwrap();
    let public = read_public_inputs(&input("VERIFY_TEST_INSTANCE")).unwrap();
    let verifier = Verifier::from_bytes(&preprocess).unwrap();
    assert!(verifier.verify(&public, &proof).unwrap());
    let mut wrong_public = public.clone();
    wrong_public[0] += Fr::from(1);
    assert!(!verifier.verify(&wrong_public, &proof).unwrap());
    assert!(verifier
        .verify(&public[..public.len() - 1], &proof)
        .is_err());
    let mut extra_public = public.clone();
    extra_public.push(Fr::from(0));
    assert!(verifier.verify(&extra_public, &proof).is_err());
    assert!(verifier.verify(&public, &proof[..proof.len() - 1]).is_err());
    let mut extra = proof.clone();
    extra.push(0);
    assert!(verifier.verify(&public, &extra).is_err());
    assert!(Verifier::from_bytes(&preprocess[..preprocess.len() - 1]).is_err());
    // Every proof point is authenticated. Replace it by a different valid
    // source-group encoding, rather than merely triggering curve validation.
    for index in 0..10 {
        let mut changed = proof.clone();
        assert!(changed[index * 96..(index + 1) * 96]
            .iter()
            .any(|b| *b != 0));
        changed[index * 96..(index + 1) * 96].fill(0);
        assert!(
            !verifier.verify(&public, &changed).unwrap(),
            "point {index}"
        );
    }
    for index in 0..7 {
        let mut changed = proof.clone();
        let start = 960 + index * 32;
        let value = Fr::from_le_bytes_mod_order(&changed[start..start + 32]) + Fr::from(1);
        changed[start..start + 32].copy_from_slice(&value.into_bigint().to_bytes_le());
        assert!(
            !verifier.verify(&public, &changed).unwrap(),
            "evaluation {index}"
        );
    }
    let mut noncanonical = proof.clone();
    noncanonical[960..992].copy_from_slice(&Fr::MODULUS.to_bytes_le());
    assert!(verifier.verify(&public, &noncanonical).is_err());
    let mut wrong_group = proof.clone();
    wrong_group[..96].fill(0);
    wrong_group[48] = 2;
    assert!(verifier.verify(&public, &wrong_group).is_err());
    let pp = PreprocessBytes::decode(&preprocess).unwrap();
    for index in 0..3 {
        let mut changed = pp.clone();
        match index {
            0 => changed.s_c = [0; 96],
            1 => changed.c_fix = [0; 96],
            _ => changed.e_kappa = [0; 192],
        }
        assert_ne!(
            changed, pp,
            "fixture must exercise preprocess operand {index}"
        );
        let verifier = Verifier::from_bytes(&changed.encode().unwrap()).unwrap();
        assert!(
            !verifier.verify(&public, &proof).unwrap(),
            "preprocess operand {index}"
        );
    }
    assert_eq!(proof.len(), ProofBytes::BYTE_LENGTH);
}
