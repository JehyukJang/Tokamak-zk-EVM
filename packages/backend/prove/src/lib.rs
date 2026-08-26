// Prover terms intentionally use the mathematical notation from the protocol.
#![allow(non_snake_case)]

use icicle_bls12_381::curve::{ScalarCfg, ScalarField};
use icicle_core::ntt;
use icicle_core::traits::{Arithmetic, FieldImpl, GenerateRandom};
use icicle_runtime::memory::HostSlice;
use libs::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt, PolyExpr};
use libs::cli::CliDiagnostic;
use libs::errors::{ArtifactError, CrsError, DeviceError};
use libs::field_structures::FieldSerde;
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::{
    Instance, Permutation, PlacementVariables, SetupParams, SubcircuitInfo,
};
use libs::group_structures::G1serde;
use libs::polynomial_structures::gen_bXY;
use libs::proof_protocol::{Binding, Proof0, Proof1, Proof2, Proof3, Proof4, Proof4Test};
use libs::r1cs::read_R1CS_gen_uvwXY;
use libs::utils::{
    prover_verifier_ntt_domain_size, try_init_ntt_domain, try_load_setup_params_from_qap_path,
    try_setup_shape, try_validate_setup_shape,
};
#[cfg(feature = "testing-mode")]
use libs::vector_operations::point_mul_two_vecs;
use libs::vector_operations::{point_div_two_vecs, resize, transpose_inplace};
#[cfg(feature = "timing")]
use std::time::Instant;

use std::path::PathBuf;
use std::vec;
use thiserror::Error;

mod sigma_source;
use sigma_source::SigmaHolder;

#[derive(Debug, Error)]
pub enum ProveError {
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    Crs(#[from] CrsError),
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error("failed to write proof output at {}: {source}", path.display())]
    WriteOutput {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl CliDiagnostic for ProveError {
    fn hint(&self) -> &'static str {
        match self {
            Self::Artifact(_) => {
                "Regenerate the frontend artifacts and provide the matching synthesizer directory."
            }
            Self::Crs(_) => {
                "Use a CRS whose compatible backend version matches the selected subcircuit library, or use the explicit local development bypass only for local testing."
            }
            Self::Device(_) => "Check the ICICLE backend installation and the selected device.",
            Self::WriteOutput { .. } => {
                "Create or grant write access to the requested output directory, then retry."
            }
        }
    }
}

macro_rules! poly_comb {
        (($c:expr, $p:expr), $(($rest_c:expr, $rest_p:expr)),+ $(,)?) => {{
            let mut acc = &$p * &$c;
            $(
                acc += &(&$rest_p * &$rest_c);
            )+
            acc
        }};
    }

fn div_by_ruffini_with_constant_correction(
    polynomial: &DensePolynomialExt,
    x: &ScalarField,
    y: &ScalarField,
    correction: &ScalarField,
) -> (DensePolynomialExt, DensePolynomialExt, ScalarField) {
    // The original path materialized P - c before splitting it. Subtracting a
    // constant changes only the Ruffini remainder, so split P and correct r by c.
    let (quotient_x, quotient_y, remainder) = polynomial.div_by_ruffini(x, y);
    (quotient_x, quotient_y, remainder - *correction)
}

#[cfg(any(test, feature = "testing-mode"))]
fn assert_same_polynomial_exact(lhs: &DensePolynomialExt, rhs: &DensePolynomialExt) {
    assert_eq!(lhs.x_size, rhs.x_size);
    assert_eq!(lhs.y_size, rhs.y_size);
    assert_eq!(lhs.x_degree, rhs.x_degree);
    assert_eq!(lhs.y_degree, rhs.y_degree);
    let mut lhs_coefficients = vec![ScalarField::zero(); lhs.x_size * lhs.y_size];
    let mut rhs_coefficients = vec![ScalarField::zero(); rhs.x_size * rhs.y_size];
    lhs.copy_coeffs(0, HostSlice::from_mut_slice(&mut lhs_coefficients));
    rhs.copy_coeffs(0, HostSlice::from_mut_slice(&mut rhs_coefficients));
    assert_eq!(lhs_coefficients, rhs_coefficients);
}

fn low_degree_x_times_vanishing(coeffs: &[ScalarField], exponent: usize) -> DensePolynomialExt {
    assert!(exponent > 0);
    let x_size = (exponent + coeffs.len()).next_power_of_two();
    let mut out = vec![ScalarField::zero(); x_size];
    for (idx, coeff) in coeffs.iter().enumerate() {
        out[idx] = out[idx] - *coeff;
        out[idx + exponent] = out[idx + exponent] + *coeff;
    }
    DensePolynomialExt::from_coeffs(HostSlice::from_slice(&out), x_size, 1)
}

fn low_degree_y_times_vanishing(coeffs: &[ScalarField], exponent: usize) -> DensePolynomialExt {
    assert!(exponent > 0);
    let y_size = (exponent + coeffs.len()).next_power_of_two();
    let mut out = vec![ScalarField::zero(); y_size];
    for (idx, coeff) in coeffs.iter().enumerate() {
        out[idx] = out[idx] - *coeff;
        out[idx + exponent] = out[idx + exponent] + *coeff;
    }
    DensePolynomialExt::from_coeffs(HostSlice::from_slice(&out), 1, y_size)
}

fn mul_by_x_minus_one(poly: &DensePolynomialExt) -> DensePolynomialExt {
    let shifted = poly.mul_monomial(1, 0);
    &shifted - poly
}

fn mul_by_one_minus_x(poly: &DensePolynomialExt) -> DensePolynomialExt {
    let shifted = poly.mul_monomial(1, 0);
    poly - &shifted
}

fn mul_by_linear_x(poly: &DensePolynomialExt, coeffs: &[ScalarField]) -> DensePolynomialExt {
    assert_eq!(coeffs.len(), 2);
    let base = poly * &coeffs[0];
    let shifted = poly.mul_monomial(1, 0);
    let shifted_scaled = &shifted * &coeffs[1];
    &base + &shifted_scaled
}

fn mul_by_linear_y(poly: &DensePolynomialExt, coeffs: &[ScalarField]) -> DensePolynomialExt {
    assert_eq!(coeffs.len(), 2);
    let base = poly * &coeffs[0];
    let shifted = poly.mul_monomial(0, 1);
    let shifted_scaled = &shifted * &coeffs[1];
    &base + &shifted_scaled
}

fn mul_by_sparse_const_x_y(
    poly: &DensePolynomialExt,
    constant: &ScalarField,
    x_coeff: &ScalarField,
    y_coeff: &ScalarField,
) -> DensePolynomialExt {
    let base = poly * constant;
    let shifted_x = poly.mul_monomial(1, 0);
    let shifted_x_scaled = &shifted_x * x_coeff;
    let shifted_y = poly.mul_monomial(0, 1);
    let shifted_y_scaled = &shifted_y * y_coeff;
    let partial = &base + &shifted_x_scaled;
    &partial + &shifted_y_scaled
}

fn mul_by_term9(
    poly: &DensePolynomialExt,
    rB_X: &[ScalarField],
    rB_Y: &[ScalarField],
    t_mi_eval: &ScalarField,
    t_smax_eval: &ScalarField,
) -> DensePolynomialExt {
    assert_eq!(rB_X.len(), 2);
    assert_eq!(rB_Y.len(), 2);
    let constant = (*t_mi_eval * rB_X[0]) + (*t_smax_eval * rB_Y[0]);
    let x_coeff = *t_mi_eval * rB_X[1];
    let y_coeff = *t_smax_eval * rB_Y[1];
    mul_by_sparse_const_x_y(poly, &constant, &x_coeff, &y_coeff)
}

#[cfg(feature = "timing")]
#[macro_export]
macro_rules! time_block {
    ($name:expr, $category:expr, $block:block) => {{
        let _guard = $crate::timing::SpanGuard::new($name, $category, Vec::new());
        $block
    }};
    ($name:expr, $category:expr, $sizes:expr, $block:block) => {{
        let _guard = $crate::timing::SpanGuard::new($name, $category, $sizes);
        $block
    }};
}

#[cfg(not(feature = "timing"))]
#[macro_export]
macro_rules! time_block {
    ($name:expr, $category:expr, $block:block) => {{
        $block
    }};
    ($name:expr, $category:expr, $sizes:expr, $block:block) => {{
        $block
    }};
}

#[cfg(feature = "timing")]
pub use libs::timing;

pub struct ProveInputPaths<'a> {
    pub qap_path: &'a str,
    pub synthesizer_path: &'a str,
    pub setup_path: &'a str,
    pub output_path: &'a str,
}

pub struct Mixer {
    pub rU_X: ScalarField,
    pub rU_Y: ScalarField,
    pub rV_X: ScalarField,
    pub rV_Y: ScalarField,
    pub rW_X: Vec<ScalarField>,
    pub rW_Y: Vec<ScalarField>,
    pub rB_X: Vec<ScalarField>,
    pub rB_Y: Vec<ScalarField>,
    pub rR_X: ScalarField,
    pub rR_Y: ScalarField,
    pub rO_mid: ScalarField,
}
pub struct Compiler {
    pub setup_params: SetupParams,
    pub subcircuit_infos: Box<[SubcircuitInfo]>,
    pub global_wire_list: Box<[Box<[usize]>]>,
    pub placement_variables: Box<[PlacementVariables]>,
    pub permutation_raw: Box<[Permutation]>,
}
pub struct InstancePolynomials {
    pub s0XY: DensePolynomialExt,
    pub s1XY: DensePolynomialExt,
    pub t_n: DensePolynomialExt,
    pub t_mi: DensePolynomialExt,
    pub t_smax: DensePolynomialExt,
    pub a_free_X: DensePolynomialExt,
}
pub struct Witness {
    pub bXY: DensePolynomialExt,
    pub uXY: DensePolynomialExt,
    pub vXY: DensePolynomialExt,
    pub wXY: DensePolynomialExt,
    pub rXY: DensePolynomialExt,
}
pub struct Quotients {
    pub q0XY: DensePolynomialExt,
    pub q1XY: DensePolynomialExt,
    pub q2XY: DensePolynomialExt,
    pub q3XY: DensePolynomialExt,
    pub q4XY: DensePolynomialExt,
    pub q5XY: DensePolynomialExt,
    pub q6XY: DensePolynomialExt,
    pub q7XY: DensePolynomialExt,
}

pub struct ProverCache {
    w_zk: Option<DensePolynomialExt>,
    term_b_zk: Option<DensePolynomialExt>,
    lagrange_kl_xy: Option<DensePolynomialExt>,
}

pub struct Prover {
    pub setup_params: SetupParams,
    pub sigma: SigmaHolder,
    pub instance: InstancePolynomials,
    pub witness: Witness,
    pub mixer: Mixer,
    pub quotients: Quotients,
    pub cache: ProverCache,
}

impl Prover {
    pub fn init(paths: &ProveInputPaths) -> Result<(Self, Binding), ProveError> {
        #[cfg(feature = "timing")]
        let init_start = Instant::now();
        // Load setup parameters from JSON file
        let setup_params_path = PathBuf::from(paths.qap_path).join("setupParams.json");
        let _setup_params_file_bytes = std::fs::metadata(&setup_params_path)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        let setup_params = crate::time_block!(
            "init.load.setup_params",
            "load",
            vec![crate::timing::SizeInfo {
                label: "file_bytes",
                dims: vec![_setup_params_file_bytes]
            },],
            { try_load_setup_params_from_qap_path(paths.qap_path)? }
        );

        let shape = try_setup_shape(&setup_params, &setup_params_path)?;
        try_validate_setup_shape(&shape, &setup_params_path)?;
        let _l = setup_params.l;
        let m_i = shape.m_i;
        let n = shape.n;
        let s_max = shape.s_max;
        #[cfg(feature = "timing")]
        let s_d = setup_params.s_D;

        let ntt_domain_size = prover_verifier_ntt_domain_size(&shape);
        try_init_ntt_domain(ntt_domain_size)?;

        // Load subcircuit information
        let subcircuit_infos_path = PathBuf::from(paths.qap_path).join("subcircuitInfo.json");
        let _subcircuit_infos_file_bytes = std::fs::metadata(&subcircuit_infos_path)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        let subcircuit_infos = crate::time_block!(
            "init.load.subcircuit_infos",
            "load",
            vec![crate::timing::SizeInfo {
                label: "file_bytes",
                dims: vec![_subcircuit_infos_file_bytes]
            },],
            {
                SubcircuitInfo::read_box_from_json(subcircuit_infos_path.clone()).map_err(
                    |source| ArtifactError::Read {
                        artifact: "subcircuit information",
                        path: subcircuit_infos_path,
                        source,
                    },
                )?
            }
        );

        // Load local variables of placements (public instance + interface witness + internal witness)
        let placement_variables_path =
            PathBuf::from(paths.synthesizer_path).join("placementVariables.json");
        let _placement_variables_file_bytes = std::fs::metadata(&placement_variables_path)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        let placement_variables = crate::time_block!(
            "init.load.placement_variables",
            "load",
            vec![crate::timing::SizeInfo {
                label: "file_bytes",
                dims: vec![_placement_variables_file_bytes]
            },],
            {
                PlacementVariables::read_box_from_json(placement_variables_path.clone()).map_err(
                    |source| ArtifactError::Read {
                        artifact: "placement variables",
                        path: placement_variables_path,
                        source,
                    },
                )?
            }
        );

        let public_wire_layout =
            crate::time_block!("init.derive.public_wire_layout", "validate", vec![], {
                let global_wire_list_path =
                    PathBuf::from(paths.qap_path).join("globalWireList.json");
                let global_wires = read_global_wires(&global_wire_list_path).map_err(|source| {
                    ArtifactError::Read {
                        artifact: "global wire list",
                        path: global_wire_list_path.clone(),
                        source,
                    }
                })?;
                let layout =
                    PublicWireLayout::derive(&setup_params, &global_wires, &subcircuit_infos)
                        .map_err(|error| ArtifactError::Invalid {
                            artifact: "public wire layout",
                            path: global_wire_list_path,
                            reason: error.to_string(),
                        })?;
                layout
                    .validate_runtime_public_buffer_placements(&placement_variables)
                    .map_err(|error| ArtifactError::Invalid {
                        artifact: "placement variables",
                        path: PathBuf::from(paths.synthesizer_path).join("placementVariables.json"),
                        reason: error.to_string(),
                    })?;
                layout
            });

        let witness: Witness = {
            // Parsing the variables
            let bXY = crate::time_block!(
                "init.build.witness.bXY",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "bXY",
                    dims: vec![m_i, s_max]
                },],
                { gen_bXY(&placement_variables, &subcircuit_infos, &setup_params) }
            );
            let (uXY, vXY, wXY) = crate::time_block!(
                "init.build.witness.uvwXY",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "uXY/vXY/wXY",
                    dims: vec![n, s_max]
                },],
                {
                    read_R1CS_gen_uvwXY(
                        &paths.qap_path,
                        &placement_variables,
                        &subcircuit_infos,
                        &setup_params,
                    )
                }
            );
            let rXY = DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&vec![ScalarField::zero()]),
                1,
                1,
            );
            Witness {
                bXY,
                uXY,
                vXY,
                wXY,
                rXY,
            }
        };

        let quotients: Quotients = {
            let q0XY = DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&vec![ScalarField::zero()]),
                1,
                1,
            );
            let q1XY = q0XY.clone();
            let q2XY = q0XY.clone();
            let q3XY = q0XY.clone();
            let q4XY = q0XY.clone();
            let q5XY = q0XY.clone();
            let q6XY = q0XY.clone();
            let q7XY = q0XY.clone();
            Quotients {
                q0XY,
                q1XY,
                q2XY,
                q3XY,
                q4XY,
                q5XY,
                q6XY,
                q7XY,
            }
        };
        let cache = ProverCache {
            w_zk: None,
            term_b_zk: None,
            lagrange_kl_xy: None,
        };

        // Load permutation (copy constraints of the variables)
        let permutation_path = PathBuf::from(paths.synthesizer_path).join("permutation.json");
        let _permutation_file_bytes = std::fs::metadata(&permutation_path)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        let permutation_raw = crate::time_block!(
            "init.load.permutation",
            "load",
            vec![crate::timing::SizeInfo {
                label: "file_bytes",
                dims: vec![_permutation_file_bytes]
            },],
            {
                Permutation::read_box_from_json(permutation_path.clone()).map_err(|source| {
                    ArtifactError::Read {
                        artifact: "permutation",
                        path: permutation_path,
                        source,
                    }
                })?
            }
        );

        let mut instance: InstancePolynomials = {
            // Load instance
            let instance_path = PathBuf::from(paths.synthesizer_path).join("instance.json");
            let _instance_file_bytes = std::fs::metadata(&instance_path)
                .map(|m| m.len() as usize)
                .unwrap_or(0);
            let _instance = crate::time_block!(
                "init.load.instance",
                "load",
                vec![crate::timing::SizeInfo {
                    label: "file_bytes",
                    dims: vec![_instance_file_bytes]
                },],
                {
                    Instance::read_from_json(instance_path.clone()).map_err(|source| {
                        ArtifactError::Read {
                            artifact: "public instance",
                            path: instance_path,
                            source,
                        }
                    })?
                }
            );

            // Parsing the inputs
            let a_free_X = crate::time_block!(
                "init.build.instance.a_free_X",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "a_free_X",
                    dims: vec![setup_params.l_free, 1]
                },],
                { _instance.gen_a_free_X(&setup_params) }
            );
            // Fixed polynomials
            let t_n = crate::time_block!(
                "init.build.instance.t_n",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "t_n",
                    dims: vec![2 * n, 1]
                },],
                {
                    let mut t_n_coeffs = vec![ScalarField::zero(); 2 * n];
                    t_n_coeffs[0] = ScalarField::zero() - ScalarField::one();
                    t_n_coeffs[n] = ScalarField::one();
                    DensePolynomialExt::from_coeffs(HostSlice::from_slice(&t_n_coeffs), 2 * n, 1)
                }
            );
            let t_mi = crate::time_block!(
                "init.build.instance.t_mi",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "t_mi",
                    dims: vec![2 * m_i, 1]
                },],
                {
                    let mut t_mi_coeffs = vec![ScalarField::zero(); 2 * m_i];
                    t_mi_coeffs[0] = ScalarField::zero() - ScalarField::one();
                    t_mi_coeffs[m_i] = ScalarField::one();
                    DensePolynomialExt::from_coeffs(HostSlice::from_slice(&t_mi_coeffs), 2 * m_i, 1)
                }
            );
            let t_smax = crate::time_block!(
                "init.build.instance.t_smax",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "t_smax",
                    dims: vec![1, 2 * s_max]
                },],
                {
                    let mut t_smax_coeffs = vec![ScalarField::zero(); 2 * s_max];
                    t_smax_coeffs[0] = ScalarField::zero() - ScalarField::one();
                    t_smax_coeffs[s_max] = ScalarField::one();
                    DensePolynomialExt::from_coeffs(
                        HostSlice::from_slice(&t_smax_coeffs),
                        1,
                        2 * s_max,
                    )
                }
            );
            // Generating permutation polynomials
            let (s0XY, s1XY) = crate::time_block!(
                "init.build.instance.s0_s1",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "s0/s1",
                    dims: vec![m_i, s_max]
                },],
                { Permutation::to_poly(&permutation_raw, m_i, s_max) }
            );

            InstancePolynomials {
                a_free_X,
                t_n,
                t_mi,
                t_smax,
                s0XY,
                s1XY,
            }
        };

        #[cfg(feature = "testing-mode")]
        {
            use icicle_core::vec_ops::{VecOps, VecOpsConfig};
            // Checking Lemma 3
            let mut bXY_evals = vec![ScalarField::zero(); m_i * s_max];
            witness
                .bXY
                .to_rou_evals(None, None, HostSlice::from_mut_slice(&mut bXY_evals));
            let mut s0XY_evals = vec![ScalarField::zero(); m_i * s_max];
            instance
                .s0XY
                .to_rou_evals(None, None, HostSlice::from_mut_slice(&mut s0XY_evals));
            let mut s1XY_evals = vec![ScalarField::zero(); m_i * s_max];
            instance
                .s1XY
                .to_rou_evals(None, None, HostSlice::from_mut_slice(&mut s1XY_evals));

            let mut X_mono_coef = vec![ScalarField::zero(); m_i];
            X_mono_coef[1] = ScalarField::one();
            let X_mono =
                DensePolynomialExt::from_coeffs(HostSlice::from_slice(&X_mono_coef), m_i, 1);
            drop(X_mono_coef);
            let mut Y_mono_coef = vec![ScalarField::zero(); s_max];
            Y_mono_coef[1] = ScalarField::one();
            let Y_mono =
                DensePolynomialExt::from_coeffs(HostSlice::from_slice(&Y_mono_coef), 1, s_max);
            drop(Y_mono_coef);
            let mut X_mono_evals = vec![ScalarField::zero(); m_i];
            X_mono.to_rou_evals(None, None, HostSlice::from_mut_slice(&mut X_mono_evals));
            let mut Y_mono_evals = vec![ScalarField::zero(); s_max];
            Y_mono.to_rou_evals(None, None, HostSlice::from_mut_slice(&mut Y_mono_evals));

            let thetas = ScalarCfg::generate_random(3);
            let fXY = &(&(&witness.bXY + &(&thetas[0] * &instance.s0XY))
                + &(&thetas[1] * &instance.s1XY))
                + &thetas[2];
            let gXY =
                &(&(&witness.bXY + &(&thetas[0] * &X_mono)) + &(&thetas[1] * &Y_mono)) + &thetas[2];
            let mut fXY_evals = vec![ScalarField::zero(); m_i * s_max].into_boxed_slice();
            fXY.to_rou_evals(None, None, HostSlice::from_mut_slice(&mut fXY_evals));
            let mut gXY_evals = vec![ScalarField::zero(); m_i * s_max].into_boxed_slice();
            gXY.to_rou_evals(None, None, HostSlice::from_mut_slice(&mut gXY_evals));
            let omega_m_i = ntt::get_root_of_unity::<ScalarField>(m_i as u64);
            let omega_s_max = ntt::get_root_of_unity::<ScalarField>(s_max as u64);

            for i in 0..m_i {
                for j in 0..s_max {
                    assert!(X_mono_evals[i].eq(&omega_m_i.pow(i)));
                    assert!(Y_mono_evals[j].eq(&omega_s_max.pow(j)));
                }
            }
            let mut flag_b = true;
            let mut flag_s0 = true;
            let mut flag_s1 = true;
            let mut flag_r = true;
            for permEntry in &permutation_raw {
                let this_wire_idx = permEntry.row;
                let this_placement_idx = permEntry.col;
                let next_wire_idx = permEntry.X as usize;
                let next_placement_idx = permEntry.Y as usize;

                let this_idx = this_wire_idx * s_max + this_placement_idx;
                let next_idx = next_wire_idx * s_max + next_placement_idx;

                if !bXY_evals[this_idx].eq(&bXY_evals[next_idx]) {
                    flag_b = false;
                }
                if !s0XY_evals[this_idx].eq(&X_mono_evals[next_wire_idx]) {
                    flag_s0 = false;
                }
                if !s1XY_evals[this_idx].eq(&Y_mono_evals[next_placement_idx]) {
                    flag_s1 = false;
                }
                if !fXY_evals[this_idx].eq(&gXY_evals[next_idx]) {
                    flag_r = false;
                }
            }
            assert!(flag_b);
            println!("Checked: b(X,Y) satisfies the copy constraints.");
            assert!(flag_s0);
            println!("Checked: s^(0)(X,Y) is well-formed.");
            assert!(flag_s1);
            println!("Checked: s^(1)(X,Y) is well-formed.");
            assert!(flag_r);
            println!("Checked: f(X,Y) and g(X,Y) are well-formed.");

            let mut LHS = vec![ScalarField::zero(); 1];
            let mut RHS = vec![ScalarField::zero(); 1];
            let vec_ops = VecOpsConfig::default();
            ScalarCfg::product(
                HostSlice::from_slice(&fXY_evals),
                HostSlice::from_mut_slice(&mut LHS),
                &vec_ops,
            )
            .unwrap();
            ScalarCfg::product(
                HostSlice::from_slice(&gXY_evals),
                HostSlice::from_mut_slice(&mut RHS),
                &vec_ops,
            )
            .unwrap();
            assert!(LHS[0].eq(&RHS[0]));
            println!("Checked: Lemma 3");
        }

        // Load Sigma (reference string)
        let sigma_path = PathBuf::from(paths.setup_path).join("combined_sigma.rkyv");
        let _sigma_file_bytes = std::fs::metadata(&sigma_path)
            .map(|m| m.len() as usize)
            .unwrap_or(0);
        let sigma = crate::time_block!(
            "init.load.sigma",
            "load",
            vec![crate::timing::SizeInfo {
                label: "file_bytes",
                dims: vec![_sigma_file_bytes]
            },],
            {
                let sigma = SigmaHolder::load(&sigma_path).map_err(|source| CrsError::Read {
                    path: sigma_path,
                    source,
                })?;
                sigma
            }
        );

        let mixer: Mixer = {
            let rU_X = ScalarCfg::generate_random(1)[0];
            let rU_Y = ScalarCfg::generate_random(1)[0];
            let rV_X = ScalarCfg::generate_random(1)[0];
            let rV_Y = ScalarCfg::generate_random(1)[0];
            let rW_X = resize(
                &ScalarCfg::generate_random(3),
                3,
                1,
                4,
                1,
                ScalarField::zero(),
            );
            let rW_Y = resize(
                &ScalarCfg::generate_random(3),
                1,
                3,
                1,
                4,
                ScalarField::zero(),
            );
            let rB_X = ScalarCfg::generate_random(2);
            let rB_Y = ScalarCfg::generate_random(2);
            let rO_mid = ScalarCfg::generate_random(1)[0];
            let rR_X = ScalarCfg::generate_random(1)[0];
            let rR_Y = ScalarCfg::generate_random(1)[0];

            Mixer {
                rB_X,
                rB_Y,
                rR_X,
                rR_Y,
                rU_X,
                rU_Y,
                rV_X,
                rV_Y,
                rW_X,
                rW_Y,
                rO_mid,
            }
        };

        println!("🔄 Starting binding computation (MSMs)...");
        let binding: Binding = {
            let A_free = crate::time_block!(
                "init.build.binding.A_free",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "A_free",
                    dims: vec![setup_params.l_free, 1]
                },],
                {
                    sigma.sigma1().encode_poly_timed(
                        &mut instance.a_free_X,
                        &setup_params,
                        "init.encode.A_free",
                    )
                }
            );
            let O_pub_free = crate::time_block!(
                "init.build.binding.O_pub_free",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "O_pub_free",
                    dims: vec![setup_params.l_free, 1]
                },],
                {
                    sigma
                        .sigma1()
                        .encode_O_pub_free(&placement_variables, &public_wire_layout)
                }
            );

            let O_mid_core = crate::time_block!(
                "init.build.binding.O_mid_core",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "O_mid_core",
                    dims: vec![setup_params.l_D, 1]
                },],
                {
                    sigma.sigma1().encode_O_mid_no_zk(
                        &placement_variables,
                        &subcircuit_infos,
                        &setup_params,
                    )
                }
            );
            let O_mid = O_mid_core + sigma.sigma1().delta() * mixer.rO_mid;
            let O_prv_core = crate::time_block!(
                "init.build.binding.O_prv_core",
                "build",
                vec![crate::timing::SizeInfo {
                    label: "O_prv_core",
                    dims: vec![setup_params.l_D, 1]
                },],
                {
                    sigma.sigma1().encode_O_prv_no_zk(
                        &placement_variables,
                        &subcircuit_infos,
                        &setup_params,
                    )
                }
            );
            let O_prv = O_prv_core - sigma.sigma1().eta() * mixer.rO_mid
                + sigma.sigma1().delta_inv_alphak_xh_tx(0, 0) * mixer.rU_X
                + sigma.sigma1().delta_inv_alphak_xh_tx(1, 0) * mixer.rV_X
                + (sigma.sigma1().delta_inv_alphak_xh_tx(2, 0) * mixer.rW_X[0]
                    + sigma.sigma1().delta_inv_alphak_xh_tx(2, 1) * mixer.rW_X[1]
                    + sigma.sigma1().delta_inv_alphak_xh_tx(2, 2) * mixer.rW_X[2])
                + (sigma.sigma1().delta_inv_alpha4_xj_tx(0) * mixer.rB_X[0]
                    + sigma.sigma1().delta_inv_alpha4_xj_tx(1) * mixer.rB_X[1])
                + sigma.sigma1().delta_inv_alphak_yi_ty(0, 0) * mixer.rU_Y
                + sigma.sigma1().delta_inv_alphak_yi_ty(1, 0) * mixer.rV_Y
                + (sigma.sigma1().delta_inv_alphak_yi_ty(2, 0) * mixer.rW_Y[0]
                    + sigma.sigma1().delta_inv_alphak_yi_ty(2, 1) * mixer.rW_Y[1]
                    + sigma.sigma1().delta_inv_alphak_yi_ty(2, 2) * mixer.rW_Y[2])
                + (sigma.sigma1().delta_inv_alphak_yi_ty(3, 0) * mixer.rB_Y[0]
                    + sigma.sigma1().delta_inv_alphak_yi_ty(3, 1) * mixer.rB_Y[1]);
            Binding {
                A_free,
                O_pub_free,
                O_mid,
                O_prv,
            }
        };

        #[cfg(feature = "timing")]
        crate::timing::record(
            "init.total",
            "init",
            init_start.elapsed(),
            vec![
                crate::timing::SizeInfo {
                    label: "n_s_max",
                    dims: vec![n, s_max],
                },
                crate::timing::SizeInfo {
                    label: "m_i_s_max",
                    dims: vec![m_i, s_max],
                },
                crate::timing::SizeInfo {
                    label: "l",
                    dims: vec![_l],
                },
                crate::timing::SizeInfo {
                    label: "s_D",
                    dims: vec![s_d],
                },
            ],
        );

        Ok((
            Self {
                sigma,
                setup_params,
                instance,
                witness,
                mixer,
                quotients,
                cache,
            },
            binding,
        ))
    }

    pub fn prove0(&mut self) -> Proof0 {
        #[cfg(feature = "timing")]
        let _total = crate::timing::SpanGuard::new(
            "prove0.total",
            "prove",
            vec![
                crate::timing::SizeInfo {
                    label: "uXY",
                    dims: vec![self.witness.uXY.x_size, self.witness.uXY.y_size],
                },
                crate::timing::SizeInfo {
                    label: "n_s_max",
                    dims: vec![self.setup_params.n, self.setup_params.s_max],
                },
            ],
        );
        // Arithmetic constraints argument polynomials
        let mut p0XY = crate::time_block!(
            "poly.combine.prove0.p0XY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "p0XY",
                dims: vec![self.witness.uXY.x_size, self.witness.uXY.y_size]
            },],
            { &(&self.witness.uXY * &self.witness.vXY) - &self.witness.wXY }
        );
        #[cfg(feature = "testing-mode")]
        {
            let mut uXY_evals_vec =
                vec![ScalarField::zero(); self.witness.uXY.x_size * self.witness.uXY.y_size];
            let uXY_evals = HostSlice::from_mut_slice(&mut uXY_evals_vec);
            self.witness.uXY.to_rou_evals(None, None, uXY_evals);

            let mut vXY_evals_vec =
                vec![ScalarField::zero(); self.witness.vXY.x_size * self.witness.vXY.y_size];
            let vXY_evals = HostSlice::from_mut_slice(&mut vXY_evals_vec);
            self.witness.vXY.to_rou_evals(None, None, vXY_evals);

            let mut wXY_evals_vec =
                vec![ScalarField::zero(); self.witness.wXY.x_size * self.witness.wXY.y_size];
            let wXY_evals = HostSlice::from_mut_slice(&mut wXY_evals_vec);
            self.witness.wXY.to_rou_evals(None, None, wXY_evals);

            let mut LHS_mat =
                vec![ScalarField::zero(); self.witness.wXY.x_size * self.witness.wXY.y_size]
                    .into_boxed_slice();
            point_mul_two_vecs(
                &uXY_evals_vec.as_slice(),
                &vXY_evals_vec.as_slice(),
                &mut LHS_mat,
            );

            let mut fullFlag = true;
            for col in 0..self.setup_params.s_max {
                let mut flag = true;
                for row in 0..self.setup_params.n {
                    let index = col + row * self.setup_params.s_max;
                    if LHS_mat[index] != wXY_evals_vec[index] {
                        flag = false;
                        break;
                    }
                }
                if flag == false {
                    println!("Placement indexed at {} does not satisfy R1CS", col);
                    fullFlag = false;
                }
            }
            if fullFlag == true {
                println!("Checked: Evaluations of u(X,Y), v(X,Y), and w(X,Y) satisfy R1CS.");
            } else {
                panic!("Evaluations of u(X,Y), v(X,Y), and w(X,Y) do not satisfy R1CS.")
            }
        }
        (self.quotients.q0XY, self.quotients.q1XY) = crate::time_block!(
            "poly.div_by_vanishing_opt.prove0.q0q1",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "vanishing",
                dims: vec![self.setup_params.n, self.setup_params.s_max]
            },],
            {
                p0XY.div_by_vanishing_opt(
                    self.setup_params.n as i64,
                    self.setup_params.s_max as i64,
                )
            }
        );
        #[cfg(feature = "testing-mode")]
        {
            let x_e = ScalarCfg::generate_random(1)[0];
            let y_e = ScalarCfg::generate_random(1)[0];
            let p_0_eval = p0XY.eval(&x_e, &y_e);
            let q_0_eval = self.quotients.q0XY.eval(&x_e, &y_e);
            let q_1_eval = self.quotients.q1XY.eval(&x_e, &y_e);
            let t_n_eval = x_e.pow(self.setup_params.n) - ScalarField::one();
            let t_smax_eval = y_e.pow(self.setup_params.s_max) - ScalarField::one();
            assert!(p_0_eval.eq(&(q_0_eval * t_n_eval + q_1_eval * t_smax_eval)));
            println!("Checked: u(X,Y), v(X,Y), and w(X,Y) satisfy the arithmetic constraints.")
        }

        // Adding zero-knowledge
        let rW_X = DensePolynomialExt::from_coeffs(
            HostSlice::from_slice(&self.mixer.rW_X),
            self.mixer.rW_X.len(),
            1,
        );
        let rW_Y = DensePolynomialExt::from_coeffs(
            HostSlice::from_slice(&self.mixer.rW_Y),
            1,
            self.mixer.rW_Y.len(),
        );

        let U = {
            let mut UXY = crate::time_block!(
                "poly.combine.prove0.U",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "U",
                    dims: vec![self.witness.uXY.x_size, self.witness.uXY.y_size]
                },],
                {
                    poly_comb!(
                        (ScalarField::one(), self.witness.uXY),
                        (self.mixer.rU_X, self.instance.t_n),
                        (self.mixer.rU_Y, self.instance.t_smax)
                    )
                }
            );
            crate::time_block!(
                "prove0.encode.U",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "U",
                    dims: vec![self.witness.uXY.x_size, self.witness.uXY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut UXY,
                        &self.setup_params,
                        "prove0.encode.U",
                    )
                }
            )
        };

        let V = {
            let mut VXY = crate::time_block!(
                "poly.combine.prove0.V",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "V",
                    dims: vec![self.witness.vXY.x_size, self.witness.vXY.y_size]
                },],
                {
                    poly_comb!(
                        (ScalarField::one(), self.witness.vXY),
                        (self.mixer.rV_X, self.instance.t_n),
                        (self.mixer.rV_Y, self.instance.t_smax)
                    )
                }
            );
            crate::time_block!(
                "prove0.encode.V",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "V",
                    dims: vec![self.witness.vXY.x_size, self.witness.vXY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut VXY,
                        &self.setup_params,
                        "prove0.encode.V",
                    )
                }
            )
        };

        let W = {
            let mut WXY = crate::time_block!(
                "poly.combine.prove0.W",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "W",
                    dims: vec![self.witness.wXY.x_size, self.witness.wXY.y_size]
                },],
                {
                    // Original expression:
                    // W = wXY + rW_X * t_n + rW_Y * t_smax.
                    let rW_X_t_n =
                        low_degree_x_times_vanishing(&self.mixer.rW_X, self.setup_params.n);
                    let rW_Y_t_smax =
                        low_degree_y_times_vanishing(&self.mixer.rW_Y, self.setup_params.s_max);
                    let W_zk = &rW_X_t_n + &rW_Y_t_smax;
                    self.cache.w_zk = Some(W_zk.clone());
                    &self.witness.wXY + &W_zk
                }
            );
            crate::time_block!(
                "prove0.encode.W",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "W",
                    dims: vec![self.witness.wXY.x_size, self.witness.wXY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut WXY,
                        &self.setup_params,
                        "prove0.encode.W",
                    )
                }
            )
        };

        let Q_AX = {
            let mut Q_AX_XY = crate::time_block!(
                "poly.combine.prove0.Q_AX",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "Q_AX",
                    dims: vec![self.quotients.q0XY.x_size, self.quotients.q0XY.y_size]
                },],
                {
                    poly_comb!(
                        (ScalarField::one(), self.quotients.q0XY),
                        (self.mixer.rU_X, self.witness.vXY),
                        (self.mixer.rV_X, self.witness.uXY),
                        (ScalarField::zero() - ScalarField::one(), rW_X),
                        (self.mixer.rU_X * self.mixer.rV_X, self.instance.t_n),
                        (self.mixer.rU_Y * self.mixer.rV_X, self.instance.t_smax)
                    )
                }
            );
            crate::time_block!(
                "prove0.encode.Q_AX",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "Q_AX",
                    dims: vec![self.quotients.q0XY.x_size, self.quotients.q0XY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut Q_AX_XY,
                        &self.setup_params,
                        "prove0.encode.Q_AX",
                    )
                }
            )
        };

        let Q_AY = {
            let mut Q_AY_XY = crate::time_block!(
                "poly.combine.prove0.Q_AY",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "Q_AY",
                    dims: vec![self.quotients.q1XY.x_size, self.quotients.q1XY.y_size]
                },],
                {
                    poly_comb!(
                        (ScalarField::one(), self.quotients.q1XY),
                        (self.mixer.rU_Y, self.witness.vXY),
                        (self.mixer.rV_Y, self.witness.uXY),
                        (ScalarField::zero() - ScalarField::one(), rW_Y),
                        (self.mixer.rU_X * self.mixer.rV_Y, self.instance.t_n),
                        (self.mixer.rU_Y * self.mixer.rV_Y, self.instance.t_smax)
                    )
                }
            );
            crate::time_block!(
                "prove0.encode.Q_AY",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "Q_AY",
                    dims: vec![self.quotients.q1XY.x_size, self.quotients.q1XY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut Q_AY_XY,
                        &self.setup_params,
                        "prove0.encode.Q_AY",
                    )
                }
            )
        };
        drop(rW_X);
        drop(rW_Y);

        let B = {
            let mut BXY = crate::time_block!(
                "poly.combine.prove0.B",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "B",
                    dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                },],
                {
                    // Original expression:
                    // B = bXY + rB_X * t_mi + rB_Y * t_smax.
                    let rB_X_t_mi = low_degree_x_times_vanishing(
                        &self.mixer.rB_X,
                        self.setup_params.l_D - self.setup_params.l,
                    );
                    let rB_Y_t_smax =
                        low_degree_y_times_vanishing(&self.mixer.rB_Y, self.setup_params.s_max);
                    let term_B_zk = &rB_X_t_mi + &rB_Y_t_smax;
                    self.cache.term_b_zk = Some(term_B_zk.clone());
                    &self.witness.bXY + &term_B_zk
                }
            );
            crate::time_block!(
                "prove0.encode.B",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "B",
                    dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut BXY,
                        &self.setup_params,
                        "prove0.encode.B",
                    )
                }
            )
        };

        return Proof0 {
            U,
            V,
            W,
            Q_AX,
            Q_AY,
            B,
        };
    }

    pub fn prove1(&mut self, thetas: &Vec<ScalarField>) -> Proof1 {
        let m_i = self.setup_params.l_D - self.setup_params.l;
        let s_max = self.setup_params.s_max;
        #[cfg(feature = "timing")]
        let _total = crate::timing::SpanGuard::new(
            "prove1.total",
            "prove",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max],
            }],
        );

        let mut X_mono_coef = vec![ScalarField::zero(); 2];
        X_mono_coef[1] = ScalarField::one();
        let X_mono = DensePolynomialExt::from_coeffs(HostSlice::from_slice(&X_mono_coef), 2, 1);
        drop(X_mono_coef);

        let mut Y_mono_coef = vec![ScalarField::zero(); 2];
        Y_mono_coef[1] = ScalarField::one();
        let Y_mono = DensePolynomialExt::from_coeffs(HostSlice::from_slice(&Y_mono_coef), 1, 2);
        drop(Y_mono_coef);

        let fXY = &(&(&self.witness.bXY + &(&thetas[0] * &self.instance.s0XY))
            + &(&thetas[1] * &self.instance.s1XY))
            + &thetas[2];
        let gXY = &(&(&self.witness.bXY + &(&thetas[0] * &X_mono)) + &(&thetas[1] * &Y_mono))
            + &thetas[2];

        let fXY_evals = crate::time_block!(
            "poly.to_rou_evals.prove1.fXY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "fXY",
                dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
            },],
            {
                let mut fXY_evals = vec![ScalarField::zero(); m_i * s_max].into_boxed_slice();
                fXY.to_rou_evals(None, None, HostSlice::from_mut_slice(&mut fXY_evals));
                fXY_evals
            }
        );
        let gXY_evals = crate::time_block!(
            "poly.to_rou_evals.prove1.gXY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "gXY",
                dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
            },],
            {
                let mut gXY_evals = vec![ScalarField::zero(); m_i * s_max].into_boxed_slice();
                gXY.to_rou_evals(None, None, HostSlice::from_mut_slice(&mut gXY_evals));
                gXY_evals
            }
        );
        let rXY_evals = crate::time_block!(
            "poly.recursion_eval.prove1.rXY",
            "poly",
            vec![
                crate::timing::SizeInfo {
                    label: "fXY_evals",
                    dims: vec![m_i * s_max]
                },
                crate::timing::SizeInfo {
                    label: "gXY_evals",
                    dims: vec![m_i * s_max]
                },
                crate::timing::SizeInfo {
                    label: "grid",
                    dims: vec![m_i, s_max]
                },
            ],
            {
                // Generating the recursion polynomial r(X,Y)
                let mut rXY_evals = vec![ScalarField::zero(); m_i * s_max];
                let mut scalers_tr = vec![ScalarField::zero(); m_i * s_max];
                point_div_two_vecs(&gXY_evals, &fXY_evals, &mut scalers_tr);
                transpose_inplace(&mut scalers_tr, m_i, s_max);
                rXY_evals[m_i * s_max - 1] = ScalarField::one();
                for idx in (0..m_i * s_max - 1).rev() {
                    rXY_evals[idx] = rXY_evals[idx + 1] * scalers_tr[idx + 1];
                }
                transpose_inplace(&mut rXY_evals, s_max, m_i);
                rXY_evals
            }
        );

        self.witness.rXY = crate::time_block!(
            "poly.from_rou_evals.prove1.rXY",
            "poly",
            vec![
                crate::timing::SizeInfo {
                    label: "rXY_evals",
                    dims: vec![m_i * s_max]
                },
                crate::timing::SizeInfo {
                    label: "grid",
                    dims: vec![m_i, s_max]
                },
            ],
            {
                DensePolynomialExt::from_rou_evals(
                    HostSlice::from_slice(&rXY_evals),
                    m_i,
                    s_max,
                    None,
                    None,
                )
            }
        );

        #[cfg(feature = "testing-mode")]
        {
            let mut flag1 = true;
            for row_idx in 1..m_i - 1 {
                for col_idx in 0..s_max - 1 {
                    let this_idx = row_idx * s_max + col_idx;
                    let ref_idx = (row_idx - 1) * s_max + col_idx;
                    if !(rXY_evals[this_idx] * gXY_evals[this_idx])
                        .eq(&(rXY_evals[ref_idx] * fXY_evals[this_idx]))
                    {
                        flag1 = false;
                    }
                }
            }
            assert!(flag1);
            let mut flag2 = true;
            for col_idx in 0..s_max - 1 {
                let this_idx = col_idx;
                let ref_idx = s_max * (m_i - 1) + col_idx - 1;
                if !(rXY_evals[this_idx] * gXY_evals[this_idx])
                    .eq(&(rXY_evals[ref_idx] * fXY_evals[this_idx]))
                {
                    flag2 = false;
                }
            }
            assert!(flag2);
            println!("Checked: r(X,Y) is well constructed.")
        }

        // Adding zero-knowledge to the copy constraint argument
        let mut RXY = crate::time_block!(
            "poly.combine.prove1.R",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "R",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            {
                &self.witness.rXY
                    + &(&(&self.mixer.rR_X * &self.instance.t_mi)
                        + &(&self.mixer.rR_Y * &self.instance.t_smax))
            }
        );

        let R = crate::time_block!(
            "prove1.encode.R",
            "encode_call",
            vec![crate::timing::SizeInfo {
                label: "R",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            {
                self.sigma.sigma1().encode_poly_timed(
                    &mut RXY,
                    &self.setup_params,
                    "prove1.encode.R",
                )
            }
        );

        return Proof1 { R };
    }

    pub fn prove2(&mut self, thetas: &Vec<ScalarField>, kappa0: ScalarField) -> Proof2 {
        let m_i = self.setup_params.l_D - self.setup_params.l;
        let s_max = self.setup_params.s_max;
        let kappa0_sq = kappa0.pow(2);
        #[cfg(feature = "timing")]
        let _total = crate::timing::SpanGuard::new(
            "prove2.total",
            "prove",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max],
            }],
        );
        let omega_m_i = ntt::get_root_of_unity::<ScalarField>(m_i as u64);
        let omega_s_max = ntt::get_root_of_unity::<ScalarField>(s_max as u64);
        let r_omegaX = crate::time_block!(
            "poly.scale_coeffs.prove2.r_omegaX",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "rXY",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            { self.witness.rXY.scale_coeffs_x(&omega_m_i.inv()) }
        );
        let r_omegaX_omegaY = crate::time_block!(
            "poly.scale_coeffs.prove2.r_omegaX_omegaY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "r_omegaX",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            { r_omegaX.scale_coeffs_y(&omega_s_max.inv()) }
        );
        #[cfg(feature = "testing-mode")]
        {
            let x_e = ScalarCfg::generate_random(1)[0];
            let y_e = ScalarCfg::generate_random(1)[0];
            let r_eval = self.witness.rXY.eval(&x_e, &y_e);
            let r_eval_from_r_omegaX = r_omegaX.eval(&(omega_m_i * x_e), &y_e);
            let r_eval_from_r_omegaX_omegaY =
                r_omegaX_omegaY.eval(&(omega_m_i * x_e), &(omega_s_max * y_e));

            assert!(r_eval.eq(&(r_eval_from_r_omegaX)));
            assert!(r_eval.eq(&(r_eval_from_r_omegaX_omegaY)));
        }
        let mut X_mono_coef = vec![ScalarField::zero(); 2];
        X_mono_coef[1] = ScalarField::one();
        let X_mono = DensePolynomialExt::from_coeffs(HostSlice::from_slice(&X_mono_coef), 2, 1);

        let mut Y_mono_coef = vec![ScalarField::zero(); 2];
        Y_mono_coef[1] = ScalarField::one();
        let Y_mono = DensePolynomialExt::from_coeffs(HostSlice::from_slice(&Y_mono_coef), 1, 2);

        let fXY = &(&(&self.witness.bXY + &(&thetas[0] * &self.instance.s0XY))
            + &(&thetas[1] * &self.instance.s1XY))
            + &thetas[2];
        let gXY = &(&(&self.witness.bXY + &(&thetas[0] * &X_mono)) + &(&thetas[1] * &Y_mono))
            + &thetas[2];

        // Generating the copy constraints argumet polynomials p_1(X,Y), p_2(X,Y), p_3(X,Y)
        let lagrange_KL_XY = {
            let mut k_evals = vec![ScalarField::zero(); m_i];
            k_evals[m_i - 1] = ScalarField::one();
            let lagrange_K_XY = crate::time_block!(
                "poly.from_rou_evals.prove2.K",
                "poly",
                vec![
                    crate::timing::SizeInfo {
                        label: "k_evals",
                        dims: vec![m_i]
                    },
                    crate::timing::SizeInfo {
                        label: "grid",
                        dims: vec![m_i, 1]
                    },
                ],
                {
                    DensePolynomialExt::from_rou_evals(
                        HostSlice::from_slice(&k_evals),
                        m_i,
                        1,
                        None,
                        None,
                    )
                }
            );

            let mut l_evals = vec![ScalarField::zero(); s_max];
            l_evals[s_max - 1] = ScalarField::one();
            let lagrange_L_XY = crate::time_block!(
                "poly.from_rou_evals.prove2.L",
                "poly",
                vec![
                    crate::timing::SizeInfo {
                        label: "l_evals",
                        dims: vec![s_max]
                    },
                    crate::timing::SizeInfo {
                        label: "grid",
                        dims: vec![1, s_max]
                    },
                ],
                {
                    DensePolynomialExt::from_rou_evals(
                        HostSlice::from_slice(&l_evals),
                        1,
                        s_max,
                        None,
                        None,
                    )
                }
            );
            &lagrange_K_XY * &lagrange_L_XY
        };
        self.cache.lagrange_kl_xy = Some(lagrange_KL_XY.clone());

        let lagrange_K0_XY = crate::time_block!(
            "poly.from_rou_evals.prove2.K0",
            "poly",
            vec![
                crate::timing::SizeInfo {
                    label: "k0_evals",
                    dims: vec![m_i]
                },
                crate::timing::SizeInfo {
                    label: "grid",
                    dims: vec![m_i, 1]
                },
            ],
            {
                let mut k0_evals = vec![ScalarField::zero(); m_i];
                k0_evals[0] = ScalarField::one();
                let lagrange_K0_XY = DensePolynomialExt::from_rou_evals(
                    HostSlice::from_slice(&k0_evals),
                    m_i,
                    1,
                    None,
                    None,
                );
                drop(k0_evals);
                lagrange_K0_XY
            }
        );

        let mut p_comb = crate::time_block!(
            "poly.combine.prove2.p_comb",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "p_comb",
                dims: vec![m_i, s_max]
            },],
            {
                let r_gXY = PolyExpr::mul(PolyExpr::poly(&self.witness.rXY), PolyExpr::poly(&gXY));
                let p1XY = PolyExpr::mul(
                    PolyExpr::sub(
                        PolyExpr::poly(&self.witness.rXY),
                        PolyExpr::scalar(ScalarField::one()),
                    ),
                    PolyExpr::poly(&lagrange_KL_XY),
                );
                let p2XY = PolyExpr::mul_x_minus_one(PolyExpr::sub(
                    r_gXY.clone(),
                    PolyExpr::mul(PolyExpr::poly(&r_omegaX), PolyExpr::poly(&fXY)),
                ));
                let p3XY = PolyExpr::mul(
                    PolyExpr::poly(&lagrange_K0_XY),
                    PolyExpr::sub(
                        r_gXY,
                        PolyExpr::mul(PolyExpr::poly(&r_omegaX_omegaY), PolyExpr::poly(&fXY)),
                    ),
                );

                let expr = PolyExpr::weighted_sum(vec![
                    (ScalarField::one(), p1XY),
                    (kappa0, p2XY),
                    (kappa0_sq, p3XY),
                ]);
                expr.evaluate_fused_with_domain(4 * m_i, 2 * s_max)
            }
        );
        (self.quotients.q2XY, self.quotients.q3XY) = crate::time_block!(
            "poly.div_by_vanishing_opt.prove2.qCXqCY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "vanishing",
                dims: vec![m_i, s_max]
            },],
            { p_comb.div_by_vanishing_opt(m_i as i64, s_max as i64) }
        );
        #[cfg(feature = "testing-mode")]
        {
            let x_e = ScalarCfg::generate_random(1)[0];
            let y_e = ScalarCfg::generate_random(1)[0];
            let p_comb_eval = p_comb.eval(&x_e, &y_e);
            let q_CX_eval = self.quotients.q2XY.eval(&x_e, &y_e);
            let q_CY_eval = self.quotients.q3XY.eval(&x_e, &y_e);

            let t_mi_eval = x_e.pow(m_i) - ScalarField::one();
            let t_smax_eval = y_e.pow(s_max) - ScalarField::one();
            assert!(p_comb_eval.eq(&(q_CX_eval * t_mi_eval + q_CY_eval * t_smax_eval)));
            println!("Checked: combined copy-constraint quotient relation holds.")
        }

        // Adding zero-knowledge to the copy constraint argument
        let (r_D1, r_D2, g_D) = (
            &self.witness.rXY - &r_omegaX,
            &self.witness.rXY - &r_omegaX_omegaY,
            &gXY - &fXY,
        );
        drop(gXY);
        drop(fXY);

        let Q_CX: G1serde = {
            let mut Q_CX_XY = crate::time_block!(
                "poly.combine.prove2.Q_CX",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "Q_CX",
                    dims: vec![self.quotients.q2XY.x_size, self.quotients.q2XY.y_size]
                },],
                {
                    // Original expression:
                    // (rB_X * (X - 1)) * r_D1 + (rR_X * (X - 1)) * g_D
                    // and
                    // (rB_X * K0) * r_D2 + (rR_X * K0) * g_D.
                    // Factor the common left polynomial in each branch.
                    let rB_X_r_D1 = mul_by_linear_x(&r_D1, &self.mixer.rB_X);
                    let rB_X_r_D2 = mul_by_linear_x(&r_D2, &self.mixer.rB_X);
                    let d1_comb = &rB_X_r_D1 + &(&self.mixer.rR_X * &g_D);
                    let d2_comb = &rB_X_r_D2 + &(&self.mixer.rR_X * &g_D);
                    let x_minus_one_d1_comb = mul_by_x_minus_one(&d1_comb);
                    poly_comb!(
                        (ScalarField::one(), self.quotients.q2XY),
                        (self.mixer.rR_X, lagrange_KL_XY),
                        (kappa0, x_minus_one_d1_comb),
                        (kappa0_sq, &lagrange_K0_XY * &d2_comb)
                    )
                }
            );
            crate::time_block!(
                "prove2.encode.Q_CX",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "Q_CX",
                    dims: vec![self.quotients.q2XY.x_size, self.quotients.q2XY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut Q_CX_XY,
                        &self.setup_params,
                        "prove2.encode.Q_CX",
                    )
                }
            )
        };

        let Q_CY: G1serde = {
            let mut Q_CY_XY = crate::time_block!(
                "poly.combine.prove2.Q_CY",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "Q_CY",
                    dims: vec![self.quotients.q3XY.x_size, self.quotients.q3XY.y_size]
                },],
                {
                    // Original expression:
                    // (rB_Y * (X - 1)) * r_D1 + (rR_Y * (X - 1)) * g_D
                    // and
                    // (rB_Y * K0) * r_D2 + (rR_Y * K0) * g_D.
                    // Factor the common left polynomial in each branch.
                    let rB_Y_r_D1 = mul_by_linear_y(&r_D1, &self.mixer.rB_Y);
                    let rB_Y_r_D2 = mul_by_linear_y(&r_D2, &self.mixer.rB_Y);
                    let d1_comb = &rB_Y_r_D1 + &(&self.mixer.rR_Y * &g_D);
                    let d2_comb = &rB_Y_r_D2 + &(&self.mixer.rR_Y * &g_D);
                    let x_minus_one_d1_comb = mul_by_x_minus_one(&d1_comb);
                    poly_comb!(
                        (ScalarField::one(), self.quotients.q3XY),
                        (self.mixer.rR_Y, lagrange_KL_XY),
                        (kappa0, x_minus_one_d1_comb),
                        (kappa0_sq, &lagrange_K0_XY * &d2_comb)
                    )
                }
            );
            crate::time_block!(
                "prove2.encode.Q_CY",
                "encode_call",
                vec![crate::timing::SizeInfo {
                    label: "Q_CY",
                    dims: vec![self.quotients.q3XY.x_size, self.quotients.q3XY.y_size]
                },],
                {
                    self.sigma.sigma1().encode_poly_timed(
                        &mut Q_CY_XY,
                        &self.setup_params,
                        "prove2.encode.Q_CY",
                    )
                }
            )
        };

        return Proof2 { Q_CX, Q_CY };
    }

    pub fn prove3(&self, chi: ScalarField, zeta: ScalarField) -> Proof3 {
        let m_i = self.setup_params.l_D - self.setup_params.l;
        let s_max = self.setup_params.s_max;
        #[cfg(feature = "timing")]
        let _total = crate::timing::SpanGuard::new(
            "prove3.total",
            "prove",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max],
            }],
        );
        let V_eval: ScalarField = {
            let VXY = poly_comb!(
                (ScalarField::one(), self.witness.vXY),
                (self.mixer.rV_X, self.instance.t_n),
                (self.mixer.rV_Y, self.instance.t_smax)
            );
            VXY.eval(&chi, &zeta)
        };

        let RXY = &self.witness.rXY
            + &(&(&self.mixer.rR_X * &self.instance.t_mi)
                + &(&self.mixer.rR_Y * &self.instance.t_smax));
        let omega_m_i = ntt::get_root_of_unity::<ScalarField>(m_i as u64);
        let omega_s_max = ntt::get_root_of_unity::<ScalarField>(s_max as u64);
        let shifted_x = omega_m_i.inv() * chi;
        let shifted_y = omega_s_max.inv() * zeta;
        // The original path materialized scaleX/scaleY(RXY) before evaluating it.
        // Since scaleX(a, P)(x, y) = P(a*x, y) and scaleY(b, P)(x, y) = P(x, b*y),
        // evaluating RXY at the shifted challenges produces the same three scalars.
        let [R_eval, R_omegaX_eval, R_omegaX_omegaY_eval] = crate::time_block!(
            "poly.eval_three_batch.prove3.R",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "R",
                dims: vec![RXY.x_size, RXY.y_size]
            },],
            {
                RXY.eval_three_batch(&chi, &zeta, &shifted_x, &shifted_y)
                    .expect("ICICLE batched polynomial evaluation failed")
            }
        );
        #[cfg(feature = "testing-mode")]
        {
            let legacy_R_eval = RXY.eval(&chi, &zeta);
            let legacy_R_omegaX_XY = RXY.scale_coeffs_x(&omega_m_i.inv());
            let legacy_R_omegaX_eval = legacy_R_omegaX_XY.eval(&chi, &zeta);
            let legacy_R_omegaX_omegaY_eval = legacy_R_omegaX_XY
                .scale_coeffs_y(&omega_s_max.inv())
                .eval(&chi, &zeta);
            assert_eq!(R_eval, legacy_R_eval);
            assert_eq!(R_omegaX_eval, legacy_R_omegaX_eval);
            assert_eq!(R_omegaX_omegaY_eval, legacy_R_omegaX_omegaY_eval);
        }

        return Proof3 {
            V_eval: FieldSerde(V_eval),
            R_eval: FieldSerde(R_eval),
            R_omegaX_eval: FieldSerde(R_omegaX_eval),
            R_omegaX_omegaY_eval: FieldSerde(R_omegaX_omegaY_eval),
        };
    }

    pub fn prove4(
        &self,
        proof3: &Proof3,
        thetas: &Vec<ScalarField>,
        kappa0: ScalarField,
        chi: ScalarField,
        zeta: ScalarField,
        kappa1: ScalarField,
    ) -> (Proof4, Proof4Test) {
        let m_i = self.setup_params.l_D - self.setup_params.l;
        let s_max = self.setup_params.s_max;
        let _n = self.setup_params.n;
        #[cfg(feature = "timing")]
        let _total = crate::timing::SpanGuard::new(
            "prove4.total",
            "prove",
            vec![
                crate::timing::SizeInfo {
                    label: "n_s_max",
                    dims: vec![_n, s_max],
                },
                crate::timing::SizeInfo {
                    label: "m_i_s_max",
                    dims: vec![m_i, s_max],
                },
            ],
        );
        let t_n_eval = crate::time_block!(
            "poly.eval.prove4.t_n",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "t_n",
                dims: vec![self.instance.t_n.x_size, self.instance.t_n.y_size]
            },],
            { self.instance.t_n.eval(&chi, &ScalarField::one()) }
        );
        let t_smax_eval = crate::time_block!(
            "poly.eval.prove4.t_smax",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "t_smax",
                dims: vec![self.instance.t_smax.x_size, self.instance.t_smax.y_size]
            },],
            { self.instance.t_smax.eval(&ScalarField::one(), &zeta) }
        );
        let small_v_eval = crate::time_block!(
            "poly.eval.prove4.vXY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "vXY",
                dims: vec![self.witness.vXY.x_size, self.witness.vXY.y_size]
            },],
            { self.witness.vXY.eval(&chi, &zeta) }
        );

        let rW_X = DensePolynomialExt::from_coeffs(
            HostSlice::from_slice(&self.mixer.rW_X),
            self.mixer.rW_X.len(),
            1,
        );
        let rW_Y = DensePolynomialExt::from_coeffs(
            HostSlice::from_slice(&self.mixer.rW_Y),
            1,
            self.mixer.rW_Y.len(),
        );
        let W_zk = self.cache.w_zk.clone().unwrap_or_else(|| {
            // Fallback for non-standard call order. Original cached expression:
            // W_zk = rW_X * t_n + rW_Y * t_smax.
            let rW_X_t_n = low_degree_x_times_vanishing(&self.mixer.rW_X, self.setup_params.n);
            let rW_Y_t_smax =
                low_degree_y_times_vanishing(&self.mixer.rW_Y, self.setup_params.s_max);
            &rW_X_t_n + &rW_Y_t_smax
        });

        let VXY = crate::time_block!(
            "poly.combine.prove4.V",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "vXY",
                dims: vec![self.witness.vXY.x_size, self.witness.vXY.y_size]
            },],
            {
                poly_comb!(
                    (ScalarField::one(), self.witness.vXY),
                    (self.mixer.rV_X, self.instance.t_n),
                    (self.mixer.rV_Y, self.instance.t_smax)
                )
            }
        );
        let pA_constant_correction = kappa1 * proof3.V_eval.0;

        let pA_XY = crate::time_block!(
            "poly.combine.prove4.Pi_A",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "uXY",
                dims: vec![self.witness.uXY.x_size, self.witness.uXY.y_size]
            },],
            {
                poly_comb!(
                    // for KZG of V
                    (kappa1, VXY),
                    // for Arithmetic constraints
                    (small_v_eval, self.witness.uXY),
                    (ScalarField::zero() - ScalarField::one(), self.witness.wXY),
                    (
                        (ScalarField::zero() - ScalarField::one()) * t_n_eval,
                        self.quotients.q0XY
                    ),
                    (
                        (ScalarField::zero() - ScalarField::one()) * t_smax_eval,
                        self.quotients.q1XY
                    ),
                    // for zero-knowledge
                    (small_v_eval * self.mixer.rU_X, self.instance.t_n),
                    (small_v_eval * self.mixer.rU_Y, self.instance.t_smax),
                    (
                        ScalarField::zero()
                            - ((self.mixer.rU_X * t_n_eval) + (self.mixer.rU_Y * t_smax_eval)),
                        self.witness.vXY
                    ),
                    // Original expression:
                    // rW_X * (t_n_eval - t_n) + rW_Y * (t_smax_eval - t_smax).
                    // Reuse W_zk = rW_X * t_n + rW_Y * t_smax.
                    (t_n_eval, rW_X),
                    (t_smax_eval, rW_Y),
                    (ScalarField::zero() - ScalarField::one(), W_zk)
                )
            }
        );
        #[cfg(feature = "testing-mode")]
        let (Pi_AX, Pi_AY) = {
            let (mut Pi_AX_XY, mut Pi_AY_XY, rem) = crate::time_block!(
                "poly.div_by_ruffini.prove4.Pi_A_test",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "pA_XY",
                    dims: vec![self.witness.uXY.x_size, self.witness.uXY.y_size]
                },],
                {
                    div_by_ruffini_with_constant_correction(
                        &pA_XY,
                        &chi,
                        &zeta,
                        &pA_constant_correction,
                    )
                }
            );
            assert_eq!(rem, ScalarField::zero());
            (
                self.sigma
                    .sigma1()
                    .encode_poly(&mut Pi_AX_XY, &self.setup_params),
                self.sigma
                    .sigma1()
                    .encode_poly(&mut Pi_AY_XY, &self.setup_params),
            )
        };
        #[cfg(not(feature = "testing-mode"))]
        let (Pi_AX, Pi_AY) = (G1serde::zero(), G1serde::zero());

        let omega_m_i = ntt::get_root_of_unity::<ScalarField>(m_i as u64);
        let omega_s_max = ntt::get_root_of_unity::<ScalarField>(s_max as u64);
        let RXY_t_mi = crate::time_block!(
            "poly.mul.prove4.RXY_t_mi",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "t_mi",
                dims: vec![self.instance.t_mi.x_size, self.instance.t_mi.y_size]
            },],
            { &self.mixer.rR_X * &self.instance.t_mi }
        );
        let RXY_t_smax = crate::time_block!(
            "poly.mul.prove4.RXY_t_smax",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "t_smax",
                dims: vec![self.instance.t_smax.x_size, self.instance.t_smax.y_size]
            },],
            { &self.mixer.rR_Y * &self.instance.t_smax }
        );
        let RXY_terms = crate::time_block!(
            "poly.add.prove4.RXY_terms",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max]
            },],
            { &RXY_t_mi + &RXY_t_smax }
        );
        let RXY = crate::time_block!(
            "poly.add.prove4.RXY",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "R",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            { &self.witness.rXY + &RXY_terms }
        );
        let mn_x_point = omega_m_i.inv() * chi;
        let mn_y_points = [zeta, omega_s_max.inv() * zeta];
        // The original M and N openings split and committed the same X quotient
        // independently. Their scalar subtractions and Y points affect only the
        // X remainder and later Y split, so one X split and commitment serves both.
        let (mut MN_X_XY, y_quotients, mn_remainders) = crate::time_block!(
            "poly.div_by_ruffini_shared_x.prove4.M_N",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "R",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            { RXY.div_by_ruffini_shared_x(&mn_x_point, &mn_y_points) }
        );
        #[cfg(feature = "testing-mode")]
        {
            assert_eq!(mn_remainders[0], proof3.R_omegaX_eval.0);
            assert_eq!(mn_remainders[1], proof3.R_omegaX_omegaY_eval.0);
        }
        #[cfg(not(feature = "testing-mode"))]
        let _ = mn_remainders;

        let mut y_quotients = y_quotients.into_iter();
        let mut M_Y_XY = y_quotients.next().unwrap();
        let mut N_Y_XY = y_quotients.next().unwrap();
        assert!(y_quotients.next().is_none());

        let MN_X = crate::time_block!(
            "prove4.encode.M_N_X",
            "encode_call",
            vec![crate::timing::SizeInfo {
                label: "M_N_X",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            {
                self.sigma.sigma1().encode_poly_timed(
                    &mut MN_X_XY,
                    &self.setup_params,
                    "prove4.encode.M_N_X",
                )
            }
        );
        let M_X = MN_X;
        let N_X = MN_X;
        let M_Y = crate::time_block!(
            "prove4.encode.M_Y",
            "encode_call",
            vec![crate::timing::SizeInfo {
                label: "M_Y",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            {
                self.sigma.sigma1().encode_poly_timed(
                    &mut M_Y_XY,
                    &self.setup_params,
                    "prove4.encode.M_Y",
                )
            }
        );
        let N_Y = crate::time_block!(
            "prove4.encode.N_Y",
            "encode_call",
            vec![crate::timing::SizeInfo {
                label: "N_Y",
                dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
            },],
            {
                self.sigma.sigma1().encode_poly_timed(
                    &mut N_Y_XY,
                    &self.setup_params,
                    "prove4.encode.N_Y",
                )
            }
        );

        #[cfg(feature = "testing-mode")]
        {
            let M_numerator = &RXY - &proof3.R_omegaX_eval.0;
            let N_numerator = &RXY - &proof3.R_omegaX_omegaY_eval.0;
            let (mut legacy_M_X_XY, mut legacy_M_Y_XY, M_rem) =
                M_numerator.div_by_ruffini(&mn_x_point, &mn_y_points[0]);
            let (mut legacy_N_X_XY, mut legacy_N_Y_XY, N_rem) =
                N_numerator.div_by_ruffini(&mn_x_point, &mn_y_points[1]);
            assert_eq!(M_rem, ScalarField::zero());
            assert_eq!(N_rem, ScalarField::zero());

            let x_e = ScalarCfg::generate_random(1)[0];
            let y_e = ScalarCfg::generate_random(1)[0];
            assert_eq!(
                M_numerator.eval(&x_e, &y_e),
                legacy_M_X_XY.eval(&x_e, &y_e) * (x_e - mn_x_point)
                    + legacy_M_Y_XY.eval(&x_e, &y_e) * (y_e - mn_y_points[0])
            );
            assert_eq!(
                N_numerator.eval(&x_e, &y_e),
                legacy_N_X_XY.eval(&x_e, &y_e) * (x_e - mn_x_point)
                    + legacy_N_Y_XY.eval(&x_e, &y_e) * (y_e - mn_y_points[1])
            );

            assert_eq!(
                M_X,
                self.sigma
                    .sigma1()
                    .encode_poly(&mut legacy_M_X_XY, &self.setup_params)
            );
            assert_eq!(
                M_Y,
                self.sigma
                    .sigma1()
                    .encode_poly(&mut legacy_M_Y_XY, &self.setup_params)
            );
            assert_eq!(
                N_X,
                self.sigma
                    .sigma1()
                    .encode_poly(&mut legacy_N_X_XY, &self.setup_params)
            );
            assert_eq!(
                N_Y,
                self.sigma
                    .sigma1()
                    .encode_poly(&mut legacy_N_Y_XY, &self.setup_params)
            );
        }

        let (LHS_for_copy, Pi_CX, Pi_CY, pi_c_constant_correction) = {
            let r_omegaX = crate::time_block!(
                "poly.scale_coeffs.prove4.r_omegaX",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "R",
                    dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
                },],
                { self.witness.rXY.scale_coeffs_x(&omega_m_i.inv()) }
            );
            let r_omegaX_omegaY = crate::time_block!(
                "poly.scale_coeffs.prove4.r_omegaX_omegaY",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "R_omegaX",
                    dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
                },],
                { r_omegaX.scale_coeffs_y(&omega_s_max.inv()) }
            );
            let mut X_mono_coef = vec![ScalarField::zero(); 2];
            X_mono_coef[1] = ScalarField::one();
            let X_mono = DensePolynomialExt::from_coeffs(HostSlice::from_slice(&X_mono_coef), 2, 1);
            drop(X_mono_coef);
            let (fXY, gXY) = {
                let mut Y_mono_coef = vec![ScalarField::zero(); 2];
                Y_mono_coef[1] = ScalarField::one();
                let Y_mono =
                    DensePolynomialExt::from_coeffs(HostSlice::from_slice(&Y_mono_coef), 1, 2);
                let fXY = crate::time_block!(
                    "poly.combine.prove4.fXY",
                    "poly",
                    vec![crate::timing::SizeInfo {
                        label: "bXY",
                        dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                    },],
                    {
                        &(&(&self.witness.bXY + &(&thetas[0] * &self.instance.s0XY))
                            + &(&thetas[1] * &self.instance.s1XY))
                            + &thetas[2]
                    }
                );
                let gXY = crate::time_block!(
                    "poly.combine.prove4.gXY",
                    "poly",
                    vec![crate::timing::SizeInfo {
                        label: "bXY",
                        dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                    },],
                    {
                        &(&(&self.witness.bXY + &(&thetas[0] * &X_mono)) + &(&thetas[1] * &Y_mono))
                            + &thetas[2]
                    }
                );
                (fXY, gXY)
            };
            let t_mi_eval = chi.pow(m_i) - ScalarField::one();
            let t_s_max_eval = zeta.pow(s_max) - ScalarField::one();
            let lagrange_K0_XY = crate::time_block!(
                "poly.from_rou_evals.prove4.K0",
                "poly",
                vec![
                    crate::timing::SizeInfo {
                        label: "k0_evals",
                        dims: vec![m_i]
                    },
                    crate::timing::SizeInfo {
                        label: "grid",
                        dims: vec![m_i, 1]
                    },
                ],
                {
                    let mut k0_evals = vec![ScalarField::zero(); m_i];
                    k0_evals[0] = ScalarField::one();
                    DensePolynomialExt::from_rou_evals(
                        HostSlice::from_slice(&k0_evals),
                        m_i,
                        1,
                        None,
                        None,
                    )
                }
            );
            let lagrange_K0_eval = crate::time_block!(
                "poly.eval.prove4.K0",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "K0",
                    dims: vec![m_i, 1]
                },],
                { lagrange_K0_XY.eval(&chi, &zeta) }
            );

            let small_r_eval = crate::time_block!(
                "poly.eval.prove4.R",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "R",
                    dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
                },],
                { self.witness.rXY.eval(&chi, &zeta) }
            );
            let small_r_omegaX_eval = crate::time_block!(
                "poly.eval.prove4.R_omegaX",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "R_omegaX",
                    dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
                },],
                { r_omegaX.eval(&chi, &zeta) }
            );
            let small_r_omegaX_omegaY_eval = crate::time_block!(
                "poly.eval.prove4.R_omegaX_omegaY",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "R_omegaX_omegaY",
                    dims: vec![self.witness.rXY.x_size, self.witness.rXY.y_size]
                },],
                { r_omegaX_omegaY.eval(&chi, &zeta) }
            );
            let lagrange_KL_XY = self.cache.lagrange_kl_xy.clone().unwrap_or_else(|| {
                // Fallback for non-standard call order. Original expression:
                // lagrange_KL_XY = lagrange_K_XY * lagrange_L_XY.
                let lagrange_K_XY = crate::time_block!(
                    "poly.from_rou_evals.prove4.K",
                    "poly",
                    vec![
                        crate::timing::SizeInfo {
                            label: "k_evals",
                            dims: vec![m_i]
                        },
                        crate::timing::SizeInfo {
                            label: "grid",
                            dims: vec![m_i, 1]
                        },
                    ],
                    {
                        let mut k_evals = vec![ScalarField::zero(); m_i];
                        k_evals[m_i - 1] = ScalarField::one();
                        DensePolynomialExt::from_rou_evals(
                            HostSlice::from_slice(&k_evals),
                            m_i,
                            1,
                            None,
                            None,
                        )
                    }
                );
                let lagrange_L_XY = crate::time_block!(
                    "poly.from_rou_evals.prove4.L",
                    "poly",
                    vec![
                        crate::timing::SizeInfo {
                            label: "l_evals",
                            dims: vec![s_max]
                        },
                        crate::timing::SizeInfo {
                            label: "grid",
                            dims: vec![1, s_max]
                        },
                    ],
                    {
                        let mut l_evals = vec![ScalarField::zero(); s_max];
                        l_evals[s_max - 1] = ScalarField::one();
                        DensePolynomialExt::from_rou_evals(
                            HostSlice::from_slice(&l_evals),
                            1,
                            s_max,
                            None,
                            None,
                        )
                    }
                );
                crate::time_block!(
                    "poly.mul.prove4.KL",
                    "poly",
                    vec![
                        crate::timing::SizeInfo {
                            label: "K",
                            dims: vec![m_i, 1]
                        },
                        crate::timing::SizeInfo {
                            label: "L",
                            dims: vec![1, s_max]
                        },
                    ],
                    { &lagrange_K_XY * &lagrange_L_XY }
                )
            });
            let term5 = crate::time_block!(
                "poly.combine.prove4.term5",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "gXY",
                    dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                },],
                {
                    poly_comb!(
                        (small_r_eval, gXY),
                        (ScalarField::zero() - small_r_omegaX_eval, fXY)
                    )
                }
            );
            let term6 = crate::time_block!(
                "poly.combine.prove4.term6",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "gXY",
                    dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                },],
                {
                    poly_comb!(
                        (small_r_eval, gXY),
                        (ScalarField::zero() - small_r_omegaX_omegaY_eval, fXY)
                    )
                }
            );
            let pC_XY = crate::time_block!(
                "poly.combine.prove4.pC",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "m_i_s_max",
                    dims: vec![m_i, s_max]
                },],
                {
                    poly_comb!(
                        (small_r_eval - ScalarField::one(), lagrange_KL_XY),
                        (kappa0 * (chi - ScalarField::one()), term5),
                        (kappa0.pow(2) * lagrange_K0_eval, term6),
                        (ScalarField::zero() - t_mi_eval, self.quotients.q2XY),
                        (ScalarField::zero() - t_s_max_eval, self.quotients.q3XY)
                    )
                }
            );
            let (LHS_zk1, LHS_zk2) = {
                let r_D1 = &self.witness.rXY - &r_omegaX;
                let r_D2 = &self.witness.rXY - &r_omegaX_omegaY;
                // The original path evaluated the materialized r_D1 = R - R_omegaX
                // and r_D2 = R - R_omegaX_omegaY polynomials. Evaluation is linear,
                // so their values are the corresponding differences of known values.
                let (r_D1_eval, r_D2_eval) = crate::time_block!(
                    "poly.eval_derived.prove4.r_D1_r_D2",
                    "poly",
                    vec![crate::timing::SizeInfo {
                        label: "evaluations",
                        dims: vec![2]
                    },],
                    {
                        (
                            small_r_eval - small_r_omegaX_eval,
                            small_r_eval - small_r_omegaX_omegaY_eval,
                        )
                    }
                );
                #[cfg(feature = "testing-mode")]
                {
                    assert_eq!(r_D1_eval, r_D1.eval(&chi, &zeta));
                    assert_eq!(r_D2_eval, r_D2.eval(&chi, &zeta));
                }
                let term_B_zk = self.cache.term_b_zk.clone().unwrap_or_else(|| {
                    crate::time_block!(
                        "poly.combine.prove4.term_B_zk",
                        "poly",
                        vec![crate::timing::SizeInfo {
                            label: "rB",
                            dims: vec![m_i, s_max]
                        },],
                        {
                            // Fallback for non-standard call order. Original expression:
                            // term_B_zk = rB_X * t_mi + rB_Y * t_smax.
                            let rB_X_t_mi = low_degree_x_times_vanishing(&self.mixer.rB_X, m_i);
                            let rB_Y_t_smax = low_degree_y_times_vanishing(&self.mixer.rB_Y, s_max);
                            &rB_X_t_mi + &rB_Y_t_smax
                        }
                    )
                });
                let g_minus_f = crate::time_block!(
                    "poly.add.prove4.g_minus_f",
                    "poly",
                    vec![crate::timing::SizeInfo {
                        label: "gXY",
                        dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                    },],
                    { &gXY - &fXY }
                );
                let term10_scale = self.mixer.rR_X * t_mi_eval + self.mixer.rR_Y * t_s_max_eval;
                let term10 = crate::time_block!(
                    "poly.mul.prove4.term10",
                    "poly",
                    vec![crate::timing::SizeInfo {
                        label: "gXY",
                        dims: vec![self.witness.bXY.x_size, self.witness.bXY.y_size]
                    },],
                    { &term10_scale * &g_minus_f }
                );
                (
                    crate::time_block!(
                        "poly.combine.prove4.LHS_zk1",
                        "poly",
                        vec![crate::timing::SizeInfo {
                            label: "m_i_s_max",
                            dims: vec![m_i, s_max]
                        },],
                        {
                            // Original expression:
                            // (1 - X) * (r_D1 * term9) + (chi - X) * term10.
                            // Use chi - X = (1 - X) + (chi - 1).
                            let r_D1_term9 = mul_by_term9(
                                &r_D1,
                                &self.mixer.rB_X,
                                &self.mixer.rB_Y,
                                &t_mi_eval,
                                &t_s_max_eval,
                            );
                            let r_d1_term9_plus_term10 = &r_D1_term9 + &term10;
                            let one_minus_x_times = mul_by_one_minus_x(&r_d1_term9_plus_term10);
                            poly_comb!(
                                ((chi - ScalarField::one()) * r_D1_eval, term_B_zk),
                                (ScalarField::one(), one_minus_x_times),
                                (chi - ScalarField::one(), term10)
                            )
                        }
                    ),
                    crate::time_block!(
                        "poly.combine.prove4.LHS_zk2",
                        "poly",
                        vec![crate::timing::SizeInfo {
                            label: "m_i_s_max",
                            dims: vec![m_i, s_max]
                        },],
                        {
                            // Original expression:
                            // (K0 * r_D2) * (-term9) + term10 * (K0_eval - K0).
                            // Factor K0 after expanding the scalar part.
                            let r_D2_term9 = mul_by_term9(
                                &r_D2,
                                &self.mixer.rB_X,
                                &self.mixer.rB_Y,
                                &t_mi_eval,
                                &t_s_max_eval,
                            );
                            let r_d2_term9_plus_term10 = &r_D2_term9 + &term10;
                            poly_comb!(
                                (lagrange_K0_eval * r_D2_eval, term_B_zk),
                                (lagrange_K0_eval, term10),
                                (
                                    ScalarField::zero() - ScalarField::one(),
                                    &lagrange_K0_XY * &r_d2_term9_plus_term10
                                )
                            )
                        }
                    ),
                )
            };
            let pi_c_constant_correction = kappa1.pow(3) * proof3.R_eval.0;
            let LHS_for_copy = crate::time_block!(
                "poly.combine.prove4.LHS_for_copy",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "m_i_s_max",
                    dims: vec![m_i, s_max]
                },],
                {
                    poly_comb!(
                        (kappa1.pow(2), pC_XY),
                        (kappa1.pow(2) * kappa0, LHS_zk1),
                        (kappa1.pow(2) * kappa0.pow(2), LHS_zk2),
                        (kappa1.pow(3), RXY)
                    )
                }
            );

            #[cfg(feature = "testing-mode")]
            let (Pi_CX, Pi_CY) = {
                let (mut Pi_CX_XY, mut Pi_CY_XY, rem) = crate::time_block!(
                    "poly.div_by_ruffini.prove4.Pi_C_test",
                    "poly",
                    vec![crate::timing::SizeInfo {
                        label: "LHS_for_copy",
                        dims: vec![m_i, s_max]
                    },],
                    {
                        div_by_ruffini_with_constant_correction(
                            &LHS_for_copy,
                            &chi,
                            &zeta,
                            &pi_c_constant_correction,
                        )
                    }
                );
                assert_eq!(rem, ScalarField::zero());
                let x_e = ScalarCfg::generate_random(1)[0];
                let y_e = ScalarCfg::generate_random(1)[0];
                let lhs = LHS_for_copy.eval(&x_e, &y_e);
                let rhs = Pi_CX_XY.eval(&x_e, &y_e) * (x_e - chi)
                    + Pi_CY_XY.eval(&x_e, &y_e) * (y_e - zeta)
                    + pi_c_constant_correction;
                assert_eq!(lhs, rhs);
                (
                    self.sigma
                        .sigma1()
                        .encode_poly(&mut Pi_CX_XY, &self.setup_params),
                    self.sigma
                        .sigma1()
                        .encode_poly(&mut Pi_CY_XY, &self.setup_params),
                )
            };
            #[cfg(not(feature = "testing-mode"))]
            let (Pi_CX, Pi_CY) = (G1serde::zero(), G1serde::zero());

            (LHS_for_copy, Pi_CX, Pi_CY, pi_c_constant_correction)
        };
        #[cfg(feature = "testing-mode")]
        {
            println!("Checked: B(X,Y) and R(X,Y) with zero-knowledge satisfy the copy constraints.")
        }

        drop(RXY);
        let A_eval = crate::time_block!(
            "poly.eval.prove4.A_free",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "a_free_X",
                dims: vec![self.instance.a_free_X.x_size, self.instance.a_free_X.y_size]
            },],
            { self.instance.a_free_X.eval(&chi, &zeta) }
        );
        #[cfg(feature = "testing-mode")]
        let Pi_B = {
            let (mut pi_B_XY, _, rem) = crate::time_block!(
                "poly.div_by_ruffini.prove4.Pi_B_test",
                "poly",
                vec![crate::timing::SizeInfo {
                    label: "a_free_X",
                    dims: vec![self.instance.a_free_X.x_size, self.instance.a_free_X.y_size]
                },],
                {
                    div_by_ruffini_with_constant_correction(
                        &self.instance.a_free_X,
                        &chi,
                        &zeta,
                        &A_eval,
                    )
                }
            );
            assert_eq!(rem, ScalarField::zero());
            self.sigma
                .sigma1()
                .encode_poly(&mut pi_B_XY, &self.setup_params)
                * kappa1.pow(4)
        };
        #[cfg(not(feature = "testing-mode"))]
        let Pi_B = G1serde::zero();

        // The original path opened Pi_A, Pi_C, and kappa1^4*Pi_B separately and
        // combined their commitments. Ruffini splitting and KZG commitment are
        // linear, so opening their weighted numerator sum yields the same Pi_X/Pi_Y.
        let combined_Pi_numerator = crate::time_block!(
            "poly.combine.prove4.Pi_combined_numerator",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max]
            },],
            {
                poly_comb!(
                    (ScalarField::one(), pA_XY),
                    (ScalarField::one(), LHS_for_copy),
                    (kappa1.pow(4), self.instance.a_free_X)
                )
            }
        );
        let combined_pi_constant_correction =
            pA_constant_correction + pi_c_constant_correction + kappa1.pow(4) * A_eval;
        let (mut Pi_X_XY, mut Pi_Y_XY, combined_rem) = crate::time_block!(
            "poly.div_by_ruffini.prove4.Pi_combined",
            "poly",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max]
            },],
            {
                div_by_ruffini_with_constant_correction(
                    &combined_Pi_numerator,
                    &chi,
                    &zeta,
                    &combined_pi_constant_correction,
                )
            }
        );
        #[cfg(feature = "testing-mode")]
        {
            let legacy_combined_pi_numerator =
                &combined_Pi_numerator - &combined_pi_constant_correction;
            let (legacy_pi_x, legacy_pi_y, legacy_rem) =
                legacy_combined_pi_numerator.div_by_ruffini(&chi, &zeta);
            assert_same_polynomial_exact(&Pi_X_XY, &legacy_pi_x);
            assert_same_polynomial_exact(&Pi_Y_XY, &legacy_pi_y);
            assert_eq!(combined_rem, legacy_rem);
        }
        #[cfg(feature = "testing-mode")]
        assert_eq!(combined_rem, ScalarField::zero());
        #[cfg(not(feature = "testing-mode"))]
        let _ = combined_rem;
        let Pi_X = crate::time_block!(
            "prove4.encode.Pi_X",
            "encode_call",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max]
            },],
            {
                self.sigma.sigma1().encode_poly_timed(
                    &mut Pi_X_XY,
                    &self.setup_params,
                    "prove4.encode.Pi_X",
                )
            }
        );
        let Pi_Y = crate::time_block!(
            "prove4.encode.Pi_Y",
            "encode_call",
            vec![crate::timing::SizeInfo {
                label: "m_i_s_max",
                dims: vec![m_i, s_max]
            },],
            {
                self.sigma.sigma1().encode_poly_timed(
                    &mut Pi_Y_XY,
                    &self.setup_params,
                    "prove4.encode.Pi_Y",
                )
            }
        );
        #[cfg(feature = "testing-mode")]
        {
            assert_eq!(Pi_X, Pi_AX + Pi_CX + Pi_B);
            assert_eq!(Pi_Y, Pi_AY + Pi_CY);
        }
        return (
            Proof4 {
                Pi_X,
                Pi_Y,
                M_X,
                M_Y,
                N_X,
                N_Y,
            },
            Proof4Test {
                Pi_CX,
                Pi_CY,
                Pi_AX,
                Pi_AY,
                Pi_B,
                M_X,
                M_Y,
                N_X,
                N_Y,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use libs::utils::check_device;

    #[test]
    fn constant_corrected_ruffini_matches_subtracted_numerator() {
        check_device();
        let coefficients = (1..=16).map(ScalarField::from_u32).collect::<Vec<_>>();
        let polynomial =
            DensePolynomialExt::from_coeffs(HostSlice::from_slice(&coefficients), 4, 4);
        let corrections = [
            ScalarField::zero(),
            ScalarField::one(),
            ScalarField::zero() - ScalarField::one(),
            ScalarField::from_u32(19),
        ];
        let split_points = [
            (ScalarField::zero(), ScalarField::zero()),
            (ScalarField::one(), ScalarField::from_u32(3)),
            (ScalarField::from_u32(11), ScalarField::from_u32(13)),
        ];

        for correction in corrections {
            let subtracted = &polynomial - &correction;
            for (x, y) in split_points {
                let (expected_x, expected_y, expected_remainder) =
                    subtracted.div_by_ruffini(&x, &y);
                let (actual_x, actual_y, actual_remainder) =
                    div_by_ruffini_with_constant_correction(&polynomial, &x, &y, &correction);

                assert_same_polynomial_exact(&actual_x, &expected_x);
                assert_same_polynomial_exact(&actual_y, &expected_y);
                assert_eq!(actual_remainder, expected_remainder);
            }
        }
    }
}
