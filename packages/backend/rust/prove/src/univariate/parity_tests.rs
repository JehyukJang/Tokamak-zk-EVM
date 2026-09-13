use super::*;
use engine::{Cpu, Icicle};
use icicle_bls12_381::curve::ScalarField;
use libs::{univariate_proof::UnivariateProof, univariate_relation::UnivariateSubcircuit};

pub(super) fn expected_bytes(p: &UnivariateProof) -> Vec<u8> {
    use icicle_core::traits::FieldImpl;
    let mut bytes = Vec::new();
    for g in [
        p.c_l, p.c_h, p.c_o, p.d_q, p.d_q_k, p.c_d, p.c_r, p.c_q, p.pi_chi, p.pi_plus,
    ] {
        bytes.extend(g.0.x.to_bytes_le());
        bytes.extend(g.0.y.to_bytes_le());
    }
    for f in [p.s_c, p.u, p.v, p.w, p.b, p.r, p.r_plus] {
        bytes.extend(f.0.canonical_le());
    }
    bytes
}
fn convert<F: ProtocolField>(v: &[ScalarField]) -> Vec<F> {
    v.iter().map(|v| F::from_le(&v.canonical_le())).collect()
}

pub(super) fn compare(
    input: reference::ProvingInput<'_>,
    expected: &UnivariateProof,
    circuits: &[UnivariateSubcircuit<'_>],
) {
    use backend_univariate_crs_interface::archive;
    use libs::subcircuit_library::ValidatedUnivariateCrsBytes;
    let tau = archive::to_bytes::<archive::rancor::Error>(&input.crs.tau)
        .unwrap()
        .to_vec();
    let keys = archive::to_bytes::<archive::rancor::Error>(&input.crs.keys)
        .unwrap()
        .to_vec();
    let decode = |tau, prover_keys| {
        ProverCrs::from_owned_bytes(
            ValidatedUnivariateCrsBytes { tau, prover_keys },
            input.setup,
            circuits,
            input.public_layout,
        )
    };
    assert!(decode(vec![0], keys.clone()).is_err());
    assert!(decode(tau.clone(), vec![0]).is_err());
    let rebuilt = decode(tau.clone(), keys.clone()).unwrap();
    assert_eq!(
        archive::to_bytes::<archive::rancor::Error>(&rebuilt.tau)
            .unwrap()
            .as_slice(),
        tau
    );
    assert_eq!(
        archive::to_bytes::<archive::rancor::Error>(&rebuilt.keys)
            .unwrap()
            .as_slice(),
        keys
    );
    let cpu = check::<Cpu>(&input, expected, circuits);
    let icicle = check::<Icicle>(&input, expected, circuits);
    assert_eq!(cpu, icicle, "CPU and ICICLE common proof bytes");
}
fn check<E: Engine>(
    old: &reference::ProvingInput<'_>,
    expected: &UnivariateProof,
    circuits: &[UnivariateSubcircuit<'_>],
) -> Vec<u8> {
    use libs::frontend_artifacts::{HexString, Instance, PlacementVariables};
    let hex = |v: ScalarField| {
        let mut b = v.canonical_le();
        b.reverse();
        HexString(format!("0x{}", hex::encode(b)))
    };
    let placements: Vec<_> = old
        .slots
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            s.as_ref().map(|v| PlacementVariables {
                subcircuitId: old.selector[i].unwrap(),
                variables: v.iter().copied().map(hex).collect(),
            })
        })
        .collect();
    let instance = Instance {
        a_pub_user: old.public_inputs.iter().copied().map(hex).collect(),
        a_pub_block: Box::new([]),
        a_pub_function: Box::new([]),
    };
    let mut data = prepare::prepare::<E>(
        old.crs,
        old.setup,
        old.selector,
        &[],
        &placements,
        &instance,
        circuits,
    )
    .unwrap();
    for (new, old) in
        data.maps
            .iter()
            .zip([&old.maps.u_a, &old.maps.v_a, &old.maps.w_a, &old.maps.b_c])
    {
        assert_eq!(new.evaluations, convert::<E::F>(&old.evaluations));
        let mut expected = convert::<E::F>(&old.coefficients);
        while expected.len() > 1 && expected.last() == Some(&E::F::zero()) {
            expected.pop();
        }
        assert_eq!(new.coefficients, expected);
    }
    assert_eq!(data.s_c.evaluations, convert::<E::F>(&old.s_c.evaluations));
    let (q, zv) = selection::<E>(old.crs, old.setup, old.selector, &data.slots).unwrap();
    let reference =
        libs::univariate_selection::SelectedRoots::new(&old.crs.shape, old.setup, old.selector)
            .unwrap();
    let witness: Vec<_> = (0..old.setup.m)
        .flat_map(|j| {
            old.slots.iter().map(move |slot| {
                slot.as_ref()
                    .and_then(|w| w.get(j))
                    .copied()
                    .unwrap_or(ScalarField::from_usize(0))
            })
        })
        .collect();
    assert_eq!(
        q,
        convert::<E::F>(&reference.quotients_for_wires(&witness).unwrap())
    );
    use icicle_core::polynomials::UnivariatePolynomial;
    let mut reference_zv = vec![ScalarField::from_usize(0); old.setup.s_max + 1];
    reference.selected_polynomial().copy_coeffs(
        0,
        icicle_runtime::memory::HostSlice::from_mut_slice(&mut reference_zv),
    );
    assert_eq!(zv, convert::<E::F>(&reference_zv));
    let conv = |v: ScalarField| E::F::from_le(&v.canonical_le());
    let m = old.randomizers;
    let masks = ProverRandomizers {
        u: m.u.map(conv),
        v: m.v.map(conv),
        w: m.w.map(conv),
        b: m.b.map(conv),
        r: m.r.map(conv),
        selection: conv(m.selection),
    };
    let run = |data: &Prepared<E::F>| {
        prove::<E>(ProvingInput {
            crs: old.crs,
            setup: old.setup,
            public_layout: old.public_layout,
            selector: old.selector,
            prepared: data,
            randomizers: &masks,
        })
    };
    let (proof, ch) = run(&data).unwrap();
    let bytes = proof.encode().unwrap();
    let replay = libs::univariate_transcript::derive_binary_proof_challenges(
        &data.public_inputs[..old.setup.l_free],
        &proof,
        old.crs.shape.arithmetic_domain_size,
        old.crs.shape.connection_domain_size,
    );
    assert_eq!(
        [ch.upsilon, ch.beta, ch.gamma_c, ch.theta, ch.chi, ch.varpi, ch.mu],
        [
            replay.upsilon,
            replay.beta,
            replay.gamma_c,
            replay.theta,
            replay.chi,
            replay.varpi,
            replay.mu
        ]
    );
    assert_eq!(bytes, expected_bytes(expected));
    let legacy = libs::univariate_transcript::derive_proof_challenges(
        &old.public_inputs[..old.setup.l_free],
        expected,
        old.crs.shape.arithmetic_domain_size,
        old.crs.shape.connection_domain_size,
    );
    assert_eq!(
        [ch.upsilon, ch.beta, ch.gamma_c, ch.theta, ch.chi, ch.varpi, ch.mu]
            .map(ProtocolField::canonical_le),
        [
            legacy.upsilon,
            legacy.beta,
            legacy.gamma_c,
            legacy.theta,
            legacy.chi,
            legacy.varpi,
            legacy.mu
        ]
        .map(ProtocolField::canonical_le)
    );
    if data.public_inputs.len() > 2 {
        data.public_inputs[1] = E::F::one();
        assert!(run(&data).is_err());
        data.public_inputs[1] = E::F::zero();
        data.public_inputs[2] = E::F::from_usize(10);
        assert!(run(&data).is_err());
        data.public_inputs[2] = conv(old.public_inputs[2]);
        let mut repeated = old.selector.to_vec();
        repeated[2] = Some(0);
        assert!(prepare::validate_public(
            old.setup,
            old.public_layout,
            &repeated,
            &data.slots,
            &data.public_inputs
        )
        .is_err());
    }
    data.maps[2].coefficients[0] = data.maps[2].coefficients[0] + E::F::one();
    assert!(matches!(
        run(&data),
        Err(UnivariateProverError::Unsatisfied {
            relation: "arithmetic"
        })
    ));
    bytes
}
#[test]
fn arkworks_roots_match_the_existing_icicle_domain_order() {
    for log in 0..=32 {
        let n = 1usize << log;
        let old = icicle_core::ntt::get_root_of_unity::<ScalarField>(n as u64);
        assert_eq!(
            prepare::root::<ark_bls12_381::Fr>(n)
                .unwrap()
                .canonical_le(),
            old.canonical_le(),
            "domain {n}"
        );
    }
}
#[test]
fn exact_division_and_copy_rejection_on_both_engines() {
    fn check<E: Engine>() {
        E::initialize(64).unwrap();
        let z = E::F::zero();
        let one = E::F::one();
        let root = prepare::root::<E::F>(2).unwrap();
        assert!(E::divide_vanishing(&E::polynomial(&[one]), 2, "test").is_err());
        let q = E::divide_vanishing(&E::polynomial(&[z - one, z, one]), 2, "test").unwrap();
        assert_eq!(E::coefficients(&q), vec![one]);
        let values = [z, one];
        let b = E::interpolate(&values, root);
        let sc = DomainPolynomial {
            evaluations: vec![one, root],
            coefficients: vec![z, one],
        };
        assert!(matches!(
            copy_relation::<E>(root, 2, &values, &sc, &b, z, z, &[one; 4]),
            Err(UnivariateProverError::CopyDenominator { index: 0 })
        ));
        let sc = DomainPolynomial {
            evaluations: vec![root, one],
            coefficients: vec![z, root],
        };
        assert!(matches!(
            copy_relation::<E>(
                root,
                2,
                &values,
                &sc,
                &b,
                one,
                E::F::from_usize(3),
                &[one; 4]
            ),
            Err(UnivariateProverError::CopyRecurrenceDoesNotClose)
        ));
    }
    check::<Cpu>();
    check::<Icicle>();
}
