use crate::conversions::{serialize_g1_affine, serialize_g2_affine};
use crate::protocol::{
    validate_state_selection, CeremonyState, CircuitSigma, ContributionReceipt, CurveGroup,
    PointChunkDescriptor, ProtocolError, Sha256Digest,
};
use crate::universal_tau::{MonomialLayout, UniversalTauArtifact, UniversalTauError};
use ark_serialize::Compress;
use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt;
use icicle_core::traits::{Arithmetic, FieldImpl};
use libs::group_structures::{G1serde, G2serde};
use rayon::prelude::*;
use thiserror::Error;

const POINTS_PER_CHUNK: usize = 1 << 16;

#[derive(Debug, Error)]
pub enum CircuitPreparationError {
    #[error("invalid selected Phase 1 state: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("invalid universal tau: {0}")]
    UniversalTau(#[from] UniversalTauError),
    #[error("invalid circuit preparation input: {0}")]
    InvalidInput(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct WirePolynomial {
    pub alpha_abc_x_coefficients: [Vec<ScalarField>; 3],
}

#[derive(Clone, Debug, PartialEq)]
pub struct CircuitPreparationInput {
    pub circuit_digest: Sha256Digest,
    pub wire_polynomials: Vec<WirePolynomial>,
    pub public_placement_phases: Vec<Option<usize>>,
    pub public_m_x_coefficients: Vec<Vec<ScalarField>>,
    pub intermediate_k_x_coefficients: Vec<Vec<ScalarField>>,
}

impl CircuitPreparationInput {
    fn validate(&self, layout: &MonomialLayout) -> Result<(), CircuitPreparationError> {
        Sha256Digest::parse(self.circuit_digest.as_str().to_string())?;
        let public_count = self.public_placement_phases.len();
        if self.public_m_x_coefficients.len() != public_count {
            return invalid("public M-polynomial count differs from public wire count");
        }
        if self.intermediate_k_x_coefficients.len() != layout.m_i {
            return invalid("K-polynomial count differs from m_i");
        }
        if self.wire_polynomials.len() < public_count + layout.m_i {
            return invalid("wire polynomial list omits public or intermediate wires");
        }
        for wire in &self.wire_polynomials {
            if wire
                .alpha_abc_x_coefficients
                .iter()
                .any(|coefficients| coefficients.len() != layout.n)
            {
                return invalid("every A/B/C wire polynomial must contain exactly n coefficients");
            }
        }
        if self
            .public_placement_phases
            .iter()
            .flatten()
            .any(|phase| *phase >= layout.s)
        {
            return invalid("public placement phase is outside the Y domain");
        }
        if self
            .public_m_x_coefficients
            .iter()
            .any(|coefficients| coefficients.len() > layout.x_grid_len)
        {
            return invalid("public M polynomial exceeds the X grid");
        }
        if self
            .intermediate_k_x_coefficients
            .iter()
            .any(|coefficients| coefficients.len() != layout.m_i)
        {
            return invalid("every K polynomial must contain exactly m_i coefficients");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CircuitSigmaPoints {
    pub g1: G1serde,
    pub g2: G2serde,
    pub alpha_g2: Vec<G2serde>,
    pub x_g1: G1serde,
    pub x_g2: G2serde,
    pub y_g1: G1serde,
    pub y_g2: G2serde,
    pub gamma_g1: G1serde,
    pub gamma_g2: G2serde,
    pub delta_g1: G1serde,
    pub delta_g2: G2serde,
    pub eta_g1: G1serde,
    pub eta_g2: G2serde,
    pub xy_powers: Vec<G1serde>,
    pub gamma_inv_o_inst: Vec<G1serde>,
    pub eta_inv_li_o_inter_alpha4_kj: Vec<G1serde>,
    pub delta_inv_li_o_prv: Vec<G1serde>,
    pub private_wire_count: usize,
    pub delta_inv_alphak_xh_tx: Vec<G1serde>,
    pub delta_inv_alpha4_xj_tx: Vec<G1serde>,
    pub delta_inv_alphak_yi_ty: Vec<G1serde>,
    pub lagrange_kl: G1serde,
}

#[derive(Clone, Debug)]
pub struct CircuitSigmaArtifact {
    pub layout: MonomialLayout,
    pub points: CircuitSigmaPoints,
    pub state: CeremonyState,
}

pub fn prepare_phase2_circuit(
    selected_phase1: &UniversalTauArtifact,
    phase1_receipts: &[ContributionReceipt],
    input: &CircuitPreparationInput,
) -> Result<CircuitSigmaArtifact, CircuitPreparationError> {
    validate_state_selection(&selected_phase1.state, phase1_receipts)?;
    selected_phase1
        .points
        .validate_shapes(&selected_phase1.layout)?;
    if selected_phase1.state.layout_digest != selected_phase1.layout.digest()?
        || selected_phase1.state.payload
            != crate::protocol::PhasePayload::Phase1(
                selected_phase1
                    .points
                    .protocol_payload(&selected_phase1.layout)?,
            )
    {
        return invalid("selected Phase 1 point payload differs from its state manifest");
    }
    input.validate(&selected_phase1.layout)?;
    let y_lagrange = lagrange_coefficients(selected_phase1.layout.s)?;
    let x_m_i_lagrange = lagrange_coefficients(selected_phase1.layout.m_i)?;
    let points = construct_sigma_points(
        &selected_phase1.points,
        &selected_phase1.layout,
        input,
        &y_lagrange,
        &x_m_i_lagrange,
    )?;
    let payload = points.protocol_payload(&selected_phase1.layout)?;
    let state = CeremonyState::new_phase2_prepared(
        &selected_phase1.state,
        input.circuit_digest.clone(),
        payload,
    )?;
    Ok(CircuitSigmaArtifact {
        layout: selected_phase1.layout.clone(),
        points,
        state,
    })
}

fn construct_sigma_points(
    tau: &crate::universal_tau::UniversalTauPoints,
    layout: &MonomialLayout,
    input: &CircuitPreparationInput,
    y_lagrange: &[Vec<ScalarField>],
    x_m_i_lagrange: &[Vec<ScalarField>],
) -> Result<CircuitSigmaPoints, CircuitPreparationError> {
    let public_count = input.public_placement_phases.len();
    let private_start = public_count + layout.m_i;
    let private_wire_count = input.wire_polynomials.len() - private_start;

    let wire_by_phase = |wire: &WirePolynomial, phase: usize| {
        encode_wire_with_y_lagrange(tau, layout, wire, &y_lagrange[phase])
    };
    let gamma_inv_o_inst = input
        .wire_polynomials
        .iter()
        .take(public_count)
        .zip(input.public_placement_phases.iter())
        .zip(input.public_m_x_coefficients.iter())
        .map(|((wire, placement), m_coefficients)| {
            let placed = placement
                .map(|phase| wire_by_phase(wire, phase))
                .unwrap_or_else(G1serde::zero);
            placed + msm_g1(&tau.x_g1[..m_coefficients.len()], m_coefficients)
        })
        .collect();

    let mut eta_inv_li_o_inter_alpha4_kj =
        Vec::with_capacity(layout.m_i.checked_mul(layout.s).ok_or_else(|| {
            CircuitPreparationError::InvalidInput("intermediate matrix overflow".to_string())
        })?);
    for (wire, k_coefficients) in input.wire_polynomials[public_count..private_start]
        .iter()
        .zip(input.intermediate_k_x_coefficients.iter())
    {
        for y_coefficients in y_lagrange {
            eta_inv_li_o_inter_alpha4_kj.push(
                encode_wire_with_y_lagrange(tau, layout, wire, y_coefficients)
                    + encode_alpha4_k_with_y_lagrange(tau, k_coefficients, y_coefficients),
            );
        }
    }

    let mut delta_inv_li_o_prv =
        Vec::with_capacity(private_wire_count.checked_mul(layout.s).ok_or_else(|| {
            CircuitPreparationError::InvalidInput("private matrix overflow".to_string())
        })?);
    for wire in &input.wire_polynomials[private_start..] {
        for y_coefficients in y_lagrange {
            delta_inv_li_o_prv.push(encode_wire_with_y_lagrange(
                tau,
                layout,
                wire,
                y_coefficients,
            ));
        }
    }

    let mut delta_inv_alphak_xh_tx = Vec::with_capacity(9);
    for k in 1..=3 {
        for h in 0..=2 {
            delta_inv_alphak_xh_tx.push(
                tau.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1) + layout.n + h]
                    - tau.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1) + h],
            );
        }
    }
    let mut delta_inv_alpha4_xj_tx = Vec::with_capacity(2);
    for j in 0..=1 {
        delta_inv_alpha4_xj_tx.push(
            tau.alpha_x_g1[3 * (layout.alpha_x_max + 1) + layout.m_i + j]
                - tau.alpha_x_g1[3 * (layout.alpha_x_max + 1) + j],
        );
    }
    let mut delta_inv_alphak_yi_ty = Vec::with_capacity(12);
    for k in 1..=4 {
        for i in 0..=2 {
            delta_inv_alphak_yi_ty.push(
                tau.alpha_y_g1[(k - 1) * (layout.alpha_y_max + 1) + layout.s + i]
                    - tau.alpha_y_g1[(k - 1) * (layout.alpha_y_max + 1) + i],
            );
        }
    }
    let last_x_lagrange = &x_m_i_lagrange[layout.m_i - 1];
    let last_y_lagrange = &y_lagrange[layout.s - 1];
    let lagrange_kl = msm_tensor2(
        &tau.xy_g1,
        layout.y_grid_len,
        last_x_lagrange,
        last_y_lagrange,
    );

    Ok(CircuitSigmaPoints {
        g1: tau.g1,
        g2: tau.g2,
        alpha_g2: tau.alpha_g2[1..=4].to_vec(),
        x_g1: tau.x_g1[1],
        x_g2: tau.x_g2[1],
        y_g1: tau.y_g1[1],
        y_g2: tau.y_g2[1],
        gamma_g1: tau.g1,
        gamma_g2: tau.g2,
        delta_g1: tau.g1,
        delta_g2: tau.g2,
        eta_g1: tau.g1,
        eta_g2: tau.g2,
        xy_powers: tau.xy_g1.clone(),
        gamma_inv_o_inst,
        eta_inv_li_o_inter_alpha4_kj,
        delta_inv_li_o_prv,
        private_wire_count,
        delta_inv_alphak_xh_tx,
        delta_inv_alpha4_xj_tx,
        delta_inv_alphak_yi_ty,
        lagrange_kl,
    })
}

fn encode_wire_with_y_lagrange(
    tau: &crate::universal_tau::UniversalTauPoints,
    layout: &MonomialLayout,
    wire: &WirePolynomial,
    y_coefficients: &[ScalarField],
) -> G1serde {
    let mut bases = Vec::with_capacity(3 * layout.n * layout.s);
    let mut scalars = Vec::with_capacity(3 * layout.n * layout.s);
    for k in 0..3 {
        for a in 0..layout.n {
            for (b, y_coefficient) in y_coefficients.iter().enumerate() {
                bases.push(tau.alpha_xy_abc_g1[(k * layout.n + a) * layout.s + b]);
                scalars.push(wire.alpha_abc_x_coefficients[k][a] * *y_coefficient);
            }
        }
    }
    msm_g1(&bases, &scalars)
}

fn encode_alpha4_k_with_y_lagrange(
    tau: &crate::universal_tau::UniversalTauPoints,
    k_coefficients: &[ScalarField],
    y_coefficients: &[ScalarField],
) -> G1serde {
    let scalars = k_coefficients
        .iter()
        .flat_map(|x| y_coefficients.iter().map(move |y| *x * *y))
        .collect::<Vec<_>>();
    msm_g1(&tau.alpha4_xy_k_g1, &scalars)
}

fn msm_tensor2(
    bases: &[G1serde],
    row_stride: usize,
    x_coefficients: &[ScalarField],
    y_coefficients: &[ScalarField],
) -> G1serde {
    let mut selected_bases = Vec::with_capacity(x_coefficients.len() * y_coefficients.len());
    let mut scalars = Vec::with_capacity(selected_bases.capacity());
    for (a, x) in x_coefficients.iter().enumerate() {
        for (b, y) in y_coefficients.iter().enumerate() {
            selected_bases.push(bases[a * row_stride + b]);
            scalars.push(*x * *y);
        }
    }
    msm_g1(&selected_bases, &scalars)
}

fn msm_g1(bases: &[G1serde], scalars: &[ScalarField]) -> G1serde {
    debug_assert_eq!(bases.len(), scalars.len());
    bases
        .par_iter()
        .zip(scalars.par_iter())
        .map(|(base, scalar)| *base * *scalar)
        .reduce(G1serde::zero, |left, right| left + right)
}

pub fn lagrange_coefficients(
    size: usize,
) -> Result<Vec<Vec<ScalarField>>, CircuitPreparationError> {
    if size == 0 || !size.is_power_of_two() {
        return invalid("Lagrange domain size must be a nonzero power of two");
    }
    let size_u32 = u32::try_from(size).map_err(|_| {
        CircuitPreparationError::InvalidInput("domain size exceeds u32".to_string())
    })?;
    let omega = ntt::get_root_of_unity::<ScalarField>(size as u64);
    let omega_inv = omega.inv();
    let inv_size = ScalarField::from_u32(size_u32).inv();
    let mut root_table = Vec::with_capacity(size);
    let mut current = ScalarField::one();
    for _ in 0..size {
        root_table.push(inv_size * current);
        current = current * omega_inv;
    }
    let mut rows = vec![vec![ScalarField::zero(); size]; size];
    for (row_index, row) in rows.iter_mut().enumerate() {
        let mut root_index = 0usize;
        for coefficient in row {
            *coefficient = root_table[root_index];
            root_index = (root_index + row_index) % size;
        }
    }
    Ok(rows)
}

impl CircuitSigmaPoints {
    pub fn protocol_payload(
        &self,
        layout: &MonomialLayout,
    ) -> Result<CircuitSigma, CircuitPreparationError> {
        let mut chunks = Vec::new();
        push_g1(&mut chunks, "generator", &[self.g1], vec![1])?;
        push_g2(&mut chunks, "generator", &[self.g2], vec![1])?;
        push_g2(&mut chunks, "alpha", &self.alpha_g2, vec![4])?;
        push_g1(
            &mut chunks,
            "directParameters",
            &[
                self.x_g1,
                self.y_g1,
                self.gamma_g1,
                self.delta_g1,
                self.eta_g1,
            ],
            vec![5],
        )?;
        push_g2(
            &mut chunks,
            "directParameters",
            &[
                self.x_g2,
                self.y_g2,
                self.gamma_g2,
                self.delta_g2,
                self.eta_g2,
            ],
            vec![5],
        )?;
        push_g1_rows(
            &mut chunks,
            "xyPowers",
            &self.xy_powers,
            layout.x_grid_len,
            layout.y_grid_len,
        )?;
        push_g1(
            &mut chunks,
            "gammaInvOInst",
            &self.gamma_inv_o_inst,
            vec![self.gamma_inv_o_inst.len()],
        )?;
        push_g1_rows(
            &mut chunks,
            "etaInvLiOInterAlpha4Kj",
            &self.eta_inv_li_o_inter_alpha4_kj,
            layout.m_i,
            layout.s,
        )?;
        push_g1_rows(
            &mut chunks,
            "deltaInvLiOPrv",
            &self.delta_inv_li_o_prv,
            self.private_wire_count,
            layout.s,
        )?;
        push_g1(
            &mut chunks,
            "deltaInvAlphaKXhTx",
            &self.delta_inv_alphak_xh_tx,
            vec![3, 3],
        )?;
        push_g1(
            &mut chunks,
            "deltaInvAlpha4XjTx",
            &self.delta_inv_alpha4_xj_tx,
            vec![2],
        )?;
        push_g1(
            &mut chunks,
            "deltaInvAlphaKYiTy",
            &self.delta_inv_alphak_yi_ty,
            vec![4, 3],
        )?;
        push_g1(&mut chunks, "lagrangeKL", &[self.lagrange_kl], vec![1])?;
        Ok(CircuitSigma { chunks })
    }
}

fn push_g1(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G1serde],
    shape: Vec<usize>,
) -> Result<(), CircuitPreparationError> {
    if points.is_empty() {
        return Ok(());
    }
    if points.len() <= POINTS_PER_CHUNK {
        let rank = shape.len();
        chunks.push(g1_descriptor(family, shape, vec![0; rank], points)?);
        return Ok(());
    }
    for start in (0..points.len()).step_by(POINTS_PER_CHUNK) {
        let end = (start + POINTS_PER_CHUNK).min(points.len());
        chunks.push(g1_descriptor(
            family,
            vec![end - start],
            vec![start],
            &points[start..end],
        )?);
    }
    Ok(())
}

fn push_g2(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G2serde],
    shape: Vec<usize>,
) -> Result<(), CircuitPreparationError> {
    let rank = shape.len();
    let bytes = points
        .iter()
        .flat_map(|point| serialize_g2_affine(&point.0, Compress::Yes).into_vec())
        .collect::<Vec<_>>();
    chunks.push(descriptor(
        family,
        CurveGroup::G2,
        shape,
        vec![0; rank],
        &bytes,
    )?);
    Ok(())
}

fn push_g1_rows(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G1serde],
    rows: usize,
    columns: usize,
) -> Result<(), CircuitPreparationError> {
    if rows == 0 {
        if !points.is_empty() {
            return invalid("zero-row point matrix is not empty");
        }
        return Ok(());
    }
    if points.len() != rows.checked_mul(columns).unwrap_or(usize::MAX) {
        return invalid("point matrix shape differs from its point count");
    }
    let rows_per_chunk = (POINTS_PER_CHUNK / columns).max(1);
    if columns <= POINTS_PER_CHUNK {
        for start_row in (0..rows).step_by(rows_per_chunk) {
            let end_row = (start_row + rows_per_chunk).min(rows);
            chunks.push(g1_descriptor(
                family,
                vec![end_row - start_row, columns],
                vec![start_row, 0],
                &points[start_row * columns..end_row * columns],
            )?);
        }
    } else {
        for row in 0..rows {
            for start_column in (0..columns).step_by(POINTS_PER_CHUNK) {
                let end_column = (start_column + POINTS_PER_CHUNK).min(columns);
                chunks.push(g1_descriptor(
                    family,
                    vec![1, end_column - start_column],
                    vec![row, start_column],
                    &points[row * columns + start_column..row * columns + end_column],
                )?);
            }
        }
    }
    Ok(())
}

fn g1_descriptor(
    family: &str,
    shape: Vec<usize>,
    starts: Vec<usize>,
    points: &[G1serde],
) -> Result<PointChunkDescriptor, CircuitPreparationError> {
    let bytes = points
        .iter()
        .flat_map(|point| serialize_g1_affine(&point.0, Compress::Yes).into_vec())
        .collect::<Vec<_>>();
    descriptor(family, CurveGroup::G1, shape, starts, &bytes)
}

fn descriptor(
    family: &str,
    group: CurveGroup,
    shape: Vec<usize>,
    starts: Vec<usize>,
    bytes: &[u8],
) -> Result<PointChunkDescriptor, CircuitPreparationError> {
    let shape = shape.into_iter().map(|value| value as u64).collect();
    let starts = starts.into_iter().map(|value| value as u64).collect();
    PointChunkDescriptor::from_bytes(family, group, shape, starts, bytes)
        .map_err(CircuitPreparationError::from)
}

fn invalid<T>(reason: impl Into<String>) -> Result<T, CircuitPreparationError> {
    Err(CircuitPreparationError::InvalidInput(reason.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contribution_kernel::SecretShares;
    use crate::phase1_contribution::contribute_phase1;
    use crate::protocol::{
        ContributionEntropyMode, ContributionProfile, StateStatus, TrapdoorParameter,
    };
    use icicle_core::traits::Arithmetic;
    use libs::utils::{try_init_ntt_domain, SetupShape};

    fn shape() -> SetupShape {
        SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        }
    }

    fn selected_phase1() -> crate::phase1_contribution::Phase1Contribution {
        try_init_ntt_domain(2).unwrap();
        let genesis = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        let shares = SecretShares::new(
            ContributionProfile::NativeAlphaXY,
            vec![
                (TrapdoorParameter::Alpha, ScalarField::from_u32(2)),
                (TrapdoorParameter::X, ScalarField::from_u32(3)),
                (TrapdoorParameter::Y, ScalarField::from_u32(5)),
            ],
        )
        .unwrap();
        contribute_phase1(&genesis, &shares, ContributionEntropyMode::Random).unwrap()
    }

    fn wire(a: [u32; 2], b: [u32; 2], c: [u32; 2]) -> WirePolynomial {
        WirePolynomial {
            alpha_abc_x_coefficients: [
                a.into_iter().map(ScalarField::from_u32).collect(),
                b.into_iter().map(ScalarField::from_u32).collect(),
                c.into_iter().map(ScalarField::from_u32).collect(),
            ],
        }
    }

    fn input() -> CircuitPreparationInput {
        CircuitPreparationInput {
            circuit_digest: Sha256Digest::parse(format!("sha256:{}", "1".repeat(64))).unwrap(),
            wire_polynomials: vec![
                wire([1, 2], [3, 4], [5, 6]),
                wire([2, 0], [0, 1], [1, 1]),
                wire([0, 1], [2, 2], [3, 0]),
                wire([4, 1], [0, 2], [1, 3]),
            ],
            public_placement_phases: vec![Some(0)],
            public_m_x_coefficients: vec![vec![ScalarField::one(), ScalarField::zero()]],
            intermediate_k_x_coefficients: vec![
                vec![ScalarField::one(), ScalarField::zero()],
                vec![ScalarField::zero(), ScalarField::one()],
            ],
        }
    }

    #[test]
    fn preparation_is_deterministic_and_binds_phase1_circuit_and_coefficients() {
        let selected = selected_phase1();
        let receipts = vec![selected.receipt.clone()];
        let first = prepare_phase2_circuit(&selected.artifact, &receipts, &input()).unwrap();
        let second = prepare_phase2_circuit(&selected.artifact, &receipts, &input()).unwrap();
        assert_eq!(first.state.status, StateStatus::Prepared);
        assert_eq!(
            first.state.digest().unwrap(),
            second.state.digest().unwrap()
        );
        assert_eq!(first.points, second.points);
        assert_eq!(first.points.gamma_g1, first.points.g1);
        assert_eq!(first.points.gamma_g2, first.points.g2);
        assert_eq!(first.points.delta_g1, first.points.g1);
        assert_eq!(first.points.eta_g2, first.points.g2);

        let mut changed_coefficients = input();
        changed_coefficients.wire_polynomials[0].alpha_abc_x_coefficients[0][0] =
            ScalarField::from_u32(9);
        let changed =
            prepare_phase2_circuit(&selected.artifact, &receipts, &changed_coefficients).unwrap();
        assert_ne!(
            first.state.digest().unwrap(),
            changed.state.digest().unwrap()
        );

        let mut changed_digest = input();
        changed_digest.circuit_digest =
            Sha256Digest::parse(format!("sha256:{}", "2".repeat(64))).unwrap();
        let changed =
            prepare_phase2_circuit(&selected.artifact, &receipts, &changed_digest).unwrap();
        assert_ne!(
            first.state.digest().unwrap(),
            changed.state.digest().unwrap()
        );
    }

    #[test]
    fn group_msm_matches_a_test_only_trusted_scalar_reference() {
        let selected = selected_phase1();
        let layout = &selected.artifact.layout;
        let lagrange = lagrange_coefficients(layout.s).unwrap();
        let wire = &input().wire_polynomials[0];
        let actual =
            encode_wire_with_y_lagrange(&selected.artifact.points, layout, wire, &lagrange[0]);
        let alpha = ScalarField::from_u32(2);
        let x = ScalarField::from_u32(3);
        let y = ScalarField::from_u32(5);
        let mut expected_scalar = ScalarField::zero();
        for k in 1..=3 {
            for a in 0..layout.n {
                for b in 0..layout.s {
                    expected_scalar = expected_scalar
                        + alpha.pow(k)
                            * x.pow(a)
                            * y.pow(b)
                            * wire.alpha_abc_x_coefficients[k - 1][a]
                            * lagrange[0][b];
                }
            }
        }
        assert_eq!(actual, selected.artifact.points.g1 * expected_scalar);
    }

    #[test]
    fn malformed_shapes_and_unselected_phase1_are_rejected() {
        let selected = selected_phase1();
        let mut malformed = input();
        malformed.wire_polynomials[0].alpha_abc_x_coefficients[0].pop();
        assert!(prepare_phase2_circuit(
            &selected.artifact,
            &[selected.receipt.clone()],
            &malformed,
        )
        .is_err());

        let genesis = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        assert!(prepare_phase2_circuit(&genesis, &[], &input()).is_err());
    }
}
