//! Test-only algebra checks for the current-protocol MPC design gate.
//! These are not a contribution protocol, a knowledge proof, or a security proof.
//! All scalars are deliberately public oracle inputs. No production code may
//! obtain the correction terms below by recovering a participant's secret.

use ark_bls12_381::{Fr, G1Affine, G1Projective};
use ark_ec::{AffineRepr, PrimeGroup};
use ark_ff::{BigInteger, Field, PrimeField};

fn point(value: Fr) -> G1Projective {
    G1Projective::generator() * value
}

#[test]
fn filecoin_generator_probe_matches_bls12_381_coordinates() {
    // Bytes 64..159 of challenge_19, fetched in a bounded probe on 2026-09-12.
    // This checks a coordinate encoding, not source authenticity or all points.
    let generator = G1Affine::generator();
    let hex = |bytes: Vec<u8>| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    assert_eq!(hex(generator.x.into_bigint().to_bytes_be()),
        "17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb");
    assert_eq!(hex(generator.y.into_bigint().to_bytes_be()),
        "08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1");
}

#[test]
fn filecoin_pinned_parameter_ranges_cover_current_capacity() {
    // Upstream 2bd49903, small_bls12_381::Bls12CeremonyParameters:
    // REQUIRED_POWER = 27; uncompressed accumulator from parameters.rs.
    let length = 1u64 << 27;
    let p = 524_291u64;
    assert!(2 * p <= 2 * length - 2);
    assert!(p < length);
    assert_eq!(
        64 + (2 * length - 1) * 96 + length * 192 + 2 * length * 96 + 192,
        77_309_411_488
    );
}

#[test]
fn delta_only_reference_update_preserves_a_fixed_numerator() {
    let numerator = Fr::from(53u64);
    let mut delta = Fr::from(7u64);
    let mut query = point(numerator / delta);
    for share in [Fr::from(11u64), Fr::from(13u64)] {
        query *= share.inverse().unwrap();
        delta *= share;
        assert_eq!(query, point(numerator / delta));
    }
}

#[test]
fn packed_weight_updates_need_a_correction_not_uniform_scaling() {
    // A is the tagged arithmetic/interface contribution; B is tau^S L_i,k.
    // A free-public M term is included in A for the second case.
    for public_term in [Fr::from(0u64), Fr::from(17u64)] {
        let a = Fr::from(19u64) + public_term;
        let b = Fr::from(23u64);
        let mut delta = Fr::from(7u64);
        let mut weight = Fr::from(5u64);
        let mut packed = point((a + weight * b) / delta);
        let mut fixed = point(a + weight * b);
        let mut helper = point(weight * Fr::from(29u64));
        let mut mask = point(Fr::from(31u64) / delta);

        for (delta_share, weight_share) in [(11u64, 13u64), (37, 41)] {
            let u = Fr::from(delta_share);
            let v = Fr::from(weight_share);
            let new_delta = delta * u;
            let new_weight = weight * v;
            let expected = point((a + new_weight * b) / new_delta);

            // Neither the Groth16 delta-only update nor scaling the entire
            // packed query by v/u updates its two summands correctly.
            assert_ne!(packed * u.inverse().unwrap(), expected);
            assert_ne!(packed * (v / u), expected);

            // This identity needs a separately available role-scaled selection
            // summand. Constructing it from known scalars is an oracle only.
            let selection = point(weight * b / delta);
            assert_eq!(packed - selection, point(a / delta));
            packed = (packed + selection * (v - Fr::from(1u64))) * u.inverse().unwrap();
            assert_eq!(packed, expected);

            fixed += point(weight * b) * (v - Fr::from(1u64));
            helper *= v;
            mask *= u.inverse().unwrap();
            delta = new_delta;
            weight = new_weight;
            assert_eq!(fixed, point(a + weight * b));
            assert_eq!(helper, point(weight * Fr::from(29u64)));
            assert_eq!(mask, point(Fr::from(31u64) / delta));
        }
    }
}
