use crate::flows::MpcSetupError;
use crate::phase2_circuit::{
    lagrange_coefficients, prepare_phase2_circuit, CircuitPreparationInput, CircuitSigmaArtifact,
    WirePolynomial,
};
use crate::protocol::{ContributionReceipt, Sha256Digest};
use crate::universal_tau::{MonomialLayout, UniversalTauArtifact};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::{DeviceVec, HostSlice};
use icicle_runtime::stream::IcicleStream;
use libs::errors::DeviceError;
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::{SetupParams, SubcircuitInfo};
use libs::r1cs::SubcircuitR1CS;
use libs::utils::{
    trusted_setup_ntt_domain_size, try_init_ntt_domain, try_setup_shape,
    try_validate_public_wire_size, try_validate_setup_shape,
};
use std::path::Path;

fn device_error(
    operation: &'static str,
) -> impl FnOnce(icicle_runtime::errors::eIcicleError) -> MpcSetupError {
    move |error| {
        MpcSetupError::Device(DeviceError::Initialization {
            device: "ICICLE phase-2 workspace",
            reason: format!("{operation}: {error}"),
        })
    }
}

struct NttWorkspace {
    stream: IcicleStream,
    device: DeviceVec<ScalarField>,
    host: Vec<ScalarField>,
    capacity: usize,
}

impl NttWorkspace {
    fn new(capacity: usize) -> Result<Self, MpcSetupError> {
        let capacity = capacity.max(1);
        Ok(Self {
            stream: IcicleStream::create().map_err(device_error("create NTT stream"))?,
            device: DeviceVec::<ScalarField>::device_malloc(capacity)
                .map_err(device_error("allocate NTT workspace"))?,
            host: vec![ScalarField::zero(); capacity],
            capacity,
        })
    }

    fn ensure_capacity(&mut self, capacity: usize) -> Result<(), MpcSetupError> {
        if capacity <= self.capacity {
            return Ok(());
        }
        let new_capacity = capacity.next_power_of_two();
        self.device = DeviceVec::<ScalarField>::device_malloc(new_capacity)
            .map_err(device_error("grow NTT workspace"))?;
        self.host.resize(new_capacity, ScalarField::zero());
        self.capacity = new_capacity;
        Ok(())
    }

    fn inverse_rows_into(
        &mut self,
        input: &[ScalarField],
        row_count: usize,
        row_len: usize,
        out: &mut Vec<ScalarField>,
    ) -> Result<(), MpcSetupError> {
        let size = row_count * row_len;
        assert_eq!(input.len(), size);
        if size == 0 {
            out.clear();
            return Ok(());
        }
        self.ensure_capacity(size)?;
        if out.len() != size {
            out.resize(size, ScalarField::zero());
        }
        let mut config = NTTConfig::<ScalarField>::default();
        config.stream_handle = *self.stream;
        config.is_async = true;
        config.batch_size = row_count as i32;
        config.columns_batch = false;
        config.are_outputs_on_device = true;
        config.coset_gen = ScalarField::one();
        ntt::ntt(
            HostSlice::from_slice(input),
            NTTDir::kInverse,
            &config,
            &mut self.device[..size],
        )
        .map_err(device_error("run inverse NTT"))?;
        self.stream
            .synchronize()
            .map_err(device_error("synchronize NTT stream"))?;
        self.device[..size]
            .copy_to_host(HostSlice::from_mut_slice(out))
            .map_err(device_error("copy NTT output to host"))?;
        Ok(())
    }
}

impl Drop for NttWorkspace {
    fn drop(&mut self) {
        let _ = self.stream.destroy();
    }
}

struct ActiveCoeffMatrix {
    compact_by_local: Vec<usize>,
    coeffs: Vec<ScalarField>,
    row_len: usize,
}

impl ActiveCoeffMatrix {
    fn from_coeffs(
        active_wires: &[usize],
        coeffs: Vec<ScalarField>,
        local_wire_count: usize,
        row_len: usize,
    ) -> Self {
        let mut compact_by_local = vec![usize::MAX; local_wire_count];
        for (compact_idx, &local_idx) in active_wires.iter().enumerate() {
            compact_by_local[local_idx] = compact_idx;
        }
        Self {
            compact_by_local,
            coeffs,
            row_len,
        }
    }

    fn from_compact_eval_rows(
        compact_eval_rows: &[ScalarField],
        active_wires: &[usize],
        local_wire_count: usize,
        row_len: usize,
        ntt_workspace: &mut NttWorkspace,
    ) -> Result<Self, MpcSetupError> {
        let mut coeffs = Vec::new();
        ntt_workspace.inverse_rows_into(
            compact_eval_rows,
            active_wires.len(),
            row_len,
            &mut coeffs,
        )?;
        Ok(Self::from_coeffs(
            active_wires,
            coeffs,
            local_wire_count,
            row_len,
        ))
    }

    fn row(&self, local_idx: usize) -> Option<&[ScalarField]> {
        let compact_idx = *self.compact_by_local.get(local_idx)?;
        if compact_idx == usize::MAX {
            return None;
        }
        let start = compact_idx * self.row_len;
        Some(&self.coeffs[start..start + self.row_len])
    }
}

struct SubcircuitCoeffView {
    a: ActiveCoeffMatrix,
    b: ActiveCoeffMatrix,
    c: ActiveCoeffMatrix,
}

impl SubcircuitCoeffView {
    fn from_compact_r1cs(
        compact_r1cs: &SubcircuitR1CS,
        subcircuit_info: &SubcircuitInfo,
        row_len: usize,
        ntt_workspace: &mut NttWorkspace,
    ) -> Result<Self, MpcSetupError> {
        Ok(Self {
            a: ActiveCoeffMatrix::from_compact_eval_rows(
                &compact_r1cs.A_compact_col_mat,
                &compact_r1cs.A_active_wires,
                subcircuit_info.Nwires,
                row_len,
                ntt_workspace,
            )?,
            b: ActiveCoeffMatrix::from_compact_eval_rows(
                &compact_r1cs.B_compact_col_mat,
                &compact_r1cs.B_active_wires,
                subcircuit_info.Nwires,
                row_len,
                ntt_workspace,
            )?,
            c: ActiveCoeffMatrix::from_compact_eval_rows(
                &compact_r1cs.C_compact_col_mat,
                &compact_r1cs.C_active_wires,
                subcircuit_info.Nwires,
                row_len,
                ntt_workspace,
            )?,
        })
    }
}

fn load_coeff_view(
    source_path: &Path,
    setup_params: &SetupParams,
    subcircuit_info: &SubcircuitInfo,
    ntt_workspace: &mut NttWorkspace,
) -> Result<SubcircuitCoeffView, MpcSetupError> {
    let compact_r1cs =
        SubcircuitR1CS::from_r1cs_path(source_path.to_path_buf(), setup_params, subcircuit_info)
            .map_err(|source| MpcSetupError::Io {
                operation: "read subcircuit R1CS",
                path: source_path.to_path_buf(),
                source,
            })?;
    SubcircuitCoeffView::from_compact_r1cs(
        &compact_r1cs,
        subcircuit_info,
        setup_params.n,
        ntt_workspace,
    )
}

pub fn prepare_selected_phase1_from_qap(
    selected_phase1: &UniversalTauArtifact,
    phase1_receipts: &[ContributionReceipt],
    qap_path: &Path,
    circuit_digest: Sha256Digest,
) -> Result<CircuitSigmaArtifact, MpcSetupError> {
    let setup_path = qap_path.join("setupParams.json");
    let setup_params =
        SetupParams::read_from_json(setup_path.clone()).map_err(|source| MpcSetupError::Io {
            operation: "read setup parameters",
            path: setup_path.clone(),
            source,
        })?;
    let shape = try_setup_shape(&setup_params, &setup_path)?;
    try_validate_setup_shape(&shape, &setup_path)?;
    try_validate_public_wire_size(shape.l_free, &setup_path)?;
    let layout = MonomialLayout::derive(&shape).map_err(|error| MpcSetupError::State {
        phase: "phase-2 circuit preparation",
        reason: error.to_string(),
    })?;
    if layout != selected_phase1.layout {
        return Err(MpcSetupError::State {
            phase: "phase-2 circuit preparation",
            reason: "QAP setup shape differs from the selected Phase 1 layout".to_string(),
        });
    }
    try_init_ntt_domain(trusted_setup_ntt_domain_size(&shape))?;

    let subcircuit_path = qap_path.join("subcircuitInfo.json");
    let subcircuit_infos =
        SubcircuitInfo::read_box_from_json(subcircuit_path.clone()).map_err(|source| {
            MpcSetupError::Io {
                operation: "read subcircuit information",
                path: subcircuit_path,
                source,
            }
        })?;
    let global_wires_path = qap_path.join("globalWireList.json");
    let global_wires =
        read_global_wires(&global_wires_path).map_err(|source| MpcSetupError::Io {
            operation: "read global wire list",
            path: global_wires_path,
            source,
        })?;
    let public_layout = PublicWireLayout::derive(&setup_params, &global_wires, &subcircuit_infos)
        .map_err(|error| MpcSetupError::State {
        phase: "phase-2 circuit preparation",
        reason: format!("invalid public wire layout: {error}"),
    })?;

    let mut ntt_workspace = NttWorkspace::new(setup_params.n.max(1))?;
    let mut coefficient_views = Vec::with_capacity(subcircuit_infos.len());
    for (index, subcircuit_info) in subcircuit_infos.iter().enumerate() {
        coefficient_views.push(load_coeff_view(
            &qap_path.join(format!("r1cs/subcircuit{index}.r1cs")),
            &setup_params,
            subcircuit_info,
            &mut ntt_workspace,
        )?);
    }

    let mut wire_polynomials = (0..setup_params.m_D)
        .map(|_| WirePolynomial {
            alpha_abc_x_coefficients: std::array::from_fn(|_| {
                vec![ScalarField::zero(); setup_params.n]
            }),
        })
        .collect::<Vec<_>>();
    for (view, subcircuit_info) in coefficient_views.iter().zip(subcircuit_infos.iter()) {
        accumulate_component_rows(
            &view.a,
            &subcircuit_info.flattenMap,
            &mut wire_polynomials,
            0,
        )?;
        accumulate_component_rows(
            &view.b,
            &subcircuit_info.flattenMap,
            &mut wire_polynomials,
            1,
        )?;
        accumulate_component_rows(
            &view.c,
            &subcircuit_info.flattenMap,
            &mut wire_polynomials,
            2,
        )?;
    }

    let public_placement_phases = (0..setup_params.l)
        .map(|index| public_layout.placement_phase_for_public_wire(index))
        .collect::<Vec<_>>();
    let free_lagrange = if setup_params.l_free == 0 {
        Vec::new()
    } else {
        lagrange_coefficients(setup_params.l_free).map_err(|error| MpcSetupError::State {
            phase: "phase-2 circuit preparation",
            reason: error.to_string(),
        })?
    };
    let public_m_x_coefficients = (0..setup_params.l)
        .map(|index| {
            if public_layout.is_free_public_index(index) {
                free_lagrange[index].clone()
            } else {
                Vec::new()
            }
        })
        .collect::<Vec<_>>();
    let intermediate_k_x_coefficients =
        lagrange_coefficients(shape.m_i).map_err(|error| MpcSetupError::State {
            phase: "phase-2 circuit preparation",
            reason: error.to_string(),
        })?;

    prepare_phase2_circuit(
        selected_phase1,
        phase1_receipts,
        &CircuitPreparationInput {
            circuit_digest,
            wire_polynomials,
            public_placement_phases,
            public_m_x_coefficients,
            intermediate_k_x_coefficients,
        },
    )
    .map_err(|error| MpcSetupError::State {
        phase: "phase-2 circuit preparation",
        reason: error.to_string(),
    })
}

fn accumulate_component_rows(
    matrix: &ActiveCoeffMatrix,
    flatten_map: &[usize],
    wire_polynomials: &mut [WirePolynomial],
    component: usize,
) -> Result<(), MpcSetupError> {
    for (local_index, global_index) in flatten_map.iter().copied().enumerate() {
        let Some(coefficients) = matrix.row(local_index) else {
            continue;
        };
        let target =
            wire_polynomials
                .get_mut(global_index)
                .ok_or_else(|| MpcSetupError::State {
                    phase: "phase-2 circuit preparation",
                    reason: format!("flattenMap references absent global wire {global_index}"),
                })?;
        if coefficients.len() != target.alpha_abc_x_coefficients[component].len() {
            return Err(MpcSetupError::State {
                phase: "phase-2 circuit preparation",
                reason: "R1CS coefficient row length differs from n".to_string(),
            });
        }
        for (slot, coefficient) in target.alpha_abc_x_coefficients[component]
            .iter_mut()
            .zip(coefficients)
        {
            *slot = *slot + *coefficient;
        }
    }
    Ok(())
}
