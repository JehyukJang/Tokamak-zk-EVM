// Group and Sigma identifiers preserve the proving protocol's mathematical notation.
#![allow(non_snake_case)]

use crate::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use crate::commitments::{
    from_coef_vec_to_g1serde_mat, from_coef_vec_to_g1serde_vec, scaled_outer_product_1d,
    scaled_outer_product_2d,
};
use crate::field_structures::{FieldSerde, Tau};
use crate::frontend_artifacts::public_wire_layout::{GlobalWire, PublicWireLayout};
use crate::frontend_artifacts::{HexString, PlacementVariables, SetupParams, SubcircuitInfo};
use crate::vector_operations::*;
use ark_bls12_381::{Bls12_381, G1Affine as ArkG1Affine, G2Affine as ArkG2Affine};
use ark_ec::pairing::Pairing;
use ark_ec::pairing::PairingOutput;
use ark_ff::Field;
use icicle_bls12_381::curve::{G1Affine, G1Projective, G2Affine, ScalarField};
use icicle_core::msm::{self, MSMConfig};
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::memory::HostSlice;

use serde::{Deserialize, Serialize};
use std::ops::{Add, Mul, Sub};

macro_rules! extend_monomial_vec {
    ($mono_vec: expr, $target_size: expr) => {{
        let mut res = vec![ScalarField::zero(); $target_size].into_boxed_slice();
        extend_monomial_vec($mono_vec, &mut res);
        res
    }};
}

macro_rules! type_scaled_outer_product_2d {
    ($col_vec: expr, $row_vec: expr, $g1_gen: expr, $scaler: expr) => {{
        let row_size = $col_vec.len();
        let col_size = $row_vec.len();
        let mut res =
            vec![vec![G1serde::zero(); col_size].into_boxed_slice(); row_size].into_boxed_slice();
        scaled_outer_product_2d($col_vec, $row_vec, $g1_gen, $scaler, &mut res);
        res
    }};
}

macro_rules! type_scaled_outer_product_1d {
    ($col_vec: expr, $row_vec: expr, $g1_gen: expr, $scaler: expr) => {{
        let row_size = $col_vec.len();
        let col_size = $row_vec.len();
        let mut res = vec![G1serde::zero(); row_size * col_size].into_boxed_slice();
        scaled_outer_product_1d($col_vec, $row_vec, $g1_gen, $scaler, &mut res);
        res
    }};
}

#[macro_export]
macro_rules! type_scaled_monomials_1d {
    ( $cached_x_vec: expr, $cached_y_vec: expr, $x_size: expr, $y_size: expr, $scaler: expr, $g1_gen: expr ) => {{
        let col_vec = extend_monomial_vec!($cached_x_vec, $x_size);
        let row_vec = extend_monomial_vec!($cached_y_vec, $y_size);
        let res = type_scaled_outer_product_1d!(&col_vec, &row_vec, $g1_gen, $scaler);
        res
    }};
}

macro_rules! impl_encode_poly {
    ($t:ty) => {
        impl $t {
            pub fn encode_poly(
                &self,
                poly: &mut DensePolynomialExt,
                params: &SetupParams,
            ) -> G1serde {
                poly.optimize_size();
                let x_size = poly.x_size;
                let y_size = poly.y_size;
                let rs_x_size = std::cmp::max(2 * params.n, 2 * (params.l_D - params.l));
                let rs_y_size = params.s_max * 2;
                let target_x_size = (poly.x_degree + 1) as usize;
                let target_y_size = (poly.y_degree + 1) as usize;
                if target_x_size > rs_x_size || target_y_size > rs_y_size {
                    panic!("Insufficient length of sigma.sigma_1.xy_powers");
                }
                if target_x_size * target_y_size == 0 {
                    return G1serde::zero();
                }
                let poly_coeffs_vec_compact = {
                    let mut poly_coeffs_vec = vec![ScalarField::zero(); x_size * y_size];
                    let poly_coeffs = HostSlice::from_mut_slice(&mut poly_coeffs_vec);
                    poly.copy_coeffs(0, poly_coeffs);
                    resize(
                        &poly_coeffs_vec,
                        x_size,
                        y_size,
                        target_x_size,
                        target_y_size,
                        ScalarField::zero(),
                    )
                };

                let rs_unpacked: Vec<G1Affine> = {
                    let rs_resized = resize(
                        &self.xy_powers,
                        rs_x_size,
                        rs_y_size,
                        target_x_size,
                        target_y_size,
                        G1serde::zero(),
                    );
                    rs_resized.iter().map(|x| x.0).collect()
                };

                let mut msm_res = vec![G1Projective::zero(); 1];

                msm::msm(
                    HostSlice::from_slice(&poly_coeffs_vec_compact),
                    HostSlice::from_slice(&rs_unpacked),
                    &MSMConfig::default(),
                    HostSlice::from_mut_slice(&mut msm_res),
                )
                .unwrap();
                G1serde(G1Affine::from(msm_res[0]))
            }
        }
    };
}

pub fn pairing(lhs: &[G1serde], rhs: &[G2serde]) -> PairingOutput<Bls12_381> {
    let lhs_ark: Vec<ArkG1Affine> = lhs.iter().map(|x| icicle_g1_affine_to_ark(&x.0)).collect();
    let rhs_ark: Vec<ArkG2Affine> = rhs.iter().map(|x| icicle_g2_affine_to_ark(&x.0)).collect();
    Bls12_381::multi_pairing(lhs_ark, rhs_ark)
}

pub(crate) fn msm_g1_bases(scalars: &[ScalarField], bases: &[G1Affine]) -> G1serde {
    if scalars.len() != bases.len() {
        panic!("msm input length mismatch");
    }
    if scalars.is_empty() {
        return G1serde::zero();
    }
    let mut msm_res = vec![G1Projective::zero(); 1];
    msm::msm(
        HostSlice::from_slice(scalars),
        HostSlice::from_slice(bases),
        &MSMConfig::default(),
        HostSlice::from_mut_slice(&mut msm_res),
    )
    .unwrap();
    G1serde(G1Affine::from(msm_res[0]))
}

pub(crate) fn encode_o_pub_fix_common<F>(
    a_pub_function: &[HexString],
    setup_params: &SetupParams,
    gamma_inv_o_inst_len: usize,
    mut gamma_at: F,
) -> G1serde
where
    F: FnMut(usize) -> G1Affine,
{
    let m_function = setup_params.l - setup_params.l_free;
    if m_function == 0 {
        return G1serde::zero();
    }
    if a_pub_function.len() != m_function {
        panic!(
            "a_pub_function length mismatch: expected m_function={}, got a_pub_function.len()={}",
            m_function,
            a_pub_function.len()
        );
    }
    if gamma_inv_o_inst_len < m_function {
        panic!(
            "gamma_inv_o_inst length is smaller than m_function: gamma_inv_o_inst_len={}, m_function={}",
            gamma_inv_o_inst_len,
            m_function
        );
    }

    let start = gamma_inv_o_inst_len - m_function;
    let scalars_field = a_pub_function
        .iter()
        .map(|val| ScalarField::from_hex(val))
        .collect::<Vec<_>>();
    let bases = (0..m_function)
        .map(|i| gamma_at(start + i))
        .collect::<Vec<_>>();
    msm_g1_bases(&scalars_field, &bases)
}

pub(crate) fn encode_o_pub_free_common<F>(
    placement_variables: &[PlacementVariables],
    public_wire_layout: &PublicWireLayout,
    mut gamma_at: F,
) -> G1serde
where
    F: FnMut(usize) -> G1Affine,
{
    let mut aligned_rs = Vec::with_capacity(public_wire_layout.free_public_len());
    let mut aligned_wtns = Vec::with_capacity(public_wire_layout.free_public_len());
    for global_wire_index in 0..public_wire_layout.free_public_len() {
        let Some(GlobalWire::Mapped {
            subcircuit_id,
            local_wire_index,
        }) = public_wire_layout.source_for_public_wire(global_wire_index)
        else {
            continue;
        };
        let placement_phase = public_wire_layout
            .placement_phase_for_subcircuit(subcircuit_id)
            .unwrap_or_else(|| panic!("public buffer {subcircuit_id} has no placement phase"));
        let placement = placement_variables.get(placement_phase).unwrap_or_else(|| {
            panic!(
                "public buffer {subcircuit_id} has no runtime placement at phase {placement_phase}"
            )
        });
        if placement.subcircuitId != subcircuit_id {
            panic!(
                "runtime placement phase {placement_phase} has subcircuit {}, expected public buffer {subcircuit_id}",
                placement.subcircuitId
            );
        }
        aligned_wtns.push(ScalarField::from_hex(
            &placement.variables[local_wire_index],
        ));
        aligned_rs.push(gamma_at(global_wire_index));
    }
    msm_g1_bases(&aligned_wtns, &aligned_rs)
}

pub(crate) fn count_statement_nvar(
    global_wire_index_offset: usize,
    global_wire_index_end: usize,
    placement_variables: &[PlacementVariables],
    subcircuit_infos: &[SubcircuitInfo],
) -> usize {
    let mut variable_count = 0;
    for placement in placement_variables {
        let subcircuit_info = &subcircuit_infos[placement.subcircuitId];
        for global_wire_index in subcircuit_info.flattenMap.iter().copied() {
            if global_wire_index >= global_wire_index_offset
                && global_wire_index < global_wire_index_end
            {
                variable_count += 1;
            }
        }
    }
    variable_count
}

pub(crate) fn encode_statement_common<F>(
    global_wire_index_offset: usize,
    global_wire_index_end: usize,
    nVar: usize,
    placement_variables: &[PlacementVariables],
    subcircuit_infos: &[SubcircuitInfo],
    mut base_at: F,
) -> G1serde
where
    F: FnMut(usize, usize) -> G1Affine,
{
    let mut aligned_rs = Vec::with_capacity(nVar);
    let mut aligned_variable = Vec::with_capacity(nVar);
    for (i, placement) in placement_variables.iter().enumerate() {
        let variables = &placement.variables;
        let subcircuit_info = &subcircuit_infos[placement.subcircuitId];
        let flatten_map = &subcircuit_info.flattenMap;
        for j in 0..subcircuit_info.Nwires {
            if flatten_map[j] >= global_wire_index_offset && flatten_map[j] < global_wire_index_end
            {
                let global_idx = flatten_map[j] - global_wire_index_offset;
                aligned_variable.push(ScalarField::from_hex(&variables[j]));
                aligned_rs.push(base_at(global_idx, i));
            }
        }
    }
    if aligned_rs.len() != nVar {
        panic!(
            "nVar mismatch while encoding statement: aligned_rs.len()={}, nVar={}",
            aligned_rs.len(),
            nVar,
        );
    }
    msm_g1_bases(&aligned_variable, &aligned_rs)
}

/// CRS (Common Reference String) structure
/// This corresponds to σ = ([σ_1]_1, [σ_2]_2) defined in the paper
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Sigma {
    pub G: G1serde,
    pub H: G2serde,
    pub sigma_1: Sigma1,
    pub sigma_2: Sigma2,
    pub lagrange_KL: G1serde,
}

impl Sigma {
    /// Generate full CRS
    pub fn gen(
        params: &SetupParams,
        public_wire_layout: &PublicWireLayout,
        tau: &Tau,
        o_vec: &[ScalarField],
        l_vec: &[ScalarField],
        k_vec: &[ScalarField],
        m_vec: &[ScalarField],
        g1_gen: &G1Affine,
        g2_gen: &G2Affine,
    ) -> Self {
        println!("Generating a sigma (σ)...");
        let lagrange_KL =
            (l_vec[params.s_max - 1] * k_vec[params.l_D - params.l - 1]) * G1serde(*g1_gen);
        let sigma_1 = Sigma1::gen(
            params,
            public_wire_layout,
            tau,
            o_vec,
            l_vec,
            k_vec,
            m_vec,
            g1_gen,
        );
        let sigma_2 = Sigma2::gen(tau, g2_gen);
        Self {
            G: G1serde(*g1_gen),
            H: G2serde(*g2_gen),
            sigma_1,
            sigma_2,
            lagrange_KL,
        }
    }
}

/// CRS's AC component
/// This corresponds to σ_A,C in the mathematical formulation
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Sigma1 {
    // Elements of the form {x^h y^i}_{h=0,i=0}^{max(2n-2,3m_D-3),2*s_max-2}
    pub xy_powers: Box<[G1serde]>,
    pub x: G1serde,
    pub y: G1serde,
    pub delta: G1serde,
    pub eta: G1serde,
    pub gamma_inv_o_inst: Box<[G1serde]>,
    pub eta_inv_li_o_inter_alpha4_kj: Box<[Box<[G1serde]>]>, // {η^(-1)L_i(y)(o_{j+l}(x) + α^4 K_j(x))}_{i=0,j=0}^{s_max-1,m_I-1}
    pub delta_inv_li_o_prv: Box<[Box<[G1serde]>]>, // {δ^(-1)L_i(y)o_j(x)}_{i=0,j=l+m_I}^{s_max-1,m_I-1}
    pub delta_inv_alphak_xh_tx: Box<[Box<[G1serde]>]>, // {δ^(-1)α^k x^h t_n(x)}_{h=0,k=1}^{2,3}
    pub delta_inv_alpha4_xj_tx: Box<[G1serde]>,    // {δ^(-1)α^4 x^j t_{m_I}(x)}_{j=0}^{1}
    pub delta_inv_alphak_yi_ty: Box<[Box<[G1serde]>]>, // {δ^(-1)α^k y^i t_{s_max}(y)}_{i=0,k=1}^{2,4}
}

impl_encode_poly!(Sigma1);

fn public_lagrange_terms(
    public_wire_layout: &PublicWireLayout,
    l_vec: &[ScalarField],
    o_inst_vec: &[ScalarField],
) -> Box<[ScalarField]> {
    if public_wire_layout.len() != o_inst_vec.len() {
        panic!(
            "public wire layout length mismatch: expected {}, got {}",
            o_inst_vec.len(),
            public_wire_layout.len()
        );
    }

    o_inst_vec
        .iter()
        .enumerate()
        .map(|(global_wire_index, value)| {
            public_wire_layout
                .placement_phase_for_public_wire(global_wire_index)
                .map(|placement_phase| {
                    let lagrange_value = l_vec.get(placement_phase).unwrap_or_else(|| {
                        panic!(
                            "public wire placement phase {placement_phase} is outside the Lagrange basis vector"
                        )
                    });
                    *lagrange_value * *value
                })
                .unwrap_or_else(ScalarField::zero)
        })
        .collect()
}

fn public_instance_terms(
    public_wire_layout: &PublicWireLayout,
    l_vec: &[ScalarField],
    o_inst_vec: &[ScalarField],
    m_vec: &[ScalarField],
) -> Box<[ScalarField]> {
    if m_vec.len() != public_wire_layout.free_public_len() {
        panic!(
            "M basis length mismatch: expected {}, got {}",
            public_wire_layout.free_public_len(),
            m_vec.len()
        );
    }

    let mut terms = public_lagrange_terms(public_wire_layout, l_vec, o_inst_vec);
    for (global_wire_index, m_value) in m_vec.iter().enumerate() {
        terms[global_wire_index] = terms[global_wire_index] + *m_value;
    }
    terms
}

impl Sigma1 {
    pub fn gen(
        params: &SetupParams,
        public_wire_layout: &PublicWireLayout,
        tau: &Tau,
        o_vec: &[ScalarField],
        l_vec: &[ScalarField],
        k_vec: &[ScalarField],
        m_vec: &[ScalarField],
        g1_gen: &G1Affine,
    ) -> Self {
        let n = params.n;
        let m_d = params.m_D;
        let l = params.l;
        let s_max = params.s_max;
        let m_i = params.l_D - l;

        println!("Generating Sigma1 components...");

        // Calculate max(2n-2, 3m_I-3) for h upper bound
        let h_max = std::cmp::max(2 * n, 2 * m_i);

        // Calculate elements of the form {x^h y^i}
        println!("Generating xy_powers of size {}...", h_max * (2 * s_max));
        let x_pows_vec =
            extend_monomial_vec!(&vec![ScalarField::one(), tau.x].into_boxed_slice(), h_max);
        let y_pows_vec = extend_monomial_vec!(
            &vec![ScalarField::one(), tau.y].into_boxed_slice(),
            2 * s_max
        );
        let xy_powers =
            type_scaled_monomials_1d!(&x_pows_vec, &y_pows_vec, h_max, 2 * s_max, None, g1_gen);
        println!("");

        // Split output vector into input, output, intermediate, and private parts
        let o_inst_vec = &o_vec[0..l].to_vec().into_boxed_slice();
        let o_inter_vec = &o_vec[l..l + m_i].to_vec().into_boxed_slice();
        let o_prv_vec = &o_vec[l + m_i..m_d].to_vec().into_boxed_slice();

        // Generate delta = G1serde · δ and eta = G1serde · η
        let x = G1serde(G1Affine::from((*g1_gen).to_projective() * tau.x));
        let y = G1serde(G1Affine::from((*g1_gen).to_projective() * tau.y));
        let delta = G1serde(G1Affine::from((*g1_gen).to_projective() * tau.delta));
        let eta = G1serde(G1Affine::from((*g1_gen).to_projective() * tau.eta));

        // Generate γ^(-1)(L_phase(y)o_j(x) + M_j(x)) for public instance wires.
        println!("Generating gamma_inv_o_inst of size {}...", l);
        let mut gamma_inv_o_inst = vec![G1serde::zero(); l].into_boxed_slice();
        {
            let l_o_inst_mj_vec =
                public_instance_terms(public_wire_layout, l_vec, o_inst_vec, m_vec);

            let mut gamma_inv_o_inst_vec = vec![ScalarField::zero(); l].into_boxed_slice();
            scale_vec(tau.gamma.inv(), &l_o_inst_mj_vec, &mut gamma_inv_o_inst_vec);
            drop(l_o_inst_mj_vec);

            from_coef_vec_to_g1serde_vec(&gamma_inv_o_inst_vec, g1_gen, &mut gamma_inv_o_inst);
        }

        // Generate η^(-1)L_i(y)(o_{j+l}(x) + α^k K_j(x)) for intermediate wires
        println!(
            "Generating eta_inv_li_o_inter_alpha4_kj of size {}...",
            m_i * s_max
        );
        let mut alpha4_kj_vec = vec![ScalarField::zero(); m_i].into_boxed_slice();
        scale_vec(tau.alpha.pow(4), k_vec, &mut alpha4_kj_vec);
        let mut o_inter_alpha4_kj_vec = vec![ScalarField::zero(); m_i].into_boxed_slice();
        point_add_two_vecs(o_inter_vec, &alpha4_kj_vec, &mut o_inter_alpha4_kj_vec);
        let eta_inv_li_o_inter_alpha4_kj = type_scaled_outer_product_2d!(
            &o_inter_alpha4_kj_vec,
            l_vec,
            g1_gen,
            Some(&tau.eta.inv())
        );
        drop(alpha4_kj_vec);
        drop(o_inter_alpha4_kj_vec);

        // Generate δ^(-1)L_i(y)o_j(x) for private wires
        println!(
            "Generating delta_inv_li_o_prv of size {}...",
            (m_d - (l + m_i)) * s_max
        );
        let delta_inv_li_o_prv =
            type_scaled_outer_product_2d!(o_prv_vec, l_vec, g1_gen, Some(&tau.delta.inv()));

        // Generate δ^(-1)α^k x^h t_n(x) for a vanishing polynomial in x
        println!("Generating delta_inv_alphak_xh_tx...");
        let mut delta_inv_alphak_xh_tx =
            vec![vec![G1serde::zero(); 3].into_boxed_slice(); 3].into_boxed_slice(); // k ∈ [1,3], h ∈ [0,2]
        {
            let mut delta_inv_alphak_xh_tx_vec = vec![ScalarField::zero(); 9].into_boxed_slice(); // k ∈ [1,3], h ∈ [0,2]
            let t_x = tau.x.pow(n) - ScalarField::one(); // t_n(x) = x^n - 1
            for k in 1..=3 {
                for h in 0..=2 {
                    let idx = (k - 1) * 3 + h;
                    delta_inv_alphak_xh_tx_vec[idx] =
                        tau.delta.inv() * tau.alpha.pow(k) * tau.x.pow(h) * t_x;
                }
            }
            from_coef_vec_to_g1serde_mat(
                &delta_inv_alphak_xh_tx_vec,
                3,
                3,
                g1_gen,
                &mut delta_inv_alphak_xh_tx,
            );
        }

        // Generate δ^(-1)α^4 x^j t_{m_I}(x) for a vanishing polynomial in x
        println!("Generating delta_inv_alpha4_xj_tx...");
        let mut delta_inv_alpha4_xj_tx = vec![G1serde::zero(); 2].into_boxed_slice(); // Only j ∈ [0,1]
        {
            let mut delta_inv_alpha4_xj_tx_vec = vec![ScalarField::zero(); 2].into_boxed_slice();
            let t_x = tau.x.pow(m_i) - ScalarField::one(); // t_{m_I}(x) = x^{m_I} - 1
            for j in 0..=1 {
                delta_inv_alpha4_xj_tx_vec[j] =
                    tau.delta.inv() * tau.alpha.pow(4) * tau.x.pow(j) * t_x;
            }
            from_coef_vec_to_g1serde_vec(
                &delta_inv_alpha4_xj_tx_vec,
                g1_gen,
                &mut delta_inv_alpha4_xj_tx,
            );
        }

        // Generate δ^(-1)α^k y^i t_{s_max}(y) for a vanishing polynomial in y
        println!("Generating delta_inv_alphak_yi_ty...");
        let mut delta_inv_alphak_yi_ty =
            vec![vec![G1serde::zero(); 3].into_boxed_slice(); 4].into_boxed_slice(); // k ∈ [1,4], i ∈ [0,2]
        {
            let mut delta_inv_alphak_yi_ty_vec = vec![ScalarField::zero(); 12].into_boxed_slice();
            let t_y = tau.y.pow(s_max) - ScalarField::one(); // t_{s_max}(y) = y^{s_max} - 1
            for k in 1..=4 {
                for i in 0..=2 {
                    let idx = (k - 1) * 3 + i;
                    delta_inv_alphak_yi_ty_vec[idx] =
                        tau.delta.inv() * tau.alpha.pow(k) * tau.y.pow(i) * t_y;
                }
            }
            from_coef_vec_to_g1serde_mat(
                &delta_inv_alphak_yi_ty_vec,
                4,
                3,
                g1_gen,
                &mut delta_inv_alphak_yi_ty,
            );
        }

        Self {
            xy_powers,
            x,
            y,
            delta,
            eta,
            gamma_inv_o_inst,
            eta_inv_li_o_inter_alpha4_kj,
            delta_inv_li_o_prv,
            delta_inv_alphak_xh_tx,
            delta_inv_alpha4_xj_tx,
            delta_inv_alphak_yi_ty,
        }
    }

    pub fn encode_O_pub_free(
        &self,
        placement_variables: &[PlacementVariables],
        public_wire_layout: &PublicWireLayout,
    ) -> G1serde {
        encode_o_pub_free_common(placement_variables, public_wire_layout, |global_idx| {
            self.gamma_inv_o_inst[global_idx].0
        })
    }

    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        encode_o_pub_fix_common(
            a_pub_function,
            setup_params,
            self.gamma_inv_o_inst.len(),
            |idx| self.gamma_inv_o_inst[idx].0,
        )
    }

    pub fn encode_O_mid_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        let nVar = count_statement_nvar(
            setup_params.l,
            setup_params.l_D,
            placement_variables,
            subcircuit_infos,
        );
        encode_statement_common(
            setup_params.l,
            setup_params.l_D,
            nVar,
            placement_variables,
            subcircuit_infos,
            |global_idx, i| self.eta_inv_li_o_inter_alpha4_kj[global_idx][i].0,
        )
    }

    pub fn encode_O_prv_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        let nVar = count_statement_nvar(
            setup_params.l_D,
            setup_params.m_D,
            placement_variables,
            subcircuit_infos,
        );
        encode_statement_common(
            setup_params.l_D,
            setup_params.m_D,
            nVar,
            placement_variables,
            subcircuit_infos,
            |global_idx, i| self.delta_inv_li_o_prv[global_idx][i].0,
        )
    }
}
/// This corresponds to σ_2 in the paper:
/// σ_2 := (α, α^2, α^3, α^4, γ, δ, η, x, y)
#[derive(Debug, Clone, Deserialize, Serialize, Copy)]
pub struct Sigma2 {
    pub alpha: G2serde,
    pub alpha2: G2serde,
    pub alpha3: G2serde,
    pub alpha4: G2serde,
    pub gamma: G2serde,
    pub delta: G2serde,
    pub eta: G2serde,
    pub x: G2serde,
    pub y: G2serde,
}

impl Sigma2 {
    /// Generate CRS elements for trapdoor component
    pub fn gen(tau: &Tau, g2_gen: &G2Affine) -> Self {
        println!("Generating Sigma2 components...");
        let alpha = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.alpha));
        let alpha2 = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.alpha.pow(2)));
        let alpha3 = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.alpha.pow(3)));
        let alpha4 = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.alpha.pow(4)));
        let gamma = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.gamma));
        let delta = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.delta));
        let eta = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.eta));
        let x = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.x));
        let y = G2serde(G2Affine::from((*g2_gen).to_projective() * tau.y));

        Self {
            alpha,
            alpha2,
            alpha3,
            alpha4,
            gamma,
            delta,
            eta,
            x,
            y,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SigmaPreprocess {
    pub sigma_1: PartialSigma1,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct PartialSigma1 {
    pub xy_powers: Box<[G1serde]>,
    pub gamma_inv_o_inst: Box<[G1serde]>,
}
impl_encode_poly!(PartialSigma1);

impl PartialSigma1 {
    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        encode_o_pub_fix_common(
            a_pub_function,
            setup_params,
            self.gamma_inv_o_inst.len(),
            |idx| self.gamma_inv_o_inst[idx].0,
        )
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PartialSigma1Verify {
    pub x: G1serde,
    pub y: G1serde,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SigmaVerify {
    pub G: G1serde,
    pub H: G2serde,
    pub sigma_1: PartialSigma1Verify,
    pub sigma_2: Sigma2,
    pub lagrange_KL: G1serde,
}

impl SigmaVerify {
    pub fn g(&self) -> G1serde {
        self.G
    }

    pub fn h(&self) -> G2serde {
        self.H
    }

    pub fn sigma1_x(&self) -> G1serde {
        self.sigma_1.x
    }

    pub fn sigma1_y(&self) -> G1serde {
        self.sigma_1.y
    }

    pub fn sigma2(&self) -> Sigma2 {
        self.sigma_2
    }

    pub fn lagrange_kl(&self) -> G1serde {
        self.lagrange_KL
    }
}

#[derive(Clone, Debug, Copy, PartialEq)]
pub struct G1serde(pub G1Affine);
impl G1serde {
    pub fn zero() -> Self {
        Self(G1Affine::zero())
    }
}
impl Add for G1serde {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        G1serde(G1Affine::from(
            self.0.to_projective() + other.0.to_projective(),
        ))
    }
}

impl Sub for G1serde {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        G1serde(G1Affine::from(
            self.0.to_projective() - other.0.to_projective(),
        ))
    }
}

// G1serde * original field
impl Mul<ScalarField> for G1serde {
    type Output = Self;

    fn mul(self, other: ScalarField) -> Self {
        G1serde(G1Affine::from(self.0.to_projective() * other))
    }
}
// original field * G1serde
impl Mul<G1serde> for ScalarField {
    type Output = G1serde;

    fn mul(self, other: G1serde) -> Self::Output {
        G1serde(G1Affine::from(other.0.to_projective() * self))
    }
}

// G1serde * FieldSerde
impl Mul<FieldSerde> for G1serde {
    type Output = Self;

    fn mul(self, other: FieldSerde) -> Self {
        G1serde(G1Affine::from(self.0.to_projective() * other.0))
    }
}
// original field * G1serde
impl Mul<G1serde> for FieldSerde {
    type Output = G1serde;

    fn mul(self, other: G1serde) -> Self::Output {
        G1serde(G1Affine::from(other.0.to_projective() * self.0))
    }
}

#[derive(Clone, Debug, Copy, PartialEq)]
pub struct G2serde(pub G2Affine);
impl G2serde {
    pub fn zero() -> Self {
        Self(G2Affine::zero())
    }
}
impl Add for G2serde {
    type Output = Self;

    fn add(self, other: Self) -> Self {
        G2serde(G2Affine::from(
            self.0.to_projective() + other.0.to_projective(),
        ))
    }
}

impl Sub for G2serde {
    type Output = Self;

    fn sub(self, other: Self) -> Self {
        G2serde(G2Affine::from(
            self.0.to_projective() - other.0.to_projective(),
        ))
    }
}

// G2serde * original field
impl Mul<ScalarField> for G2serde {
    type Output = Self;

    fn mul(self, other: ScalarField) -> Self {
        G2serde(G2Affine::from(self.0.to_projective() * other))
    }
}
// original field * G2serde
impl Mul<G2serde> for ScalarField {
    type Output = G2serde;

    fn mul(self, other: G2serde) -> Self::Output {
        G2serde(G2Affine::from(other.0.to_projective() * self))
    }
}

// G2serde * FieldSerde
impl Mul<FieldSerde> for G2serde {
    type Output = Self;

    fn mul(self, other: FieldSerde) -> Self {
        G2serde(G2Affine::from(self.0.to_projective() * other.0))
    }
}
// original field * G2serde
impl Mul<G2serde> for FieldSerde {
    type Output = G2serde;

    fn mul(self, other: G2serde) -> Self::Output {
        G2serde(G2Affine::from(other.0.to_projective() * self.0))
    }
}

pub fn icicle_g1_affine_to_ark(g: &G1Affine) -> ArkG1Affine {
    let x_bytes = g.x.to_bytes_le();
    let y_bytes = g.y.to_bytes_le();
    let x = ark_bls12_381::Fq::from_random_bytes(&x_bytes)
        .expect("failed to convert x from icicle to ark");
    let y = ark_bls12_381::Fq::from_random_bytes(&y_bytes)
        .expect("failed to convert y from icicle to ark");
    ArkG1Affine::new_unchecked(x, y)
}

pub fn icicle_g2_affine_to_ark(g: &G2Affine) -> ArkG2Affine {
    let x_bytes = g.x.to_bytes_le();
    let y_bytes = g.y.to_bytes_le();

    let x = ark_bls12_381::Fq2::from_random_bytes(&x_bytes)
        .expect("failed to convert x from icicle to ark");
    let y = ark_bls12_381::Fq2::from_random_bytes(&y_bytes)
        .expect("failed to convert y from icicle to ark");

    ArkG2Affine::new_unchecked(x, y)
}

#[cfg(test)]
mod public_phase_tests {
    use super::*;
    use crate::frontend_artifacts::public_wire_layout::{GlobalWire, PublicWireLayout};
    use crate::frontend_artifacts::{BufferDirection, SetupParams, SubcircuitInfo};

    #[test]
    fn applies_each_buffer_phase_and_omits_the_padding_phase_term() {
        let layout = test_public_wire_layout();
        let lagrange_values = [
            ScalarField::from_u32(2),
            ScalarField::from_u32(3),
            ScalarField::from_u32(5),
            ScalarField::from_u32(7),
        ];
        let output_values = [
            ScalarField::from_u32(11),
            ScalarField::from_u32(13),
            ScalarField::from_u32(17),
        ];

        let m_values = [ScalarField::from_u32(19), ScalarField::from_u32(23)];
        let terms = public_instance_terms(&layout, &lagrange_values, &output_values, &m_values);

        assert_eq!(terms[0], ScalarField::from_u32(41));
        assert_eq!(terms[1], ScalarField::from_u32(23));
        assert_eq!(terms[2], ScalarField::from_u32(51));
    }

    #[test]
    fn encodes_free_public_wires_by_placement_phase_not_subcircuit_id() {
        let layout = test_public_wire_layout();
        let placement_variables = [
            placement(17, &["0x01", "0x02", "0x03"]),
            placement(42, &["0x04", "0x05", "0x06"]),
        ];

        // Non-contiguous identifiers would be invalid slice indices. This must instead
        // resolve them through the compiler-derived placement phases 0 and 1.
        let encoded = encode_o_pub_free_common(&placement_variables, &layout, |_| G1Affine::zero());

        assert_eq!(encoded, G1serde::zero());
    }

    fn test_public_wire_layout() -> PublicWireLayout {
        let mut output_buffer = buffer(17, BufferDirection::Out);
        let mut input_buffer = buffer(42, BufferDirection::In);
        output_buffer.flattenMap[1] = 0;
        output_buffer.flattenMap[0] = 3;
        output_buffer.flattenMap[2] = 4;
        input_buffer.flattenMap[2] = 2;
        input_buffer.flattenMap[0] = 5;
        input_buffer.flattenMap[1] = 6;

        let setup_params = SetupParams {
            l_free: 2,
            l: 3,
            l_user_out: 0,
            l_user: 0,
            l_D: 3,
            m_D: 7,
            n: 1,
            s_D: 2,
            s_max: 4,
        };
        let global_wires = [
            GlobalWire::Mapped {
                subcircuit_id: 17,
                local_wire_index: 1,
            },
            GlobalWire::Padding,
            GlobalWire::Mapped {
                subcircuit_id: 42,
                local_wire_index: 2,
            },
            GlobalWire::Mapped {
                subcircuit_id: 17,
                local_wire_index: 0,
            },
            GlobalWire::Mapped {
                subcircuit_id: 17,
                local_wire_index: 2,
            },
            GlobalWire::Mapped {
                subcircuit_id: 42,
                local_wire_index: 0,
            },
            GlobalWire::Mapped {
                subcircuit_id: 42,
                local_wire_index: 1,
            },
        ];

        PublicWireLayout::derive(&setup_params, &global_wires, &[output_buffer, input_buffer])
            .unwrap()
    }

    fn buffer(id: usize, direction: BufferDirection) -> SubcircuitInfo {
        SubcircuitInfo {
            id,
            name: format!("buffer{id}"),
            Nwires: 3,
            Nconsts: 0,
            Out_idx: vec![1, 1].into_boxed_slice(),
            In_idx: vec![2, 1].into_boxed_slice(),
            flattenMap: vec![usize::MAX; 3].into_boxed_slice(),
            bufferDirection: Some(direction),
        }
    }

    fn placement(subcircuit_id: usize, variables: &[&str]) -> PlacementVariables {
        PlacementVariables {
            subcircuitId: subcircuit_id,
            variables: variables
                .iter()
                .map(|value| HexString((*value).to_owned()))
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        }
    }
}
