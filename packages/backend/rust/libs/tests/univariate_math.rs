//! Current-protocol primitives, independent of the superseded proving path.
use icicle_bls12_381::curve::ScalarField;
use icicle_core::polynomials::UnivariatePolynomial;
use icicle_core::traits::{Arithmetic, FieldImpl};
use libs::frontend_artifacts::SetupParams;
use libs::univariate_crs::UnivariateCrsShape;
use libs::univariate_selection::SelectedRoots;

fn setup(n: usize, interface: usize, s: usize, compiled: usize) -> SetupParams {
    SetupParams {
        l_free: 2,
        l: 2,
        l_user_out: 0,
        l_user: 0,
        l_D: 2 + interface,
        m_D: 64 * compiled,
        n,
        m: 64,
        t: (compiled + 1).next_power_of_two(),
        s_D: compiled,
        s_max: s,
    }
}

#[test]
fn exact_domains_and_minimum_capacity_cover_independent_dimension_orders() {
    for (n, interface, s, compiled) in [
        (1, 1, 1, 1),
        (8, 2, 4, 3),
        (2, 8, 4, 4),
        (2, 2, 4, 44),
        (2, 2, 2, 63),
        (2, 2, 2, 64),
    ] {
        let setup = setup(n, interface, s, compiled);
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        assert_eq!(shape.arithmetic_domain_size, n * s);
        assert_eq!(shape.connection_domain_size, interface * s);
        assert_eq!(shape.selection_domain_size, setup.t * s);
        for (root, order) in [
            (shape.arithmetic_root, n * s),
            (shape.connection_root, interface * s),
            (shape.selection_root, setup.t * s),
        ] {
            assert_eq!(root.pow(order), ScalarField::one());
            if order > 1 {
                assert_ne!(root.pow(order / 2), ScalarField::one());
            }
        }
        let placement_root = shape.arithmetic_root.pow(n);
        assert_eq!(shape.connection_root.pow(interface), placement_root);
        assert_eq!(shape.selection_root.pow(setup.t), placement_root);
        let d = (n * s).max(interface * s) + 1;
        let lower_bounds = [
            2 * d + 1,
            setup.t * s + 1,
            d + 1 + s * (setup.t - 1),
            setup.l_free - 1,
        ];
        let p = shape.minimum_capacity[1];
        assert!(lower_bounds.iter().all(|bound| p >= *bound));
        assert!(lower_bounds.iter().any(|bound| p - 1 < *bound));
        assert_eq!(shape.minimum_capacity, [2 * p, p, p]);
        assert_eq!(shape.k, p - d);
        assert_eq!(shape.h, d + 1);
        assert_eq!(shape.k + shape.h, p + 1);
        for row in 0..n {
            for i in 0..s {
                assert_eq!(shape.arithmetic_index(i, row, &setup).unwrap(), i + s * row);
            }
        }
        for wire in 0..interface {
            for i in 0..s {
                assert_eq!(
                    shape.connection_index(i, wire, &setup).unwrap(),
                    i + s * wire
                );
            }
        }
        assert!(shape.arithmetic_index(s, 0, &setup).is_err());
        assert!(shape.arithmetic_index(0, n, &setup).is_err());
        assert!(shape.connection_index(s, 0, &setup).is_err());
        assert!(shape.connection_index(0, interface, &setup).is_err());
        assert!(shape.clone().with_declared_capacity([2 * p, p, p]).is_ok());
        assert!(shape
            .clone()
            .with_declared_capacity([2 * p + 1, p, p])
            .is_err());
        assert!(shape.with_declared_capacity([2 * p, p - 1, p]).is_err());
    }
}

#[test]
fn invalid_producer_capacities_and_overflow_are_rejected() {
    let changes: &[fn(&mut SetupParams)] = &[
        |s| s.n = 3,
        |s| s.m = 3,
        |s| s.s_max = 0,
        |s| s.l_free = 0,
        |s| s.t = 4,
        |s| s.t = 16,
        |s| s.m_D -= 1,
        |s| s.l_D = s.l + 3,
        |s| s.l_D = s.l - 1,
        |s| s.s_D = 0,
        |s| s.n = 1usize << (usize::BITS - 1),
    ];
    for change in changes {
        let mut setup = setup(2, 2, 2, 4);
        change(&mut setup);
        assert!(UnivariateCrsShape::from_setup_params(&setup).is_err());
    }
}

#[test]
fn selected_root_interpolation_covers_singleton_and_reserved_id_gaps() {
    for (s, compiled) in [(1, 1), (4, 4), (2, 44)] {
        let setup = setup(2, 2, s, compiled);
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        for active in [true, false] {
            let selector = (0..s)
                .map(|i| {
                    if active && i % 2 == 0 {
                        Some(compiled - 1)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            let selected = SelectedRoots::new(&shape, &setup, &selector).unwrap();
            let zu = selected.unselected_polynomial().unwrap();
            let values = selector
                .iter()
                .map(|id| {
                    if id.is_some() {
                        ScalarField::from_u32(7)
                    } else {
                        ScalarField::zero()
                    }
                })
                .collect::<Vec<_>>();
            let quotient = selected.quotient_for_wire(&values).unwrap();
            let binding = zu.mul(&quotient);
            let denominators = selected.unselected_values().unwrap();
            for i in 0..s {
                assert_eq!(denominators[i], zu.eval(&selected.roots[i]));
                assert_eq!(
                    quotient.eval(&selected.roots[i]) * denominators[i],
                    values[i]
                );
                for k in 0..setup.t {
                    let z = shape.selection_root.pow(i + s * k);
                    let expected = if selector[i] == Some(k) {
                        values[i]
                    } else {
                        ScalarField::zero()
                    };
                    assert_eq!(binding.eval(&z), expected);
                }
            }
            assert!(selected
                .quotient_for_wire(&values[..values.len() - 1])
                .is_err());
        }
        for forbidden in compiled..setup.t {
            assert!(SelectedRoots::new(&shape, &setup, &vec![Some(forbidden); s]).is_err());
        }
    }
}
