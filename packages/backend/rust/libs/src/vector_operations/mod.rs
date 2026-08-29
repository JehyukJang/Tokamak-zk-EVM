use super::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use icicle_bls12_381::curve::{ScalarCfg, ScalarField};
use icicle_core::traits::FieldImpl;
use icicle_core::vec_ops::{VecOps, VecOpsConfig};
use icicle_runtime::errors::eIcicleError;
use icicle_runtime::memory::{DeviceSlice, DeviceVec, HostOrDeviceSlice, HostSlice};

pub fn gen_evaled_lagrange_bases(val: &ScalarField, size: usize, res: &mut [ScalarField]) {
    let mut val_pows = vec![ScalarField::one(); size];
    for i in 1..size {
        val_pows[i] = val_pows[i - 1] * *val;
    }
    let temp_evals = HostSlice::from_slice(&val_pows);
    let temp_poly = DensePolynomialExt::from_rou_evals(temp_evals, size, 1, None, None);
    let cached_val_pows = HostSlice::from_mut_slice(res);
    temp_poly.copy_coeffs(0, cached_val_pows);
}

pub fn point_mul_two_vecs(lhs: &[ScalarField], rhs: &[ScalarField], res: &mut [ScalarField]) {
    if lhs.len() != rhs.len() || lhs.len() != res.len() {
        panic!("Mismatch of sizes of vectors to be pointwise-multiplied");
    }
    let mut vec_ops_cfg = VecOpsConfig::default();
    // Optimize for GPU memory coalescing
    vec_ops_cfg.is_a_on_device = false;
    vec_ops_cfg.is_b_on_device = false;
    vec_ops_cfg.is_result_on_device = false;

    let lhs_buff = HostSlice::from_slice(lhs);
    let rhs_buff = HostSlice::from_slice(rhs);
    let res_buff = HostSlice::from_mut_slice(res);
    ScalarCfg::mul(lhs_buff, rhs_buff, res_buff, &vec_ops_cfg).unwrap();
}

pub fn point_div_two_vecs(numer: &[ScalarField], denom: &[ScalarField], res: &mut [ScalarField]) {
    if numer.len() != denom.len() || numer.len() != res.len() {
        panic!("Mismatch of sizes of vectors to be pointwise-multiplied");
    }
    let vec_ops_cfg = VecOpsConfig::default();
    let lhs_buff = HostSlice::from_slice(numer);
    let rhs_buff = HostSlice::from_slice(denom);
    let res_buff = HostSlice::from_mut_slice(res);
    ScalarCfg::div(lhs_buff, rhs_buff, res_buff, &vec_ops_cfg).unwrap();
}

pub fn point_add_two_vecs(lhs: &[ScalarField], rhs: &[ScalarField], res: &mut [ScalarField]) {
    if lhs.len() != rhs.len() || lhs.len() != res.len() {
        panic!("Mismatch of sizes of vectors to be pointwise-multiplied");
    }
    let vec_ops_cfg = VecOpsConfig::default();
    let lhs_buff = HostSlice::from_slice(lhs);
    let rhs_buff = HostSlice::from_slice(rhs);
    let res_buff = HostSlice::from_mut_slice(res);
    ScalarCfg::add(lhs_buff, rhs_buff, res_buff, &vec_ops_cfg).unwrap();
}

pub fn scale_vec(scaler: ScalarField, vec: &[ScalarField], res: &mut [ScalarField]) {
    if vec.len() != res.len() {
        panic!("Incorrect output buffer length");
    }
    let vec_ops_cfg = VecOpsConfig::default();
    let lhs_v = vec![scaler];
    let lhs_buff = HostSlice::from_slice(&lhs_v);
    let rhs_buff = HostSlice::from_slice(vec);
    let res_buff = HostSlice::from_mut_slice(res);
    ScalarCfg::scalar_mul(lhs_buff, rhs_buff, res_buff, &vec_ops_cfg).unwrap();
}

pub fn scalar_vec_add(scalar: ScalarField, vec: &[ScalarField], res: &mut [ScalarField]) {
    if vec.len() != res.len() {
        panic!("Incorrect output buffer length");
    }
    let vec_ops_cfg = VecOpsConfig::default();
    let lhs_v = vec![scalar];
    let lhs_buff = HostSlice::from_slice(&lhs_v);
    let rhs_buff = HostSlice::from_slice(vec);
    let res_buff = HostSlice::from_mut_slice(res);
    ScalarCfg::scalar_add(lhs_buff, rhs_buff, res_buff, &vec_ops_cfg).unwrap();
}

pub fn transpose_inplace(a_vec: &mut [ScalarField], row_size: usize, col_size: usize) {
    if a_vec.len() != row_size * col_size {
        panic!("Error in transpose")
    }
    if row_size * col_size == 0 {
        return;
    }
    let vec_ops_cfg = VecOpsConfig::default();
    let a = HostSlice::from_slice(a_vec);
    let mut res_vec = vec![ScalarField::zero(); row_size * col_size];
    let res = HostSlice::from_mut_slice(&mut res_vec);
    ScalarCfg::transpose(a, row_size as u32, col_size as u32, res, &vec_ops_cfg).unwrap();
    a_vec.clone_from_slice(&res_vec);
}

fn transpose_device_inplace_checked(
    a_vec: &mut DeviceSlice<ScalarField>,
    row_size: usize,
    col_size: usize,
) -> Result<(), eIcicleError> {
    if a_vec.len() != row_size * col_size {
        panic!("Error in transpose")
    }
    if row_size * col_size == 0 {
        return Ok(());
    }
    let mut vec_ops_cfg = VecOpsConfig::default();
    vec_ops_cfg.is_a_on_device = true;
    vec_ops_cfg.is_result_on_device = true;

    let mut res_vec = DeviceVec::device_malloc(row_size * col_size)?;

    ScalarCfg::transpose(
        a_vec,
        row_size as u32,
        col_size as u32,
        &mut res_vec,
        &vec_ops_cfg,
    )?;
    a_vec.copy(&res_vec)?;
    Ok(())
}

fn _repeat_extend_device_checked(
    v: &DeviceSlice<ScalarField>,
    n: usize,
) -> Result<DeviceVec<ScalarField>, eIcicleError> {
    let original_len = v.len();

    if n == 0 {
        return Err(eIcicleError::AllocationFailed);
    }

    if n == 1 {
        // Direct copy
        let mut result = DeviceVec::device_malloc(original_len)?;
        result.copy(v)?;
        return Ok(result);
    }

    let target_len = original_len * n;
    let mut extended_vec = DeviceVec::device_malloc(target_len)?;

    // Optimized approach: Use exponential doubling to minimize kernel launches
    // This reduces the number of copy operations from O(n) to O(log n)

    // First copy: original vector -> position 0
    extended_vec[0..original_len].copy(v)?;

    // Exponential doubling: each iteration doubles the amount of valid data
    let mut current_len = original_len;
    while current_len < target_len {
        let copy_len = std::cmp::min(current_len, target_len - current_len);

        // Use a temporary buffer to avoid borrowing issues
        let mut temp_buffer = DeviceVec::device_malloc(copy_len)?;
        temp_buffer.copy(&extended_vec[0..copy_len])?;
        extended_vec[current_len..current_len + copy_len].copy(&temp_buffer)?;

        current_len += copy_len;
    }

    Ok(extended_vec)
}

pub fn matrix_matrix_mul(
    lhs_mat: &[ScalarField],
    rhs_mat: &[ScalarField],
    m: usize,
    n: usize,
    l: usize,
    res_mat: &mut [ScalarField],
) {
    matrix_matrix_mul_checked(lhs_mat, rhs_mat, m, n, l, res_mat).unwrap();
}

fn matrix_matrix_mul_checked(
    lhs_mat: &[ScalarField],
    rhs_mat: &[ScalarField],
    m: usize,
    n: usize,
    l: usize,
    res_mat: &mut [ScalarField],
) -> Result<(), eIcicleError> {
    if lhs_mat.len() != m * n || rhs_mat.len() != n * l || res_mat.len() != m * l {
        panic!("Incorrect sizes for the matrix multiplication")
    }
    if lhs_mat.is_empty() || rhs_mat.is_empty() {
        res_mat.fill(ScalarField::zero());
        return Ok(());
    }

    // size of LHS: m-by-n
    // size of RHS: n-by-l
    // Extending LHS and RHS. E.g., say LHS = [r1; r2; r3] and RHS = [c1, c2] with m=3, l=2, where r_i are row vectors, and c_i are column vectors.
    // Extended_LHS = [r1, r1, r2, r2, r3, r3], and
    // Extended_RHS = [c1^T, c2^T c1^T, c2^T; c1^T, c2^T].
    // Then, LHS*RHS is a batched inner product of Extended_LHS and Extended_RHS.

    // steps:
    // 1. [CPU -> GPU] copy host inputs matrices to device
    // 2. [GPU] transpose the device matrices
    // 3. [GPU] extend the device matrices
    // 4. [GPU] transpose the device matrices
    // 5. [GPU] multiply the device matrices
    // 6. [GPU -> CPU] copy the device matrices to host

    // Copy input matrices to device
    let mut lhs_device = DeviceVec::device_malloc(m * n)?;
    lhs_device
        .as_mut_slice()
        .copy_from_host(HostSlice::from_slice(lhs_mat))?;

    // Build extended matrices on the GPU
    let mut transposed_lhs = DeviceVec::device_malloc(m * n)?;
    let mut vec_ops_cfg = VecOpsConfig::default();
    vec_ops_cfg.is_a_on_device = true;
    vec_ops_cfg.is_result_on_device = true;
    ScalarCfg::transpose(
        &lhs_device,
        m as u32,
        n as u32,
        &mut transposed_lhs,
        &vec_ops_cfg,
    )?;

    matrix_matrix_mul_with_transposed_lhs(&transposed_lhs, rhs_mat, m, n, l, res_mat)
}

fn matrix_matrix_mul_with_transposed_lhs(
    transposed_lhs: &DeviceVec<ScalarField>,
    rhs_mat: &[ScalarField],
    m: usize,
    n: usize,
    l: usize,
    res_mat: &mut [ScalarField],
) -> Result<(), eIcicleError> {
    if transposed_lhs.len() != m * n || rhs_mat.len() != n * l || res_mat.len() != m * l {
        panic!("Incorrect sizes for the matrix multiplication")
    }
    if rhs_mat.is_empty() || res_mat.is_empty() {
        res_mat.fill(ScalarField::zero());
        return Ok(());
    }

    let mut vec_ops_cfg = VecOpsConfig::default();
    vec_ops_cfg.is_a_on_device = true;
    vec_ops_cfg.is_result_on_device = true;

    let mut rhs_device = DeviceVec::device_malloc(n * l)?;
    rhs_device
        .as_mut_slice()
        .copy_from_host(HostSlice::from_slice(rhs_mat))?;

    let mut extended_lhs = _repeat_extend_device_checked(transposed_lhs, l)?;
    transpose_device_inplace_checked(&mut extended_lhs, l * n, m)?;

    let mut transposed_rhs = DeviceVec::device_malloc(n * l)?;
    ScalarCfg::transpose(
        &rhs_device,
        n as u32,
        l as u32,
        &mut transposed_rhs,
        &vec_ops_cfg,
    )?;
    let extended_rhs = _repeat_extend_device_checked(&transposed_rhs, m)?;

    vec_ops_cfg.is_b_on_device = true;

    let mut mul_res_device = DeviceVec::device_malloc(m * n * l)?;
    ScalarCfg::mul(
        &extended_lhs,
        &extended_rhs,
        &mut mul_res_device,
        &vec_ops_cfg,
    )?;

    vec_ops_cfg.batch_size = (m * l) as i32;
    vec_ops_cfg.columns_batch = false;
    vec_ops_cfg.is_result_on_device = false; // Result goes to host
    ScalarCfg::sum(
        &mul_res_device,
        HostSlice::from_mut_slice(res_mat),
        &vec_ops_cfg,
    )?;
    Ok(())
}

pub fn outer_product_two_vecs(
    col_vec: &[ScalarField],
    row_vec: &[ScalarField],
    res: &mut [ScalarField],
) {
    if col_vec.len() * row_vec.len() != res.len() {
        panic!("Insufficient buffer length");
    }

    let row_len = col_vec.len();
    let col_len = row_vec.len();

    let min_len = std::cmp::min(row_len, col_len);
    let max_len = std::cmp::max(row_len, col_len);
    let max_col = max_len == row_len;

    let base_vec = if max_col { col_vec } else { row_vec };

    for ind in 0..min_len {
        let scaler = if max_col { row_vec[ind] } else { col_vec[ind] };
        let mut _res_vec = vec![ScalarField::zero(); max_len];
        scale_vec(scaler, base_vec, &mut _res_vec);
        res[ind * max_len..(ind + 1) * max_len].copy_from_slice(&_res_vec);
    }

    if max_col {
        transpose_inplace(res, min_len, max_len);
    }
}

pub fn extend_monomial_vec(mono_vec: &[ScalarField], res: &mut [ScalarField]) {
    let size_diff = res.len() as i64 - mono_vec.len() as i64;
    if size_diff == 0 {
        res.copy_from_slice(mono_vec);
    } else if size_diff > 0 {
        res[0..mono_vec.len()].copy_from_slice(mono_vec);
        for i in 0..size_diff as usize {
            res[mono_vec.len() + i] = res[mono_vec.len() + i - 1] * mono_vec[1];
        }
    } else {
        res.copy_from_slice(&mono_vec[0..res.len()]);
    }
}

pub fn resize<F>(
    mat: &[F],
    curr_row_size: usize,
    curr_col_size: usize,
    target_row_size: usize,
    target_col_size: usize,
    zero: F,
) -> Vec<F>
where
    F: Copy,
{
    let target_size: usize = target_row_size * target_col_size;
    let mut res_coeffs_vec = vec![zero; target_size];
    for i in 0..std::cmp::min(curr_row_size, target_row_size) {
        let each_col_size = std::cmp::min(curr_col_size, target_col_size);
        res_coeffs_vec[target_col_size * i..target_col_size * i + each_col_size]
            .copy_from_slice(&mat[curr_col_size * i..curr_col_size * i + each_col_size]);
    }
    res_coeffs_vec
}

pub fn scaled_outer_product(
    col_vec: &[ScalarField],
    row_vec: &[ScalarField],
    scaler: Option<&ScalarField>,
    res: &mut [ScalarField],
) {
    let col_size = col_vec.len();
    let row_size = row_vec.len();
    let size = col_size * row_size;
    if res.len() != size {
        panic!("Insufficient buffer length");
    }
    let mut scaled_vec = vec![ScalarField::zero(); col_size];
    if let Some(_scaler) = scaler {
        scale_vec(*_scaler, col_vec, &mut scaled_vec);
    } else {
        scaled_vec.clone_from_slice(col_vec);
    }
    outer_product_two_vecs(&scaled_vec, row_vec, res);
}
