use crate::group_structures::G1serde;
use crate::utils::cuda_msm_is_available;
use crate::vector_operations::scaled_outer_product;
use icicle_bls12_381::curve::{G1Affine, G1Projective, ScalarField};
use icicle_core::msm;
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::{DeviceVec, HostSlice};
use rayon::iter::{
    IndexedParallelIterator, IntoParallelIterator, IntoParallelRefMutIterator, ParallelIterator,
};

#[cfg(test)]
use icicle_core::msm::MSMConfig;
#[cfg(test)]
use icicle_core::traits::Arithmetic;

pub fn scaled_outer_product_2d(
    col_vec: &[ScalarField],
    row_vec: &[ScalarField],
    g1_gen: &G1Affine,
    scaler: Option<&ScalarField>,
    res: &mut Box<[Box<[G1serde]>]>,
) {
    let row_size = col_vec.len();
    let col_size = row_vec.len();
    let size = col_size * row_size;
    if res.len() > 0 {
        if res.len() * res[0].len() != size {
            panic!("Insufficient buffer length");
        }
    } else {
        panic!("Empty buffer");
    }

    let mut res_coef = vec![ScalarField::zero(); size].into_boxed_slice();
    scaled_outer_product(col_vec, row_vec, scaler, &mut res_coef);
    from_coef_vec_to_g1serde_mat(&res_coef, row_size, col_size, g1_gen, res);
}

pub fn scaled_outer_product_1d(
    col_vec: &[ScalarField],
    row_vec: &[ScalarField],
    g1_gen: &G1Affine,
    scaler: Option<&ScalarField>,
    res: &mut [G1serde],
) {
    let col_size = col_vec.len();
    let row_size = row_vec.len();
    let size = col_size * row_size;
    if res.len() != size {
        panic!("Insufficient buffer length");
    }
    let mut res_coef = vec![ScalarField::zero(); size].into_boxed_slice();
    scaled_outer_product(col_vec, row_vec, scaler, &mut res_coef);
    from_coef_vec_to_g1serde_vec(&res_coef, g1_gen, res);
}

pub fn from_coef_vec_to_g1serde_vec_msm(coef: &[ScalarField], gen: &G1Affine, res: &mut [G1serde]) {
    println!("msm");
    let n = coef.len();

    let scalars_host = HostSlice::from_slice(coef.as_ref());

    let mut pts = Vec::with_capacity(n);
    pts.resize(n, *gen);

    let points_host = HostSlice::from_slice(&pts);

    let mut result_dev = DeviceVec::<G1Projective>::device_malloc(n).expect("device_malloc failed");

    let cfg = msm::MSMConfig::default();

    msm::msm(
        scalars_host, // &[ScalarField]
        points_host,  // &[G1Affine]
        &cfg,
        &mut result_dev[..], // &mut DeviceSlice<G1Projective>
    )
    .expect("msm failed");

    let mut host_out = vec![G1Projective::zero(); n];
    result_dev
        .copy_to_host(HostSlice::from_mut_slice(&mut host_out))
        .expect("copy_to_host failed");

    drop(result_dev);
    // drop(points_host);
    // drop(scalars_host);

    host_out
        .into_par_iter()
        .zip(res.par_iter_mut())
        .for_each(|(proj, slot)| {
            *slot = G1serde(G1Affine::from(proj));
        });
}

pub fn from_coef_vec_to_g1serde_vec(coef: &[ScalarField], gen: &G1Affine, res: &mut [G1serde]) {
    if cuda_msm_is_available() {
        from_coef_vec_to_g1serde_vec_msm(&coef.to_vec().into_boxed_slice(), gen, res);
    } else {
        use rayon::prelude::*;
        use std::io::{stdout, Write};
        use std::sync::atomic::{AtomicU32, Ordering};

        if res.len() != coef.len() {
            panic!("Not enough buffer length.")
        }
        if coef.len() == 0 {
            return;
        }

        let gen_proj = gen.to_projective();

        let cnt = AtomicU32::new(1);
        let progress = AtomicU32::new(0);
        let _tick: u32 = std::cmp::max(coef.len() as u32 / 10, 1);
        let tick = AtomicU32::new(_tick);
        res.par_iter_mut().zip(coef.par_iter()).for_each(|(r, &c)| {
            *r = G1serde(G1Affine::from(gen_proj * c));
            let current_cnt = cnt.fetch_add(1, Ordering::Relaxed);
            let target_tick = tick.load(Ordering::Relaxed);
            if current_cnt >= target_tick {
                if tick
                    .compare_exchange(
                        target_tick,
                        target_tick + _tick,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    )
                    .is_ok()
                {
                    progress.fetch_add(10, Ordering::Relaxed);
                    let new_progress = progress.load(Ordering::Relaxed);
                    print!(
                        "\rProgress: {}%, {} elements out of {}.",
                        new_progress,
                        current_cnt,
                        coef.len()
                    );
                    stdout().flush().unwrap();
                }
            }
        });
        println!("\n");
        print!("\r");
    }
}

#[cfg(test)]
pub(crate) fn gen_g1serde_vec_of_xy_monomials(
    x: ScalarField,
    y: ScalarField,
    gen: &G1Affine,
    x_size: usize,
    y_size: usize,
    res: &mut [G1serde],
) {
    use rayon::prelude::*;
    if res.len() != x_size * y_size {
        panic!("Not enough buffer length.")
    }
    if x_size * y_size == 0 {
        return;
    }

    let gen_proj = G1Projective::from(*gen);

    let is_row_base = x_size <= y_size;

    let outer_loop_len = if is_row_base { x_size } else { y_size };
    let inner_loop_len = if is_row_base { y_size } else { x_size };
    let mut res_projective = vec![G1Projective::zero(); x_size * y_size];

    let mut base_vec = vec![G1Projective::zero(); inner_loop_len];
    let base_multiplier = if is_row_base { y } else { x };
    base_vec.par_iter_mut().enumerate().for_each(|(i, b)| {
        *b = gen_proj * base_multiplier.pow(i);
    });

    res_projective[0..inner_loop_len].clone_from_slice(&base_vec);

    let acc_multiplier = if is_row_base { x } else { y };
    let mut msm_cfg = MSMConfig::default();
    msm_cfg.batch_size = inner_loop_len.try_into().unwrap();
    for i in 1..outer_loop_len {
        let (head, tail) = res_projective.split_at_mut(i * inner_loop_len);
        let prev_vec = &head[(i - 1) * inner_loop_len..i * inner_loop_len];
        let prev_vec_affine: Vec<G1Affine> = prev_vec
            .iter()
            .map(|&point| G1Affine::from(point))
            .collect();
        let curr_vec = &mut tail[0..inner_loop_len];
        msm::msm(
            HostSlice::from_slice(&vec![acc_multiplier; inner_loop_len]),
            HostSlice::from_slice(&prev_vec_affine),
            &msm_cfg,
            HostSlice::from_mut_slice(curr_vec),
        )
        .unwrap();
    }
    for i in 0..x_size {
        for j in 0..y_size {
            if is_row_base {
                res[i * y_size + j] =
                    G1serde(G1Affine::from(res_projective[i * inner_loop_len + j]));
            } else {
                res[i * y_size + j] =
                    G1serde(G1Affine::from(res_projective[j * inner_loop_len + i]));
            }
        }
    }
}

pub fn from_coef_vec_to_g1serde_mat(
    coef: &[ScalarField],
    r_size: usize,
    c_size: usize,
    gen: &G1Affine,
    res: &mut Box<[Box<[G1serde]>]>,
) {
    if res.len() != r_size || res.len() == 0 {
        panic!("Not enough buffer row length.")
    }
    let mut temp_vec = vec![G1serde::zero(); r_size * c_size].into_boxed_slice();
    from_coef_vec_to_g1serde_vec(coef, gen, &mut temp_vec);
    for i in 0..r_size {
        if res[i].len() != c_size {
            panic!("Not enough buffer column length.")
        }
        res[i].copy_from_slice(&temp_vec[i * c_size..(i + 1) * c_size]);
    }
}
