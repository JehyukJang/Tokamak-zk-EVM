use super::*;
use ark_bls12_381::{Fr, G1Affine, G2Affine};
use ark_ec::{AffineRepr, CurveGroup};
use ark_ff::{BigInteger, PrimeField};
use backend_univariate_crs_interface::{UnivariateG1Rkyv, UnivariateG2Rkyv};
use libs::frontend_artifacts::{
    public_wire_layout::GlobalWire, BufferDirection, HexString, SubcircuitInfo,
};

fn g1(value: Fr) -> UnivariateG1Rkyv {
    let p = (G1Affine::generator() * value).into_affine();
    if p.is_zero() {
        return UnivariateG1Rkyv {
            x: [0; 48],
            y: [0; 48],
        };
    }
    UnivariateG1Rkyv {
        x: p.x.into_bigint().to_bytes_le().try_into().unwrap(),
        y: p.y.into_bigint().to_bytes_le().try_into().unwrap(),
    }
}
fn g2(value: Fr) -> UnivariateG2Rkyv {
    let p = (G2Affine::generator() * value).into_affine();
    let mut record = UnivariateG2Rkyv {
        x: [0; 96],
        y: [0; 96],
    };
    if !p.is_zero() {
        record.x[..48].copy_from_slice(&p.x.c0.into_bigint().to_bytes_le());
        record.x[48..].copy_from_slice(&p.x.c1.into_bigint().to_bytes_le());
        record.y[..48].copy_from_slice(&p.y.c0.into_bigint().to_bytes_le());
        record.y[48..].copy_from_slice(&p.y.c1.into_bigint().to_bytes_le());
    }
    record
}
fn bytes_g1(value: Fr) -> [u8; 96] {
    let p = g1(value);
    [p.x.as_slice(), p.y.as_slice()]
        .concat()
        .try_into()
        .unwrap()
}
fn bytes_g2(value: Fr) -> [u8; 192] {
    let p = g2(value);
    [p.x.as_slice(), p.y.as_slice()]
        .concat()
        .try_into()
        .unwrap()
}

fn fixture() -> (SetupParams, PublicWireLayout, PreprocessKeysRkyv, Instance) {
    let setup = SetupParams {
        l_free: 2,
        l: 3,
        l_user_out: 0,
        l_user: 0,
        l_D: 7,
        m_D: 8,
        n: 2,
        m: 4,
        t: 4,
        s_D: 2,
        s_max: 4,
    };
    let infos = [[3, 0, 4], [5, 2, 6]]
        .into_iter()
        .enumerate()
        .map(|(id, map)| SubcircuitInfo {
            id,
            name: format!("buffer-{id}"),
            Nwires: 3,
            Nconsts: 1,
            Out_idx: Box::new([1, 1]),
            In_idx: Box::new([2, 1]),
            flattenMap: Box::new(map),
            bufferDirection: Some(BufferDirection::Out),
        })
        .collect::<Vec<_>>();
    let mut globals = vec![GlobalWire::Padding; setup.m_D];
    for info in &infos {
        for (j, g) in info.flattenMap.iter().enumerate() {
            globals[*g] = GlobalWire::Mapped {
                subcircuit_id: info.id,
                local_wire_index: j,
            };
        }
    }
    let public = PublicWireLayout::derive(&setup, &globals, &infos).unwrap();
    let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
    let tau = Fr::from(7u64);
    let keys = PreprocessKeysRkyv {
        schema_id: libs::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID.into(),
        sc_g1: (0..shape.connection_domain_size)
            .map(|j| g1(tau.pow(j)))
            .collect(),
        selection_g2: (0..=setup.s_max * (setup.t - 1))
            .map(|j| g2(tau.pow(shape.h + j)))
            .collect(),
        fixed_public_queries: vec![g1(Fr::from(17u64))],
    };
    let instance = Instance {
        a_pub_user: Box::new([HexString("03".into()), HexString("00".into())]),
        a_pub_block: Box::new([]),
        a_pub_function: Box::new([HexString("05".into())]),
    };
    (setup, public, keys, instance)
}

fn permutation() -> [Permutation; 2] {
    [
        Permutation {
            row: 0,
            col: 0,
            X: 0,
            Y: 1,
        },
        Permutation {
            row: 0,
            col: 1,
            X: 0,
            Y: 0,
        },
    ]
}

#[test]
fn cpu_matches_direct_group_equations_and_binary_contract() {
    let (setup, public, keys, instance) = fixture();
    let selector = [Some(0), Some(1), None, None];
    let output =
        generate::<Cpu>(&keys, &setup, &public, &selector, &permutation(), &instance).unwrap();
    let tau = Fr::from(7u64);
    let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
    let omega_c = root::<Fr>(shape.connection_domain_size).unwrap();
    // Independent Lagrange evaluation oracle, not the production inverse NTT.
    let n = shape.connection_domain_size;
    let mut sc = Fr::zero();
    for i in 0..n {
        let target = match i {
            0 => 1,
            1 => 0,
            _ => i,
        };
        let x = omega_c.pow(i);
        sc = sc
            + omega_c.pow(target)
                * (tau.pow(n) - Fr::one())
                * x
                * (Fr::from_usize(n) * (tau - x)).inv();
    }
    let omega_s = root::<Fr>(shape.selection_domain_size).unwrap();
    // Direct product over every unselected point, independent of Z_S/Z_v.
    let mut zu = Fr::one();
    for (i, selected) in selector.iter().enumerate() {
        for k in 0..setup.t {
            if k != selected.unwrap_or(setup.t - 1) {
                zu = zu * (tau - omega_s.pow(i + setup.s_max * k));
            }
        }
    }
    assert_eq!(output.s_c, bytes_g1(sc));
    assert_eq!(output.e_kappa, bytes_g2(tau.pow(shape.h) * zu));
    assert_eq!(output.c_fix, bytes_g1(Fr::from(85u64)));
    let binary = output.encode().unwrap();
    assert_eq!(binary.len(), 384);
    assert_eq!(PreprocessBytes::decode(&binary).unwrap(), output);
}

#[test]
fn icicle_cpu_backend_matches_arkworks_fields_polynomials_and_group_bytes() {
    icicle_runtime::load_backend_from_env_or_default().unwrap();
    icicle_runtime::set_device(&icicle_runtime::Device::new("CPU", 0)).unwrap();
    let (setup, public, keys, mut instance) = fixture();
    let selector = [Some(0), Some(1), None, None];
    Icicle::initialize(64).unwrap();
    for selection in [selector, [None; 4], [Some(0); 4]] {
        let cpu = selection_complement::<Cpu>(&setup, &selection, 16).unwrap();
        let icicle = selection_complement::<Icicle>(&setup, &selection, 16).unwrap();
        assert_eq!(
            cpu.iter().map(|v| v.canonical_le()).collect::<Vec<_>>(),
            icicle.iter().map(|v| v.canonical_le()).collect::<Vec<_>>()
        );
        let omega = root::<Fr>(16).unwrap();
        for i in 0..4 {
            for k in 0..4 {
                let z = omega.pow(i + 4 * k);
                let value = cpu.iter().rev().fold(Fr::zero(), |acc, c| acc * z + *c);
                assert_eq!(value == Fr::zero(), k != selection[i].unwrap_or(3));
            }
        }
    }
    for fixed in ["05", "00"] {
        instance.a_pub_function[0] = HexString(fixed.into());
        let expected =
            generate::<Cpu>(&keys, &setup, &public, &selector, &permutation(), &instance).unwrap();
        let actual =
            generate::<Icicle>(&keys, &setup, &public, &selector, &permutation(), &instance)
                .unwrap();
        assert_eq!(actual.encode().unwrap(), expected.encode().unwrap());
    }
    assert_eq!(Icicle::msm_g1(&[], &[]).unwrap(), [0; 96]);
    assert_eq!(Icicle::msm_g2(&[], &[]).unwrap(), [0; 192]);
    assert_eq!(Cpu::msm_g1(&[], &[]).unwrap(), [0; 96]);
    assert_eq!(Cpu::msm_g2(&[], &[]).unwrap(), [0; 192]);
}

#[test]
fn fixed_commitment_does_not_depend_on_free_public_values() {
    let (setup, public, keys, mut instance) = fixture();
    let selector = [Some(0), Some(1), None, None];
    let before = generate::<Cpu>(&keys, &setup, &public, &selector, &[], &instance).unwrap();
    instance.a_pub_user[0] = HexString("0f".into());
    let after = generate::<Cpu>(&keys, &setup, &public, &selector, &[], &instance).unwrap();
    assert_eq!(before, after);
}

#[test]
fn rejects_inconsistent_admission_inputs() {
    let (setup, public, mut keys, mut instance) = fixture();
    let selector = [Some(0), Some(1), None, None];
    for invalid in [
        vec![Some(0)],
        vec![Some(0), Some(2), None, None],
        vec![Some(1), Some(0), None, None],
        vec![Some(0), Some(1), Some(0), None],
    ] {
        assert!(generate::<Cpu>(&keys, &setup, &public, &invalid, &[], &instance).is_err());
    }
    for invalid in [
        vec![Permutation {
            row: 0,
            col: 0,
            X: 0,
            Y: 1,
        }],
        vec![Permutation {
            row: 0,
            col: 0,
            X: 0,
            Y: 2,
        }],
        vec![Permutation {
            row: 4,
            col: 0,
            X: 0,
            Y: 0,
        }],
    ] {
        assert!(generate::<Cpu>(&keys, &setup, &public, &selector, &invalid, &instance).is_err());
    }
    instance.a_pub_user[1] = HexString("01".into());
    assert!(generate::<Cpu>(&keys, &setup, &public, &selector, &[], &instance).is_err());
    instance.a_pub_user[1] = HexString("00".into());
    keys.sc_g1[0].x = [255; 48];
    assert!(generate::<Cpu>(&keys, &setup, &public, &selector, &[], &instance).is_err());
    keys.sc_g1.pop();
    assert!(generate::<Cpu>(&keys, &setup, &public, &selector, &[], &instance).is_err());
}

#[test]
fn archive_round_trip_and_truncation() {
    use backend_univariate_crs_interface::archive;
    let (_, _, keys, _) = fixture();
    let bytes = archive::to_bytes::<archive::rancor::Error>(&keys).unwrap();
    let decoded =
        archive::from_bytes::<PreprocessKeysRkyv, archive::rancor::Error>(&bytes).unwrap();
    assert_eq!(decoded.sc_g1, keys.sc_g1);
    assert_eq!(decoded.selection_g2, keys.selection_g2);
    assert!(
        archive::from_bytes::<PreprocessKeysRkyv, archive::rancor::Error>(
            &bytes[..bytes.len() / 2]
        )
        .is_err()
    );
}
