use crate::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use crate::frontend_artifacts::{
    read_global_wire_list_as_boxed_boxed_numbers, HexString, PlacementVariables, SetupParams,
    SubcircuitInfo,
};
use crate::polynomial_structures::{from_subcircuit_to_QAP, QAP};
use crate::vector_operations::{matrix_matrix_mul, transpose_inplace};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::HostSlice;
use std::collections::HashSet;
use std::env;
use std::fs::File;
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub struct SubcircuitR1CS {
    pub A_compact_col_mat: Vec<ScalarField>,
    pub B_compact_col_mat: Vec<ScalarField>,
    pub C_compact_col_mat: Vec<ScalarField>,
    pub A_active_wires: Vec<usize>,
    pub B_active_wires: Vec<usize>,
    pub C_active_wires: Vec<usize>,
    // Sparse rows for CPU evaluation: row -> list of (compact_idx, coeff)
    pub A_sparse_rows: Vec<Vec<(usize, ScalarField)>>,
    pub B_sparse_rows: Vec<Vec<(usize, ScalarField)>>,
    pub C_sparse_rows: Vec<Vec<(usize, ScalarField)>>,
}

struct R1csBinary {
    data: Vec<u8>,
    constraints_offset: usize,
    constraints_size: usize,
    field_size: usize,
    n_wires: usize,
    n_constraints: usize,
}

impl R1csBinary {
    fn read(path: PathBuf) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;

        let mut offset = 0usize;
        let magic = read_bytes(&data, &mut offset, 4)?;
        if magic != b"r1cs" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid R1CS magic",
            ));
        }
        let version = read_u32_le(&data, &mut offset)?;
        if version != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unsupported R1CS version {version}"),
            ));
        }
        let section_count = read_u32_le(&data, &mut offset)? as usize;

        let mut header_offset = None;
        let mut header_size = 0usize;
        let mut constraints_offset = None;
        let mut constraints_size = 0usize;

        for _ in 0..section_count {
            let section_type = read_u32_le(&data, &mut offset)?;
            let section_size = read_u64_le(&data, &mut offset)? as usize;
            let section_offset = offset;
            let section_end = section_offset.checked_add(section_size).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "R1CS section size overflow")
            })?;
            if section_end > data.len() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "R1CS section extends past end of file",
                ));
            }

            match section_type {
                1 => {
                    header_offset = Some(section_offset);
                    header_size = section_size;
                }
                2 => {
                    constraints_offset = Some(section_offset);
                    constraints_size = section_size;
                }
                _ => {}
            }
            offset = section_end;
        }

        let header_offset = header_offset.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "missing R1CS header section")
        })?;
        let constraints_offset = constraints_offset.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "missing R1CS constraints section",
            )
        })?;

        let header_end = header_offset + header_size;
        let mut header_cursor = header_offset;
        let field_size = read_u32_le(&data, &mut header_cursor)? as usize;
        if field_size == 0 || field_size % 8 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid R1CS field size {field_size}"),
            ));
        }
        let _prime = read_bytes(&data, &mut header_cursor, field_size)?;
        let n_wires = read_u32_le(&data, &mut header_cursor)? as usize;
        let _n_pub_out = read_u32_le(&data, &mut header_cursor)?;
        let _n_pub_in = read_u32_le(&data, &mut header_cursor)?;
        let _n_prv_in = read_u32_le(&data, &mut header_cursor)?;
        let _n_labels = read_u64_le(&data, &mut header_cursor)?;
        let n_constraints = read_u32_le(&data, &mut header_cursor)? as usize;
        if header_cursor > header_end {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "R1CS header extends past section end",
            ));
        }

        Ok(Self {
            data,
            constraints_offset,
            constraints_size,
            field_size,
            n_wires,
            n_constraints,
        })
    }

    fn scan_constraints<F>(&self, mut visit: F) -> io::Result<()>
    where
        F: FnMut(usize, usize, ScalarField, usize),
    {
        let mut offset = self.constraints_offset;
        let constraints_end = self.constraints_offset + self.constraints_size;

        for row_idx in 0..self.n_constraints {
            for matrix_idx in 0..3 {
                let entry_count = read_u32_le(&self.data, &mut offset)? as usize;
                for _ in 0..entry_count {
                    let wire_idx = read_u32_le(&self.data, &mut offset)? as usize;
                    if wire_idx >= self.n_wires {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("R1CS wire index {wire_idx} exceeds nWires {}", self.n_wires),
                        ));
                    }
                    let coeff_bytes = read_bytes(&self.data, &mut offset, self.field_size)?;
                    let coeff = ScalarField::from_bytes_le(coeff_bytes);
                    visit(matrix_idx, wire_idx, coeff, row_idx);
                }
            }
        }

        if offset != constraints_end {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "R1CS constraints section has {} trailing bytes",
                    constraints_end.saturating_sub(offset)
                ),
            ));
        }

        Ok(())
    }
}

fn read_bytes<'a>(data: &'a [u8], offset: &mut usize, len: usize) -> io::Result<&'a [u8]> {
    let end = offset
        .checked_add(len)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "R1CS offset overflow"))?;
    if end > data.len() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "unexpected end of R1CS file",
        ));
    }
    let out = &data[*offset..end];
    *offset = end;
    Ok(out)
}

fn read_u32_le(data: &[u8], offset: &mut usize) -> io::Result<u32> {
    let bytes = read_bytes(data, offset, 4)?;
    Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
}

fn read_u64_le(data: &[u8], offset: &mut usize) -> io::Result<u64> {
    let bytes = read_bytes(data, offset, 8)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

impl SubcircuitR1CS {
    pub fn from_r1cs_path(
        path: PathBuf,
        setup_params: &SetupParams,
        subcircuit_info: &SubcircuitInfo,
    ) -> io::Result<Self> {
        Self::from_r1cs_with_mode(path, setup_params, subcircuit_info, true, false)
    }

    pub fn from_r1cs_sparse_only(
        path: PathBuf,
        setup_params: &SetupParams,
        subcircuit_info: &SubcircuitInfo,
    ) -> io::Result<Self> {
        Self::from_r1cs_with_mode(path, setup_params, subcircuit_info, false, true)
    }

    fn from_r1cs_with_mode(
        path: PathBuf,
        setup_params: &SetupParams,
        subcircuit_info: &SubcircuitInfo,
        include_compact_matrices: bool,
        include_sparse_rows: bool,
    ) -> io::Result<Self> {
        let phase_profile = env::var("TOKAMAK_UVWXY_PHASE_PROFILE").ok().as_deref() == Some("1");
        let total_start = phase_profile.then(Instant::now);

        let read_binary_start = phase_profile.then(Instant::now);
        let binary = R1csBinary::read(path)?;
        if let Some(start) = read_binary_start {
            print_r1cs_binary_phase(
                subcircuit_info.id,
                "read_binary",
                start.elapsed().as_nanos(),
            );
        }

        if binary.n_wires != subcircuit_info.Nwires {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "R1CS nWires mismatch for subcircuit {}: binary={}, info={}",
                    subcircuit_info.id, binary.n_wires, subcircuit_info.Nwires
                ),
            ));
        }
        if binary.n_constraints != subcircuit_info.Nconsts {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "R1CS nConstraints mismatch for subcircuit {}: binary={}, info={}",
                    subcircuit_info.id, binary.n_constraints, subcircuit_info.Nconsts
                ),
            ));
        }
        if setup_params.n < subcircuit_info.Nconsts {
            panic!("n is smaller than the actual number of constraints.");
        }

        let active_wire_scan_start = phase_profile.then(Instant::now);
        let mut active_sets = [
            HashSet::<usize>::new(),
            HashSet::<usize>::new(),
            HashSet::<usize>::new(),
        ];
        binary.scan_constraints(|matrix_idx, wire_idx, _coeff, _row_idx| {
            active_sets[matrix_idx].insert(wire_idx);
        })?;
        if let Some(start) = active_wire_scan_start {
            print_r1cs_binary_phase(
                subcircuit_info.id,
                "active_wire_scan",
                start.elapsed().as_nanos(),
            );
        }

        let active_wire_sort_start = phase_profile.then(Instant::now);
        let mut A_active_wire_indices: Vec<usize> = active_sets[0].iter().copied().collect();
        let mut B_active_wire_indices: Vec<usize> = active_sets[1].iter().copied().collect();
        let mut C_active_wire_indices: Vec<usize> = active_sets[2].iter().copied().collect();
        A_active_wire_indices.sort_unstable();
        B_active_wire_indices.sort_unstable();
        C_active_wire_indices.sort_unstable();
        if let Some(start) = active_wire_sort_start {
            print_r1cs_binary_phase(
                subcircuit_info.id,
                "active_wire_sort",
                start.elapsed().as_nanos(),
            );
        }

        let index_map_start = phase_profile.then(Instant::now);
        let mut a_index_map = vec![usize::MAX; subcircuit_info.Nwires];
        for (i, &wire_idx) in A_active_wire_indices.iter().enumerate() {
            a_index_map[wire_idx] = i;
        }
        let mut b_index_map = vec![usize::MAX; subcircuit_info.Nwires];
        for (i, &wire_idx) in B_active_wire_indices.iter().enumerate() {
            b_index_map[wire_idx] = i;
        }
        let mut c_index_map = vec![usize::MAX; subcircuit_info.Nwires];
        for (i, &wire_idx) in C_active_wire_indices.iter().enumerate() {
            c_index_map[wire_idx] = i;
        }
        let index_maps = [a_index_map, b_index_map, c_index_map];
        if let Some(start) = index_map_start {
            print_r1cs_binary_phase(
                subcircuit_info.id,
                "compact_index_maps",
                start.elapsed().as_nanos(),
            );
        }

        let alloc_sparse_start = phase_profile.then(Instant::now);
        let n = setup_params.n;
        let A_len = A_active_wire_indices.len();
        let B_len = B_active_wire_indices.len();
        let C_len = C_active_wire_indices.len();
        let mut A_compact_col_mat = if include_compact_matrices {
            vec![ScalarField::zero(); n * A_len]
        } else {
            Vec::new()
        };
        let mut B_compact_col_mat = if include_compact_matrices {
            vec![ScalarField::zero(); n * B_len]
        } else {
            Vec::new()
        };
        let mut C_compact_col_mat = if include_compact_matrices {
            vec![ScalarField::zero(); n * C_len]
        } else {
            Vec::new()
        };
        let mut sparse_rows = if include_sparse_rows {
            [
                vec![Vec::new(); n],
                vec![Vec::new(); n],
                vec![Vec::new(); n],
            ]
        } else {
            [Vec::new(), Vec::new(), Vec::new()]
        };
        if let Some(start) = alloc_sparse_start {
            print_r1cs_binary_phase(
                subcircuit_info.id,
                "alloc_sparse_rows",
                start.elapsed().as_nanos(),
            );
        }

        let fill_sparse_start = phase_profile.then(Instant::now);
        binary.scan_constraints(|matrix_idx, wire_idx, coeff, row_idx| {
            let compact_idx = index_maps[matrix_idx][wire_idx];
            if compact_idx != usize::MAX {
                if include_compact_matrices {
                    match matrix_idx {
                        0 => A_compact_col_mat[A_len * row_idx + compact_idx] = coeff,
                        1 => B_compact_col_mat[B_len * row_idx + compact_idx] = coeff,
                        2 => C_compact_col_mat[C_len * row_idx + compact_idx] = coeff,
                        _ => unreachable!(),
                    }
                }
                if include_sparse_rows {
                    sparse_rows[matrix_idx][row_idx].push((compact_idx, coeff));
                }
            }
        })?;
        if include_sparse_rows {
            for matrix_rows in sparse_rows.iter_mut() {
                for row in matrix_rows.iter_mut() {
                    row.sort_unstable_by_key(|(compact_idx, _)| *compact_idx);
                }
            }
        }
        if let Some(start) = fill_sparse_start {
            print_r1cs_binary_phase(
                subcircuit_info.id,
                "fill_sparse_rows",
                start.elapsed().as_nanos(),
            );
        }

        if include_compact_matrices {
            let transpose_compact_start = phase_profile.then(Instant::now);
            transpose_inplace(&mut A_compact_col_mat, n, A_len);
            transpose_inplace(&mut B_compact_col_mat, n, B_len);
            transpose_inplace(&mut C_compact_col_mat, n, C_len);
            if let Some(start) = transpose_compact_start {
                print_r1cs_binary_phase(
                    subcircuit_info.id,
                    "transpose_compact",
                    start.elapsed().as_nanos(),
                );
            }
        }

        if let Some(start) = total_start {
            print_r1cs_binary_phase(subcircuit_info.id, "total", start.elapsed().as_nanos());
        }

        Ok(Self {
            A_compact_col_mat,
            B_compact_col_mat,
            C_compact_col_mat,
            A_active_wires: A_active_wire_indices,
            B_active_wires: B_active_wire_indices,
            C_active_wires: C_active_wire_indices,
            A_sparse_rows: std::mem::take(&mut sparse_rows[0]),
            B_sparse_rows: std::mem::take(&mut sparse_rows[1]),
            C_sparse_rows: std::mem::take(&mut sparse_rows[2]),
        })
    }
}

fn print_r1cs_binary_phase(subcircuit_id: usize, name: &str, nanos: u128) {
    println!("r1cs_binary.phase subcircuit={subcircuit_id} name={name} nanos={nanos}");
}

impl QAP {
    pub fn gen_from_R1CS(
        qap_path: &PathBuf,
        subcircuit_infos: &Box<[SubcircuitInfo]>,
        setup_params: &SetupParams,
    ) -> Self {
        let m_d = setup_params.m_D;
        let s_d = setup_params.s_D;

        let global_wire_list_path = qap_path.join("globalWireList.json");
        let global_wire_list =
            read_global_wire_list_as_boxed_boxed_numbers(global_wire_list_path).unwrap();

        let zero_poly = DensePolynomialExt::zero();
        let mut u_j_X = vec![zero_poly.clone(); m_d];
        let mut v_j_X = vec![zero_poly.clone(); m_d];
        let mut w_j_X = vec![zero_poly.clone(); m_d];

        for i in 0..s_d {
            println!("Processing subcircuit id {}", i);

            let r1cs_path = qap_path.join(format!("r1cs/subcircuit{i}.r1cs"));
            let compact_r1cs =
                SubcircuitR1CS::from_r1cs_path(r1cs_path, &setup_params, &subcircuit_infos[i])
                    .unwrap();
            let (u_j_X_local, v_j_X_local, w_j_X_local) =
                from_subcircuit_to_QAP(&compact_r1cs, &setup_params, &subcircuit_infos[i]);

            // Map local wire indices to global wire indices
            let flatten_map = &subcircuit_infos[i].flattenMap;

            for local_idx in 0..subcircuit_infos[i].Nwires {
                let global_idx = flatten_map[local_idx];

                // Verify global wire list consistency with flatten map
                if (global_wire_list[global_idx][0] != subcircuit_infos[i].id)
                    || (global_wire_list[global_idx][1] != local_idx)
                {
                    panic!("GlobalWireList is not the inverse of flattenMap.");
                }

                u_j_X[global_idx] = u_j_X_local[local_idx].clone();
                v_j_X[global_idx] = v_j_X_local[local_idx].clone();
                w_j_X[global_idx] = w_j_X_local[local_idx].clone();
            }
        }
        return Self {
            u_j_X,
            v_j_X,
            w_j_X,
        };
    }
}

pub fn read_R1CS_gen_uvwXY(
    qap_path: &str,
    placement_variables: &Box<[PlacementVariables]>,
    subcircuit_infos: &Box<[SubcircuitInfo]>,
    setup_params: &SetupParams,
) -> (DensePolynomialExt, DensePolynomialExt, DensePolynomialExt) {
    let phase_profile = env::var("TOKAMAK_UVWXY_PHASE_PROFILE").ok().as_deref() == Some("1");
    let uvwxy_total_start = phase_profile.then(Instant::now);

    let n = setup_params.n;
    let s_max = setup_params.s_max;

    let alloc_start = phase_profile.then(Instant::now);
    let mut u_eval = vec![ScalarField::zero(); s_max * n];
    let mut v_eval = vec![ScalarField::zero(); s_max * n];
    let mut w_eval = vec![ScalarField::zero(); s_max * n];
    if let Some(start) = alloc_start {
        print_uvwxy_phase("alloc_eval_buffers", start.elapsed().as_nanos());
    }

    let usage_scan_start = phase_profile.then(Instant::now);
    if placement_variables.len() > s_max {
        panic!("placement_variables length exceeds s_max.");
    }

    // Collect usage stats and placement indices per subcircuit
    let mut usage_counts = vec![0usize; subcircuit_infos.len()];
    let mut unique_ids = HashSet::<usize>::new();
    let mut indices_by_subcircuit: Vec<Vec<usize>> = vec![Vec::new(); subcircuit_infos.len()];
    for (i, placement) in placement_variables.iter().enumerate() {
        let subcircuit_id = placement.subcircuitId;
        if subcircuit_id >= subcircuit_infos.len() {
            panic!("Invalid subcircuit id in placement_variables.");
        }
        usage_counts[subcircuit_id] += 1;
        unique_ids.insert(subcircuit_id);
        indices_by_subcircuit[subcircuit_id].push(i);
    }
    if let Some(start) = usage_scan_start {
        print_uvwxy_phase("usage_scan", start.elapsed().as_nanos());
    }

    // Preload all unique subcircuit R1CS (no incremental cache)
    let r1cs_preload_start = phase_profile.then(Instant::now);
    let mut r1cs_by_id: Vec<Option<SubcircuitR1CS>> =
        (0..subcircuit_infos.len()).map(|_| None).collect();
    for &subcircuit_id in unique_ids.iter() {
        let binary_r1cs_path =
            PathBuf::from(qap_path).join(format!("r1cs/subcircuit{subcircuit_id}.r1cs"));
        let loaded_r1cs = SubcircuitR1CS::from_r1cs_sparse_only(
            binary_r1cs_path.clone(),
            &setup_params,
            &subcircuit_infos[subcircuit_id],
        )
        .unwrap_or_else(|err| {
            panic!(
                "failed to load required binary R1CS file {}: {err}",
                binary_r1cs_path.display()
            )
        });
        r1cs_by_id[subcircuit_id] = Some(loaded_r1cs);
    }
    if let Some(start) = r1cs_preload_start {
        print_uvwxy_phase("r1cs_preload_sparse", start.elapsed().as_nanos());
    }

    println!("Using sparse R1CS uvwXY generation.");

    let sparse_eval_start = phase_profile.then(Instant::now);
    eval_uvwxy_sparse_rows(
        placement_variables,
        &r1cs_by_id,
        &usage_counts,
        n,
        &mut u_eval,
        &mut v_eval,
        &mut w_eval,
    );
    if let Some(start) = sparse_eval_start {
        print_uvwxy_phase("sparse_eval_cpu_rayon", start.elapsed().as_nanos());
    }

    let usage_report_start = phase_profile.then(Instant::now);
    let unique_subcircuits = unique_ids.len();
    let total_subcircuit_uses = placement_variables.len();
    println!(
        "📊 Subcircuit uses: {} unique, {} total",
        unique_subcircuits, total_subcircuit_uses
    );
    for (subcircuit_id, &count) in usage_counts.iter().enumerate() {
        if count > 0 {
            println!("  📋 Subcircuit {} used {} times", subcircuit_id, count);
        }
    }
    if let Some(start) = usage_report_start {
        print_uvwxy_phase("usage_report_stdout", start.elapsed().as_nanos());
    }

    let transpose_start = phase_profile.then(Instant::now);
    transpose_inplace(&mut u_eval, s_max, n);
    transpose_inplace(&mut v_eval, s_max, n);
    transpose_inplace(&mut w_eval, s_max, n);
    if let Some(start) = transpose_start {
        print_uvwxy_phase("transpose_cpu", start.elapsed().as_nanos());
    }

    let from_rou_evals_start = phase_profile.then(Instant::now);
    let uXY =
        DensePolynomialExt::from_rou_evals(HostSlice::from_slice(&u_eval), n, s_max, None, None);
    let vXY =
        DensePolynomialExt::from_rou_evals(HostSlice::from_slice(&v_eval), n, s_max, None, None);
    let wXY =
        DensePolynomialExt::from_rou_evals(HostSlice::from_slice(&w_eval), n, s_max, None, None);
    if let Some(start) = from_rou_evals_start {
        print_uvwxy_phase("from_rou_evals_gpu_icicle", start.elapsed().as_nanos());
    }

    let cleanup_start = phase_profile.then(Instant::now);
    drop(u_eval);
    drop(v_eval);
    drop(w_eval);
    drop(r1cs_by_id);
    drop(indices_by_subcircuit);
    drop(unique_ids);
    drop(usage_counts);
    if let Some(start) = cleanup_start {
        print_uvwxy_phase("cleanup_local_buffers", start.elapsed().as_nanos());
    }
    if let Some(start) = uvwxy_total_start {
        print_uvwxy_phase("uvwxy_total_function", start.elapsed().as_nanos());
    }

    return (uXY, vXY, wXY);
}

fn print_uvwxy_phase(name: &str, nanos: u128) {
    println!("uvwXY.phase name={name} nanos={nanos}");
}

fn eval_uvwxy_sparse_rows(
    placement_variables: &Box<[PlacementVariables]>,
    r1cs_by_id: &[Option<SubcircuitR1CS>],
    usage_counts: &[usize],
    n: usize,
    u_eval: &mut [ScalarField],
    v_eval: &mut [ScalarField],
    w_eval: &mut [ScalarField],
) {
    use rayon::prelude::*;

    let profile_timers =
        (env::var("TOKAMAK_UVWXY_PROFILE").ok().as_deref() == Some("1")).then(|| {
            (
                (0..r1cs_by_id.len())
                    .map(|_| AtomicU64::new(0))
                    .collect::<Vec<_>>(),
                (0..r1cs_by_id.len())
                    .map(|_| AtomicU64::new(0))
                    .collect::<Vec<_>>(),
                (0..r1cs_by_id.len())
                    .map(|_| AtomicU64::new(0))
                    .collect::<Vec<_>>(),
            )
        });

    u_eval
        .par_chunks_mut(n)
        .zip(v_eval.par_chunks_mut(n))
        .zip(w_eval.par_chunks_mut(n))
        .zip(placement_variables.par_iter())
        .for_each(|(((u_chunk, v_chunk), w_chunk), placement)| {
            let subcircuit_id = placement.subcircuitId;
            let compact_r1cs = r1cs_by_id[subcircuit_id]
                .as_ref()
                .expect("R1CS for subcircuit id must be preloaded.");
            let variables = &placement.variables;

            let a_start = profile_timers.as_ref().map(|_| Instant::now());
            let d_vec_a = build_d_vec(variables, &compact_r1cs.A_active_wires);
            eval_sparse_rows(&d_vec_a, &compact_r1cs.A_sparse_rows, u_chunk);
            if let Some(start) = a_start {
                profile_timers.as_ref().unwrap().0[subcircuit_id]
                    .fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
            }

            let b_start = profile_timers.as_ref().map(|_| Instant::now());
            let d_vec_b = build_d_vec(variables, &compact_r1cs.B_active_wires);
            eval_sparse_rows(&d_vec_b, &compact_r1cs.B_sparse_rows, v_chunk);
            if let Some(start) = b_start {
                profile_timers.as_ref().unwrap().1[subcircuit_id]
                    .fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
            }

            let c_start = profile_timers.as_ref().map(|_| Instant::now());
            let d_vec_c = build_d_vec(variables, &compact_r1cs.C_active_wires);
            eval_sparse_rows(&d_vec_c, &compact_r1cs.C_sparse_rows, w_chunk);
            if let Some(start) = c_start {
                profile_timers.as_ref().unwrap().2[subcircuit_id]
                    .fetch_add(start.elapsed().as_nanos() as u64, Ordering::Relaxed);
            }
        });

    if let Some((a_nanos, b_nanos, c_nanos)) = profile_timers {
        for (subcircuit_id, compact_r1cs) in r1cs_by_id.iter().enumerate() {
            let Some(compact_r1cs) = compact_r1cs.as_ref() else {
                continue;
            };
            if usage_counts[subcircuit_id] == 0 {
                continue;
            }
            print_uvwxy_profile_row(
                subcircuit_id,
                "A",
                usage_counts[subcircuit_id],
                compact_r1cs.A_active_wires.len(),
                &compact_r1cs.A_sparse_rows,
                a_nanos[subcircuit_id].load(Ordering::Relaxed),
            );
            print_uvwxy_profile_row(
                subcircuit_id,
                "B",
                usage_counts[subcircuit_id],
                compact_r1cs.B_active_wires.len(),
                &compact_r1cs.B_sparse_rows,
                b_nanos[subcircuit_id].load(Ordering::Relaxed),
            );
            print_uvwxy_profile_row(
                subcircuit_id,
                "C",
                usage_counts[subcircuit_id],
                compact_r1cs.C_active_wires.len(),
                &compact_r1cs.C_sparse_rows,
                c_nanos[subcircuit_id].load(Ordering::Relaxed),
            );
        }
    }
}

fn print_uvwxy_profile_row(
    subcircuit_id: usize,
    matrix: &str,
    uses: usize,
    active_wires: usize,
    rows: &[Vec<(usize, ScalarField)>],
    nanos: u64,
) {
    let nonzero_rows = rows.iter().filter(|row| !row.is_empty()).count();
    let entries: usize = rows.iter().map(Vec::len).sum();
    println!(
        "uvwXY.profile subcircuit={subcircuit_id} matrix={matrix} uses={uses} active_wires={active_wires} nonzero_rows={nonzero_rows} entries={entries} nanos={nanos}"
    );
}

fn _from_r1cs_to_eval(
    variables: &Box<[String]>,
    compact_mat: &Vec<ScalarField>,
    active_wires: &Vec<usize>,
    i: usize,
    n: usize,
    eval: &mut Vec<ScalarField>,
) {
    let d_len_A = active_wires.len();
    if d_len_A > 0 {
        let mut d_vec = vec![ScalarField::zero(); d_len_A].into_boxed_slice();
        for (compact_idx, &local_idx) in active_wires.iter().enumerate() {
            d_vec[compact_idx] = ScalarField::from_hex(&variables[local_idx]);
        }
        let mut frag_eval = vec![ScalarField::zero(); n].into_boxed_slice();
        matrix_matrix_mul(&d_vec, compact_mat, 1, d_len_A, n, &mut frag_eval);
        eval[i * n..(i + 1) * n].clone_from_slice(&frag_eval);
    }
}

// without hex caching (direct parse)
fn _from_r1cs_to_eval_slice(
    variables: &Box<[HexString]>,
    compact_mat: &Vec<ScalarField>,
    active_wires: &Vec<usize>,
    eval_slice: &mut [ScalarField],
) {
    let d_len_A = active_wires.len();
    if d_len_A > 0 {
        let mut d_vec = Vec::with_capacity(d_len_A);

        for &local_idx in active_wires.iter() {
            let hex_str = &variables[local_idx];
            d_vec.push(ScalarField::from_hex(&hex_str.0));
        }

        let n = eval_slice.len();
        matrix_matrix_mul(&d_vec, compact_mat, 1, d_len_A, n, eval_slice);
    }
}

fn build_d_vec(variables: &Box<[HexString]>, active_wires: &Vec<usize>) -> Vec<ScalarField> {
    let mut d_vec = Vec::with_capacity(active_wires.len());
    for &local_idx in active_wires.iter() {
        let hex_str = &variables[local_idx];
        d_vec.push(ScalarField::from_hex(&hex_str.0));
    }
    d_vec
}

fn eval_sparse_rows(
    d_vec: &Vec<ScalarField>,
    rows: &Vec<Vec<(usize, ScalarField)>>,
    eval_slice: &mut [ScalarField],
) {
    eval_slice.fill(ScalarField::zero());
    for (row_idx, entries) in rows.iter().enumerate() {
        if entries.is_empty() {
            continue;
        }
        let mut acc = ScalarField::zero();
        for (col_idx, coeff) in entries.iter() {
            acc = acc + (*coeff * d_vec[*col_idx]);
        }
        if row_idx < eval_slice.len() {
            eval_slice[row_idx] = acc;
        }
    }
}

// More generic helper function for any FieldImpl
