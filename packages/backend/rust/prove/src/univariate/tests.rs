//! Prover-only algebraic oracle. No native preprocess or verifier dependency.
use super::*;
use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg};
use icicle_core::curve::Curve;
use libs::{
    frontend_artifacts::{public_wire_layout::GlobalWire, BufferDirection, SubcircuitInfo},
    univariate_relation::{connection_permutation_polynomial, witness_maps, SlotWitness},
    univariate_setup::{generate, SetupScalars},
    univariate_transcript::derive_proof_challenges,
};

fn f(value: u32) -> ScalarField {
    ScalarField::from_u32(value)
}

#[test]
#[ignore = "release-only independent performance comparison"]
fn compare_copy_denominator_inversion() {
    use icicle_core::vec_ops::{inv_scalars, VecOpsConfig};
    use std::time::Instant;
    assert!(!cfg!(debug_assertions), "use --release");
    libs::utils::try_check_device().unwrap();
    for count in [1, 17, 64, 256, 1_024, 4_096, 262_144] {
        let mut values = ScalarCfg::generate_random(count);
        for value in &mut values {
            if *value == f(0) {
                *value = f(1);
            }
        }
        values[0] = f(1);
        if count > 1 {
            values[1] = f(0) - f(1);
        }
        for trial in 0..3 {
            let reference = || {
                let start = Instant::now();
                let result = values.iter().map(|v| v.inv()).collect::<Vec<_>>();
                (result, start.elapsed().as_secs_f64())
            };
            let candidate = || {
                let start = Instant::now();
                let mut result = vec![f(0); count];
                inv_scalars(
                    HostSlice::from_slice(&values),
                    HostSlice::from_mut_slice(&mut result),
                    &VecOpsConfig::default(),
                )
                .unwrap();
                (result, start.elapsed().as_secs_f64())
            };
            let (old, new) = if trial % 2 == 0 {
                (reference(), candidate())
            } else {
                let new = candidate();
                (reference(), new)
            };
            assert_eq!(old.0, new.0);
            println!(
                "{}",
                serde_json::json!({"count":count,"trial":trial,"referenceSeconds":old.1,"candidateSeconds":new.1,"allInversesEqual":true})
            );
        }
    }
}

#[test]
fn bulk_copy_recursion_matches_a_telescoping_cycle() {
    for n in [512, 1_024, 4_096] {
        init_ntt_domain_for_size((2 * (n + 4usize)).next_power_of_two()).unwrap();
        let root = icicle_core::ntt::get_root_of_unity::<ScalarField>(n as u64);
        let mut values = vec![f(7); n];
        let sc = DenseDomainPolynomial {
            evaluations: (0..n).map(|i| root.pow((i + 1) % n)).collect(),
            coefficients: Box::new([f(0), root]),
        };
        let b = polynomial(&[f(7)]);
        let masks = [f(1), f(2), f(3), f(4)];
        let (r, _, _) = copy_relation(root, n, &values, &sc, &b, f(5), f(3), &masks).unwrap();
        // f_i = g_(i+1), hence r_i = g_i/g_0 = (10 + 5*z_i)/15.
        let expected = blind(&[f(10) * f(15).inv(), f(5) * f(15).inv()], &masks, n);
        assert_eq!(coefficients(&r), coefficients(&expected));
        values[n - 1] = f(0) - f(5) * root.pow(n - 1) - f(3);
        assert!(matches!(
            copy_relation(root, n, &values, &sc, &b, f(5), f(3), &masks),
            Err(UnivariateProverError::CopyDenominator { index }) if index == n - 1
        ));
    }
}

#[test]
#[ignore = "release-only comparison requiring PROVE_BENCH_TAU"]
fn compare_reused_msm_precomputation() {
    use backend_univariate_crs_interface::{archive, TauSequenceRkyv};
    use icicle_bls12_381::curve::{G1Affine, G1Projective};
    use icicle_core::msm::{msm, precompute_bases, MSMConfig};
    use icicle_runtime::memory::DeviceVec;
    use std::time::Instant;
    assert!(!cfg!(debug_assertions), "use --release");
    libs::utils::try_check_device().unwrap();
    let path = std::env::var("PROVE_BENCH_TAU")
        .expect("set PROVE_BENCH_TAU to the measured tau_sequence.rkyv");
    let tau = archive::from_bytes::<TauSequenceRkyv, archive::rancor::Error>(
        &std::fs::read(path).unwrap(),
    )
    .unwrap();
    // Three same-prefix uses model the xi source in CL, CH and Pi_chi;
    // shifted commitments are not credited as reuse in this experiment.
    for count in [1_024, 262_146] {
        let bases = tau.sxi_g1[..count].iter().map(point).collect::<Vec<_>>();
        let mut scalars = ScalarCfg::generate_random(count * 3);
        scalars[0] = f(0);
        scalars[1] = f(1);
        scalars[2] = f(0) - f(1);
        let expected = scalars
            .chunks(count)
            .map(|s| msm_points(&bases, s).unwrap().0)
            .collect::<Vec<_>>();
        for trial in 0..3 {
            for offset in 0..3 {
                let factor = [1, 2, 4][(trial + offset) % 3];
                let start = Instant::now();
                let mut config = MSMConfig::default();
                config.precompute_factor = factor;
                let mut precomputed = if factor == 1 {
                    None
                } else {
                    let mut table =
                        DeviceVec::<G1Affine>::device_malloc(count * factor as usize).unwrap();
                    precompute_bases(HostSlice::from_slice(&bases), &config, &mut table).unwrap();
                    Some(table)
                };
                let precompute_seconds = start.elapsed().as_secs_f64();
                let results = scalars
                    .chunks(count)
                    .map(|s| {
                        let mut result = [G1Projective::zero()];
                        if let Some(table) = precomputed.as_mut() {
                            msm(
                                HostSlice::from_slice(s),
                                table,
                                &config,
                                HostSlice::from_mut_slice(&mut result),
                            )
                            .unwrap();
                        } else {
                            msm(
                                HostSlice::from_slice(s),
                                HostSlice::from_slice(&bases),
                                &config,
                                HostSlice::from_mut_slice(&mut result),
                            )
                            .unwrap();
                        }
                        G1Affine::from(result[0])
                    })
                    .collect::<Vec<_>>();
                let seconds = start.elapsed().as_secs_f64();
                assert_eq!(results, expected);
                println!(
                    "{}",
                    serde_json::json!({"count":count,"reuse":3,"trial":trial,"factor":factor,"precomputeSeconds":precompute_seconds,"totalSeconds":seconds,"allPointsEqual":true})
                );
            }
        }
    }
}

#[test]
fn selection_helper_matches_all_roots_at_full_placement_capacity() {
    let setup = SetupParams {
        l_free: 2,
        l: 2,
        l_user_out: 0,
        l_user: 0,
        l_D: 6,
        m_D: 12,
        n: 4,
        m: 4,
        t: 4,
        s_D: 3,
        s_max: 256,
    };
    let shape = libs::univariate_crs::UnivariateCrsShape::from_setup_params(&setup).unwrap();
    let selector = (0..setup.s_max)
        .map(|i| if i % 4 == 3 { None } else { Some(i % 3) })
        .collect::<Vec<_>>();
    let roots = SelectedRoots::new(&shape, &setup, &selector).unwrap();
    let values = selector
        .iter()
        .enumerate()
        .map(|(i, id)| {
            if id.is_some() {
                f((i + 1) as u32)
            } else {
                f(0)
            }
        })
        .collect::<Vec<_>>();
    let quotient = roots.quotient_for_wire(&values).unwrap();
    let zu = roots.unselected_values().unwrap();
    for ((root, value), unselected) in roots.roots.iter().zip(values).zip(zu) {
        assert_eq!(quotient.eval(root) * unselected, value);
    }
}

#[test]
fn current_prover_matches_scalar_oracle_with_fixed_free_padding_and_selection_holes() {
    for n in [2, 8] {
        let setup = SetupParams {
            l_free: 2,
            l: 3,
            l_user_out: 0,
            l_user: 0,
            l_D: 7,
            m_D: 12,
            n,
            m: 4,
            t: 4,
            s_D: 3,
            s_max: 4,
        };
        let infos = [[3, 0, 4], [5, 2, 6], [7, 8, 9]]
            .into_iter()
            .enumerate()
            .map(|(id, map)| SubcircuitInfo {
                id,
                name: format!("circuit-{id}"),
                Nwires: 3,
                Nconsts: 1,
                Out_idx: Box::new([1, 1]),
                In_idx: Box::new([2, 1]),
                flattenMap: Box::new(map),
                bufferDirection: (id < 2).then_some(BufferDirection::Out),
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
        let active = [0, 1, 2];
        let a_rows = [vec![(1, f(1))]];
        let b_rows = [vec![(0, f(1))]];
        let c_rows = [vec![(2, f(1))]];
        let circuits = infos
            .iter()
            .map(|info| UnivariateSubcircuit {
                id: info.id,
                flatten_map: &info.flattenMap,
                a_active_wires: &active,
                b_active_wires: &active,
                c_active_wires: &active,
                a_rows: &a_rows,
                b_rows: &b_rows,
                c_rows: &c_rows,
            })
            .collect::<Vec<_>>();
        let secret = SetupScalars {
            tau: f(7),
            xi: f(11),
            psi: f(13),
            delta: f(17),
            weights: (19..23).map(f).collect(),
        };
        let g1 = CurveCfg::generate_random_affine_points(1)[0];
        let g2 = G2CurveCfg::generate_random_affine_points(1)[0];
        let generated = generate(&setup, &public, &circuits, &secret, g1, g2).unwrap();
        let fixed = generated.preprocess.fixed_public_queries.clone();
        // Exercise the actual current RKYV ingress, not the superseded reader.
        let directory =
            std::env::temp_dir().join(format!("tokamak-prover-oracle-{}-{n}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        use backend_univariate_crs_interface::archive;
        std::fs::write(
            directory.join("tau_sequence.rkyv"),
            archive::to_bytes::<archive::rancor::Error>(&generated.tau).unwrap(),
        )
        .unwrap();
        std::fs::write(
            directory.join("prover_keys.rkyv"),
            archive::to_bytes::<archive::rancor::Error>(&generated.prover).unwrap(),
        )
        .unwrap();
        let crs = ProverCrs::read(
            &directory.join("tau_sequence.rkyv"),
            &directory,
            &setup,
            &circuits,
            &public,
        )
        .unwrap();
        std::fs::remove_file(directory.join("tau_sequence.rkyv")).unwrap();
        std::fs::remove_file(directory.join("prover_keys.rkyv")).unwrap();
        std::fs::remove_dir(&directory).unwrap();
        let shape = &crs.shape;
        let selector = [Some(0), Some(1), None, Some(2)]; // Internal circuit: i != k.
        let slots = vec![
            Some(vec![f(1), f(5), f(5)].into_boxed_slice()),
            Some(vec![f(1), f(9), f(9)].into_boxed_slice()),
            None,
            Some(vec![f(1), f(6), f(6)].into_boxed_slice()),
        ];
        let witness = slots
            .iter()
            .enumerate()
            .map(|(i, v)| {
                v.as_ref().map(|values| SlotWitness {
                    subcircuit_id: selector[i].unwrap(),
                    values,
                })
            })
            .collect::<Vec<_>>();
        let maps = witness_maps(shape, &setup, &selector, &witness, &circuits).unwrap();
        let sc = connection_permutation_polynomial(shape, &setup, &selector, &[]).unwrap();
        let masks = ProverRandomizers {
            u: [f(2), f(3)],
            v: [f(4), f(5)],
            w: [f(6), f(7)],
            b: [f(8), f(9)],
            r: [f(10), f(11), f(12), f(13)],
            selection: f(14),
        };
        let instance = [f(5), f(0), f(9)];
        let run = |maps: &WitnessMaps, values: &[ScalarField]| {
            prove(ProvingInput {
                crs: &crs,
                setup: &setup,
                public_layout: &public,
                selector: &selector,
                slots: &slots,
                maps,
                s_c: &sc,
                public_inputs: values,
                randomizers: &masks,
            })
        };
        let (proof, ch) = run(&maps, &instance).unwrap();
        // Opt-in cross-language vectors are emitted only by this test oracle.
        // Never expose deterministic proof masks on the production CLI.
        if let Some(output) = std::env::var_os("WASM_PARITY_OUTPUT") {
            let path = std::path::PathBuf::from(output).join(format!("n{n}"));
            std::fs::create_dir(&path).unwrap();
            for (name, bytes) in [
                (
                    "tau_sequence.rkyv",
                    archive::to_bytes::<archive::rancor::Error>(&generated.tau).unwrap(),
                ),
                (
                    "prover_keys.rkyv",
                    archive::to_bytes::<archive::rancor::Error>(&generated.prover).unwrap(),
                ),
                (
                    "preprocess_keys.rkyv",
                    archive::to_bytes::<archive::rancor::Error>(&generated.preprocess).unwrap(),
                ),
                (
                    "verifier_keys.rkyv",
                    archive::to_bytes::<archive::rancor::Error>(&generated.verifier).unwrap(),
                ),
            ] {
                std::fs::write(path.join(name), bytes).unwrap();
            }
            let scalar = |v: ScalarField| {
                let mut bytes = v.to_bytes_le();
                bytes.reverse();
                format!("0x{}", hex::encode(bytes))
            };
            let data = serde_json::json!({
                "setup": { "l_free": setup.l_free, "l": setup.l, "l_user_out": setup.l_user_out,
                    "l_user": setup.l_user, "l_D": setup.l_D, "m_D": setup.m_D, "n": setup.n,
                    "m": setup.m, "t": setup.t, "s_D": setup.s_D, "s_max": setup.s_max },
                "infos": infos.iter().map(|info| serde_json::json!({
                    "id": info.id, "name": info.name, "Nwires": info.Nwires, "Nconsts": info.Nconsts,
                    "Out_idx": info.Out_idx, "In_idx": info.In_idx, "flattenMap": info.flattenMap,
                    "bufferDirection": if info.id < 2 { Some("out") } else { None }
                })).collect::<Vec<_>>(),
                "selector": selector,
                "witness": slots.iter().map(|slot| slot.as_ref().map(|v| v.iter().copied().map(scalar).collect::<Vec<_>>())).collect::<Vec<_>>(),
                "publicInputs": instance.map(scalar),
                "masks": (2..15).map(|i| scalar(f(i))).collect::<Vec<_>>(),
                "rows": { "A": [[ [1, "0x1"] ]], "B": [[ [0, "0x1"] ]], "C": [[ [2, "0x1"] ]] }
            });
            std::fs::write(
                path.join("fixture.json"),
                serde_json::to_vec_pretty(&data).unwrap(),
            )
            .unwrap();
            std::fs::write(
                path.join("univariate_proof.bin"),
                super::super::parity_tests::expected_bytes(&proof),
            )
            .unwrap();
        }
        super::super::parity_tests::compare(
            ProvingInput {
                crs: &crs,
                setup: &setup,
                public_layout: &public,
                selector: &selector,
                slots: &slots,
                maps: &maps,
                s_c: &sc,
                public_inputs: &instance,
                randomizers: &masks,
            },
            &proof,
            &circuits,
        );
        assert_eq!(
            ch,
            derive_proof_challenges(
                &instance[..2],
                &proof,
                shape.arithmetic_domain_size,
                shape.connection_domain_size
            )
        );
        let json = serde_json::to_value(&proof).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 17);
        assert_eq!(proof.g1_element_count(), 10);
        assert_eq!(proof.scalar_element_count(), 7);
        assert_eq!(
            serde_json::from_value::<UnivariateProof>(json.clone()).unwrap(),
            proof
        );
        let mut obsolete = json;
        obsolete["qZeta"] = serde_json::to_value(FieldSerde(f(1))).unwrap();
        assert!(serde_json::from_value::<UnivariateProof>(obsolete).is_err());

        let u = blind(
            &maps.u_a.coefficients,
            &masks.u,
            shape.arithmetic_domain_size,
        );
        let v = blind(
            &maps.v_a.coefficients,
            &masks.v,
            shape.arithmetic_domain_size,
        );
        let w = blind(
            &maps.w_a.coefficients,
            &masks.w,
            shape.arithmetic_domain_size,
        );
        let b = blind(
            &maps.b_c.coefficients,
            &masks.b,
            shape.connection_domain_size,
        );
        let ap = DensePolynomial::from_rou_evals(HostSlice::from_slice(&instance[..2]), 2);
        let tau = secret.tau;
        let l = ap.eval(&tau) + secret.xi * u.eval(&tau) + secret.psi * w.eval(&tau);
        let h = secret.xi * v.eval(&tau) + secret.psi * b.eval(&tau);
        assert_eq!(proof.c_l, G1serde(g1) * l);
        assert_eq!(proof.c_h, G1serde(g1) * h);
        assert_eq!(
            proof.c_d,
            G1serde(g1) * (tau.pow(shape.k) * (l + ch.upsilon * h))
        );
        // Independent dense selection-domain evaluation, used only in this
        // small oracle. Production proving never allocates this table.
        let mut c0 = f(0);
        let ns = shape.selection_domain_size;
        for (i, slot) in slots.iter().enumerate() {
            if let Some(values) = slot {
                let root = shape
                    .selection_root
                    .pow(i + setup.s_max * selector[i].unwrap());
                let lag = (tau.pow(ns) - f(1))
                    * root
                    * (tau - root).inv()
                    * ScalarField::from_bytes_le(&ns.to_le_bytes()).inv();
                for (j, value) in values.iter().enumerate() {
                    c0 = c0 + *value * secret.weights[j] * lag;
                }
            }
        }
        let roots = SelectedRoots::new(shape, &setup, &selector).unwrap();
        let zv = roots.selected_polynomial().eval(&tau);
        let zu = (tau.pow(ns) - f(1)) * zv.inv();
        let qs = c0 * zu.inv() + masks.selection * zv;
        assert_eq!(proof.d_q, G1serde(g1) * qs);
        assert_eq!(proof.d_q_k, G1serde(g1) * (qs * tau.pow(shape.k)));
        let cfix = commit(&fixed, &[instance[2]], 0).unwrap();
        assert_eq!(
            proof.c_o * secret.delta,
            proof.c_l
                + proof.c_h * tau.pow(shape.k)
                + proof.d_q * (tau.pow(shape.k + shape.h) * zu)
                - cfix
        );

        let (r, q0, q1) = copy_relation(
            shape.connection_root,
            shape.connection_domain_size,
            &maps.b_c.evaluations,
            &sc,
            &b,
            ch.beta,
            ch.gamma_c,
            &masks.r,
        )
        .unwrap();
        let qa =
            divide_vanishing(&u.mul(&v).sub(&w), shape.arithmetic_domain_size, "test").unwrap();
        let q = qa
            .add(&q0.mul_by_scalar(&ch.theta))
            .add(&q1.mul_by_scalar(&ch.theta.pow(2)));
        assert_eq!(proof.c_r, G1serde(g1) * r.eval(&tau));
        assert_eq!(proof.c_q, G1serde(g1) * q.eval(&tau));
        let x = ch.chi;
        let na = shape.arithmetic_domain_size;
        let nc = shape.connection_domain_size;
        let ni = shape.intersection_domain_size;
        let ma = (x.pow(nc) - f(1)) * (x.pow(ni) - f(1)).inv();
        let mc = (x.pow(na) - f(1)) * (x.pow(ni) - f(1)).inv();
        let l0 =
            (x.pow(nc) - f(1)) * (ScalarField::from_bytes_le(&nc.to_le_bytes()) * (x - f(1))).inv();
        let qx = (ma * (proof.u.0 * proof.v.0 - proof.w.0)
            + ch.theta * mc * (proof.r.0 - f(1)) * l0
            + ch.theta.pow(2)
                * mc
                * (proof.r_plus.0 * (proof.b.0 + ch.beta * x + ch.gamma_c)
                    - proof.r.0 * (proof.b.0 + ch.beta * proof.s_c.0 + ch.gamma_c)))
            * (x.pow(shape.union_domain_size) - f(1)).inv();
        assert_eq!(qx, q.eval(&x));
        let rho = ch.varpi;
        let value = ap.eval(&x)
            + secret.xi * (proof.u.0 + rho * proof.v.0)
            + secret.psi * (proof.w.0 + rho * proof.b.0)
            + rho.pow(2) * proof.r.0
            + rho.pow(3) * qx
            + rho.pow(4) * proof.s_c.0;
        let at_tau = l
            + rho * h
            + rho.pow(2) * r.eval(&tau)
            + rho.pow(3) * q.eval(&tau)
            + rho.pow(4) * polynomial(&sc.coefficients).eval(&tau);
        assert_eq!(
            proof.pi_chi,
            G1serde(g1) * ((at_tau - value) * (tau - x).inv())
        );
        assert_eq!(
            proof.pi_plus,
            G1serde(g1)
                * ((r.eval(&tau) - proof.r_plus.0) * (tau - shape.connection_root * x).inv())
        );

        let mut wrong_padding = instance;
        let mut repeated_public = selector;
        repeated_public[2] = Some(0);
        assert!(
            validate_public_witness(&setup, &public, &repeated_public, &slots, &instance).is_err()
        );
        wrong_padding[1] = f(1);
        assert!(run(&maps, &wrong_padding).is_err());
        let mut wrong_fixed = instance;
        wrong_fixed[2] = f(10);
        assert!(run(&maps, &wrong_fixed).is_err());
        let mut invalid_maps = maps.clone();
        invalid_maps.w_a.coefficients[0] = invalid_maps.w_a.coefficients[0] + f(1);
        assert!(matches!(
            run(&invalid_maps, &instance),
            Err(UnivariateProverError::Unsatisfied {
                relation: "arithmetic"
            })
        ));
    }
}

#[test]
fn copy_denominator_and_nonclosing_recursion_abort_without_retry() {
    init_ntt_domain_for_size(32).unwrap();
    let n = 2;
    let root = icicle_core::ntt::get_root_of_unity::<ScalarField>(n as u64);
    let values = [f(0), f(1)];
    let sc = DenseDomainPolynomial {
        evaluations: Box::new([f(1), root]),
        coefficients: Box::new([f(0), f(1)]),
    };
    let b = DensePolynomial::from_rou_evals(HostSlice::from_slice(&values), n);
    assert!(matches!(
        copy_relation(root, n, &values, &sc, &b, f(0), f(0), &[f(1); 4]),
        Err(UnivariateProverError::CopyDenominator { index: 0 })
    ));
    assert!(matches!(
        copy_relation(root, n, &values, &sc, &b, f(0), f(0) - f(1), &[f(1); 4]),
        Err(UnivariateProverError::CopyDenominator { index: 1 })
    ));
    let swapped = DenseDomainPolynomial {
        evaluations: Box::new([root, f(1)]),
        coefficients: Box::new([f(0), f(0) - f(1)]),
    };
    assert!(matches!(
        copy_relation(root, n, &values, &swapped, &b, f(2), f(3), &[f(1); 4]),
        Err(UnivariateProverError::CopyRecurrenceDoesNotClose)
    ));
}

#[test]
fn singleton_domains_and_all_empty_selection_produce_a_current_proof() {
    let setup = SetupParams {
        l_free: 1,
        l: 1,
        l_user_out: 0,
        l_user: 0,
        l_D: 2,
        m_D: 4,
        n: 1,
        m: 4,
        t: 2,
        s_D: 1,
        s_max: 1,
    };
    let info = SubcircuitInfo {
        id: 0,
        name: "empty-public-port".into(),
        Nwires: 3,
        Nconsts: 1,
        Out_idx: Box::new([1, 0]),
        In_idx: Box::new([2, 1]),
        flattenMap: Box::new([1, 2, 3]),
        bufferDirection: Some(BufferDirection::Out),
    };
    let globals = [
        GlobalWire::Padding,
        GlobalWire::Mapped {
            subcircuit_id: 0,
            local_wire_index: 0,
        },
        GlobalWire::Mapped {
            subcircuit_id: 0,
            local_wire_index: 1,
        },
        GlobalWire::Mapped {
            subcircuit_id: 0,
            local_wire_index: 2,
        },
    ];
    let public = PublicWireLayout::derive(&setup, &globals, std::slice::from_ref(&info)).unwrap();
    let active = [0];
    let rows = [vec![(0, f(1))]];
    let circuits = [UnivariateSubcircuit {
        id: 0,
        flatten_map: &info.flattenMap,
        a_active_wires: &active,
        b_active_wires: &active,
        c_active_wires: &active,
        a_rows: &rows,
        b_rows: &rows,
        c_rows: &rows,
    }];
    let g1 = CurveCfg::generate_random_affine_points(1)[0];
    let g2 = G2CurveCfg::generate_random_affine_points(1)[0];
    let secret = SetupScalars {
        tau: f(7),
        xi: f(11),
        psi: f(13),
        delta: f(17),
        weights: vec![f(19); 4],
    };
    let generated = generate(&setup, &public, &circuits, &secret, g1, g2).unwrap();
    let parity_path = std::env::var_os("WASM_PARITY_OUTPUT")
        .map(|root| std::path::PathBuf::from(root).join("singleton"));
    if let Some(path) = &parity_path {
        use backend_univariate_crs_interface::archive;
        std::fs::create_dir(path).unwrap();
        for (name, bytes) in [
            (
                "tau_sequence.rkyv",
                archive::to_bytes::<archive::rancor::Error>(&generated.tau).unwrap(),
            ),
            (
                "prover_keys.rkyv",
                archive::to_bytes::<archive::rancor::Error>(&generated.prover).unwrap(),
            ),
            (
                "preprocess_keys.rkyv",
                archive::to_bytes::<archive::rancor::Error>(&generated.preprocess).unwrap(),
            ),
            (
                "verifier_keys.rkyv",
                archive::to_bytes::<archive::rancor::Error>(&generated.verifier).unwrap(),
            ),
        ] {
            std::fs::write(path.join(name), bytes).unwrap();
        }
    }
    let crs = ProverCrs::new(generated.tau, generated.prover, &setup, &circuits, &public).unwrap();
    let selector = [None];
    let slots = [None];
    let maps = witness_maps(&crs.shape, &setup, &selector, &[None], &circuits).unwrap();
    let sc = connection_permutation_polynomial(&crs.shape, &setup, &selector, &[]).unwrap();
    let masks = ProverRandomizers::sample();
    let (proof, ch) = prove(ProvingInput {
        crs: &crs,
        setup: &setup,
        public_layout: &public,
        selector: &selector,
        slots: &slots,
        maps: &maps,
        s_c: &sc,
        public_inputs: &[f(0)],
        randomizers: &masks,
    })
    .unwrap();
    assert_eq!(
        proof.d_q,
        G1serde(g1) * (masks.selection * (secret.tau + f(1)))
    );
    assert_eq!(ch, derive_proof_challenges(&[f(0)], &proof, 1, 1));
    assert_eq!(proof.s_c.0, f(1));
    if let Some(path) = &parity_path {
        let scalar = |v: ScalarField| {
            let mut bytes = v.to_bytes_le();
            bytes.reverse();
            format!("0x{}", hex::encode(bytes))
        };
        let data = serde_json::json!({
            "setup": {"l_free":1,"l":1,"l_user_out":0,"l_user":0,"l_D":2,"m_D":4,"n":1,"m":4,"t":2,"s_D":1,"s_max":1},
            "infos": [{"id":0,"name":info.name,"Nwires":3,"Nconsts":1,"Out_idx":[1,0],"In_idx":[2,1],"flattenMap":[1,2,3],"bufferDirection":"out"}],
            "selector": [null], "witness": [null], "publicInputs": ["0x0"],
            "masks": masks.u.into_iter().chain(masks.v).chain(masks.w).chain(masks.b).chain(masks.r).chain([masks.selection]).map(scalar).collect::<Vec<_>>()
        });
        std::fs::write(
            path.join("fixture.json"),
            serde_json::to_vec_pretty(&data).unwrap(),
        )
        .unwrap();
        std::fs::write(
            path.join("univariate_proof.bin"),
            super::super::parity_tests::expected_bytes(&proof),
        )
        .unwrap();
    }
    super::super::parity_tests::compare(
        ProvingInput {
            crs: &crs,
            setup: &setup,
            public_layout: &public,
            selector: &selector,
            slots: &slots,
            maps: &maps,
            s_c: &sc,
            public_inputs: &[f(0)],
            randomizers: &masks,
        },
        &proof,
        &circuits,
    );
}
