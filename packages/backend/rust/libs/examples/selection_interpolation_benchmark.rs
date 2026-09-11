//! Release-only U29 comparison. Timings include cofactor preparation and conversion.
//! Usage: selection_interpolation_benchmark LIBRARY SYNTHESIZER_DIRECTORY [WIRE_LIMIT]
use icicle_bls12_381::curve::ScalarField;
use icicle_core::{polynomials::UnivariatePolynomial, traits::FieldImpl};
use icicle_runtime::memory::HostSlice;
use libs::{
    frontend_artifacts::{read_placement_selector, PlacementVariables, SetupParams},
    univariate_crs::UnivariateCrsShape,
    univariate_selection::SelectedRoots,
};
use std::{path::Path, time::Instant};

fn reference(roots: &SelectedRoots, witness: &[ScalarField], s: usize) -> Vec<ScalarField> {
    let mut result = vec![ScalarField::zero(); witness.len()];
    for (out, values) in result.chunks_mut(s).zip(witness.chunks(s)) {
        let q = roots.quotient_for_wire(values).unwrap();
        // ICICLE's zero polynomial can have a shorter allocated buffer.
        let count = (q.degree() + 1).max(1) as usize;
        q.copy_coeffs(0, HostSlice::from_mut_slice(&mut out[..count]));
    }
    result
}

fn main() {
    assert!(!cfg!(debug_assertions), "use --release");
    libs::utils::try_check_device().unwrap();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let setup = SetupParams::read_from_json(Path::new(&args[0]).join("setupParams.json")).unwrap();
    let fixture = Path::new(&args[1]);
    let selector =
        read_placement_selector(&fixture.join("selector.json"), setup.s_max, setup.s_D).unwrap();
    let placements =
        PlacementVariables::read_box_from_json(fixture.join("placementVariables.json")).unwrap();
    let mut active = placements.iter();
    let slots = selector
        .iter()
        .map(|id| {
            id.map(|id| {
                let placement = active.next().unwrap();
                assert_eq!(placement.subcircuitId, id);
                placement
                    .variables
                    .iter()
                    .map(|v| ScalarField::from_hex(v.as_ref()))
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    assert!(active.next().is_none());
    let wires = args
        .get(2)
        .map(|v| v.parse::<usize>().unwrap())
        .unwrap_or(setup.m)
        .min(setup.m);
    let witness = (0..wires)
        .flat_map(|j| {
            slots.iter().map(move |v| {
                v.as_ref()
                    .and_then(|v| v.get(j))
                    .copied()
                    .unwrap_or(ScalarField::zero())
            })
        })
        .collect::<Vec<_>>();
    let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
    let roots = SelectedRoots::new(&shape, &setup, &selector).unwrap();
    for trial in 0..3 {
        let (old, old_s, new, new_s) = if trial % 2 == 0 {
            let start = Instant::now();
            let old = reference(&roots, &witness, setup.s_max);
            let old_s = start.elapsed().as_secs_f64();
            let start = Instant::now();
            let new = roots.quotients_for_wires(&witness).unwrap();
            (old, old_s, new, start.elapsed().as_secs_f64())
        } else {
            let start = Instant::now();
            let new = roots.quotients_for_wires(&witness).unwrap();
            let new_s = start.elapsed().as_secs_f64();
            let start = Instant::now();
            let old = reference(&roots, &witness, setup.s_max);
            (old, start.elapsed().as_secs_f64(), new, new_s)
        };
        assert_eq!(old, new);
        println!(
            "{}",
            serde_json::json!({"trial":trial,"wires":wires,"slots":setup.s_max,"referenceSeconds":old_s,"candidateSeconds":new_s,"allCoefficientsEqual":true})
        );
    }
}
