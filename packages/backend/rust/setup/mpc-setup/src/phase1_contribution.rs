use crate::contribution_kernel::{
    apply_and_self_verify, batch_challenge, create_proofs, scale_g1_family, scale_g2_family,
    verify_immutable_g1, verify_immutable_g2, verify_proofs, ContributionSpec, FamilyComponent,
    FamilyShape, KernelError, KernelProof, SecretShares,
};
use crate::conversions::{
    deserialize_g1serde, deserialize_g2serde, serialize_g1serde, serialize_g2serde,
};
use crate::protocol::{
    CeremonyState, ContributionEntropyMode, ContributionProfile, ContributionReceipt, EncodedPoint,
    Phase, PhasePayload, SecretContributionProof, Sha256Digest, StateStatus, TrapdoorParameter,
    CONTRACT_VERSION, PROTOCOL_VERSION,
};
use crate::universal_tau::{
    MonomialLayout, UniversalTauArtifact, UniversalTauError, UniversalTauPoints,
};
use crate::utils::same_ratio;
use ark_serialize::Compress;
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use libs::group_structures::{G1serde, G2serde};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Phase1ContributionError {
    #[error("invalid Phase 1 state or receipt: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("contribution kernel rejected the transition: {0}")]
    Kernel(#[from] KernelError),
    #[error("invalid universal tau: {0}")]
    UniversalTau(#[from] UniversalTauError),
    #[error("point proof encoding is invalid: {0}")]
    PointEncoding(String),
    #[error("Phase 1 contribution requires a compatible Phase 1 state")]
    InvalidPreviousState,
    #[error("state payload descriptors do not authenticate the supplied point payload")]
    PayloadManifestMismatch,
    #[error("contribution receipt does not authenticate the direct state transition")]
    ReceiptMismatch,
    #[error("contributed universal tau failed batched algebraic consistency checks")]
    AlgebraicConsistency,
    #[error("DuskY contribution modified an immutable adapted alpha/X component")]
    AdaptedBasisModified,
    #[error("DuskY contribution left y^s equal to the generator")]
    TrivialDuskYContribution,
}

#[derive(Clone, Debug)]
pub struct Phase1Contribution {
    pub artifact: UniversalTauArtifact,
    pub receipt: ContributionReceipt,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofTranscript<'a> {
    contract_version: u32,
    protocol_version: &'a str,
    ceremony_id: &'a str,
    phase: Phase,
    contribution_profile: ContributionProfile,
    previous_state_digest: &'a Sha256Digest,
    current_state_digest: &'a Sha256Digest,
    capacity_digest: &'a Sha256Digest,
    layout_digest: &'a Sha256Digest,
    circuit_digest: Option<&'a Sha256Digest>,
    contributor_index: u64,
    parameters: &'static [TrapdoorParameter],
}

pub fn contribute_phase1(
    previous: &UniversalTauArtifact,
    shares: &SecretShares,
    entropy_mode: ContributionEntropyMode,
) -> Result<Phase1Contribution, Phase1ContributionError> {
    validate_artifact(previous)?;
    if previous.state.phase != Phase::Phase1
        || previous.state.status == StateStatus::Contributed && previous.state.sequence == u64::MAX
    {
        return Err(Phase1ContributionError::InvalidPreviousState);
    }
    let profile = previous.state.contribution_profile;
    if !matches!(
        profile,
        ContributionProfile::NativeAlphaXY | ContributionProfile::DuskY
    ) {
        return Err(Phase1ContributionError::InvalidPreviousState);
    }
    let spec = ContributionSpec::for_profile(profile);
    let points = scale_phase1_points(&previous.points, &previous.layout, &spec, shares)?;
    let payload = points.protocol_payload(&previous.layout)?;
    let state = CeremonyState::next_contributed_phase1(&previous.state, payload)?;
    let previous_digest = previous.state.digest()?;
    let current_digest = state.digest()?;
    let transcript = proof_transcript(&previous.state, &state, &previous_digest, &current_digest)?;
    let kernel_proofs = create_proofs(shares, &transcript);
    let secret_proofs = kernel_proofs
        .iter()
        .map(encode_proof)
        .collect::<Result<Vec<_>, _>>()?;
    let receipt = ContributionReceipt::new(
        &previous.state,
        &state,
        entropy_mode,
        secret_proofs,
        Sha256Digest::from_bytes(&transcript),
    )?;
    let candidate = Phase1Contribution {
        artifact: UniversalTauArtifact {
            layout: previous.layout.clone(),
            points,
            state,
        },
        receipt,
    };
    apply_and_self_verify(
        || Ok(candidate),
        |candidate| verify_phase1_transition(previous, candidate).is_ok(),
    )
    .map(|verified| verified.into_inner())
    .map_err(Phase1ContributionError::Kernel)
}

pub fn verify_phase1_transition(
    previous: &UniversalTauArtifact,
    current: &Phase1Contribution,
) -> Result<(), Phase1ContributionError> {
    validate_artifact(previous)?;
    validate_artifact(&current.artifact)?;
    let expected_sequence = previous
        .state
        .sequence
        .checked_add(1)
        .ok_or(Phase1ContributionError::InvalidPreviousState)?;
    if current.artifact.layout != previous.layout
        || current.artifact.state.phase != Phase::Phase1
        || current.artifact.state.contribution_profile != previous.state.contribution_profile
        || current.artifact.state.sequence != expected_sequence
        || current.artifact.state.previous_state_digest.as_ref() != Some(&previous.state.digest()?)
        || current.artifact.state.status != StateStatus::Contributed
    {
        return Err(Phase1ContributionError::InvalidPreviousState);
    }
    let previous_digest = previous.state.digest()?;
    let current_digest = current.artifact.state.digest()?;
    let transcript = proof_transcript(
        &previous.state,
        &current.artifact.state,
        &previous_digest,
        &current_digest,
    )?;
    if current.receipt.ceremony_id != current.artifact.state.ceremony_id
        || current.receipt.phase != Phase::Phase1
        || current.receipt.contribution_profile != current.artifact.state.contribution_profile
        || current.receipt.contributor_index != current.artifact.state.sequence
        || current.receipt.previous_state_digest != previous_digest
        || current.receipt.current_state_digest != current_digest
        || current.receipt.verification_transcript_digest != Sha256Digest::from_bytes(&transcript)
    {
        return Err(Phase1ContributionError::ReceiptMismatch);
    }
    current.receipt.validate()?;
    let proofs = current
        .receipt
        .secret_proofs
        .iter()
        .map(decode_proof)
        .collect::<Result<Vec<_>, _>>()?;
    verify_proofs(
        current.artifact.state.contribution_profile,
        &proofs,
        &transcript,
    )?;
    verify_direct_share_updates(previous, &current.artifact, &proofs)?;

    if current.artifact.state.contribution_profile == ContributionProfile::DuskY {
        verify_dusk_immutability(&previous.points, &current.artifact.points)?;
        if current.artifact.points.y_g1[current.artifact.layout.s] == current.artifact.points.g1 {
            return Err(Phase1ContributionError::TrivialDuskYContribution);
        }
    }
    let challenge = batch_challenge(
        &previous_digest,
        &current_digest,
        b"tokamak-phase1-universal-tau-consistency-v1",
    );
    if !verify_universal_tau_consistency(&previous.points, &previous.layout, challenge)
        || !verify_universal_tau_consistency(
            &current.artifact.points,
            &current.artifact.layout,
            challenge,
        )
    {
        return Err(Phase1ContributionError::AlgebraicConsistency);
    }
    Ok(())
}

fn validate_artifact(artifact: &UniversalTauArtifact) -> Result<(), Phase1ContributionError> {
    artifact.state.validate()?;
    artifact.points.validate_shapes(&artifact.layout)?;
    if artifact.state.layout_digest != artifact.layout.digest()? {
        return Err(Phase1ContributionError::PayloadManifestMismatch);
    }
    let expected = artifact.points.protocol_payload(&artifact.layout)?;
    match &artifact.state.payload {
        PhasePayload::Phase1(actual) if actual == &expected => Ok(()),
        _ => Err(Phase1ContributionError::PayloadManifestMismatch),
    }
}

fn scale_phase1_points(
    previous: &UniversalTauPoints,
    layout: &MonomialLayout,
    spec: &ContributionSpec,
    shares: &SecretShares,
) -> Result<UniversalTauPoints, KernelError> {
    let mut current = previous.clone();
    let profile = spec.profile;
    if profile == ContributionProfile::NativeAlphaXY {
        current.alpha_g1 = scale_g1_family(
            spec,
            FamilyComponent::Alpha,
            &shape(&[layout.alpha_max + 1], &[0]),
            &previous.alpha_g1,
            shares,
        )?;
        current.alpha_g2 = scale_g2_family(
            spec,
            FamilyComponent::Alpha,
            &shape(&[layout.alpha_max + 1], &[0]),
            &previous.alpha_g2,
            shares,
        )?;
        current.x_g1 = scale_g1_family(
            spec,
            FamilyComponent::X,
            &shape(&[layout.x_grid_len], &[0]),
            &previous.x_g1,
            shares,
        )?;
        current.x_g2 = scale_g2_family(
            spec,
            FamilyComponent::X,
            &shape(&[2], &[0]),
            &previous.x_g2,
            shares,
        )?;
        current.alpha_x_g1 = scale_g1_family(
            spec,
            FamilyComponent::AlphaX,
            &shape(&[layout.alpha_max, layout.alpha_x_max + 1], &[1, 0]),
            &previous.alpha_x_g1,
            shares,
        )?;
    }
    current.y_g1 = scale_g1_family(
        spec,
        FamilyComponent::Y,
        &shape(&[layout.alpha_y_max + 1], &[0]),
        &previous.y_g1,
        shares,
    )?;
    current.y_g2 = scale_g2_family(
        spec,
        FamilyComponent::Y,
        &shape(&[2], &[0]),
        &previous.y_g2,
        shares,
    )?;
    current.alpha_y_g1 = scale_g1_family(
        spec,
        FamilyComponent::AlphaY,
        &shape(&[layout.alpha_max, layout.alpha_y_max + 1], &[1, 0]),
        &previous.alpha_y_g1,
        shares,
    )?;
    current.xy_g1 = scale_g1_family(
        spec,
        FamilyComponent::XY,
        &shape(&[layout.x_grid_len, layout.y_grid_len], &[0, 0]),
        &previous.xy_g1,
        shares,
    )?;
    current.alpha_xy_abc_g1 = scale_g1_family(
        spec,
        FamilyComponent::AlphaXYAbc,
        &shape(&[3, layout.n, layout.s], &[1, 0, 0]),
        &previous.alpha_xy_abc_g1,
        shares,
    )?;
    current.alpha4_xy_k_g1 = scale_g1_family(
        spec,
        FamilyComponent::Alpha4XYK,
        &shape(&[layout.m_i, layout.s], &[0, 0]),
        &previous.alpha4_xy_k_g1,
        shares,
    )?;
    Ok(current)
}

fn shape(dimensions: &[usize], origins: &[u32]) -> FamilyShape {
    FamilyShape::new(dimensions.to_vec(), origins.to_vec())
}

fn proof_transcript(
    previous: &CeremonyState,
    current: &CeremonyState,
    previous_digest: &Sha256Digest,
    current_digest: &Sha256Digest,
) -> Result<Vec<u8>, Phase1ContributionError> {
    serde_json::to_vec(&ProofTranscript {
        contract_version: CONTRACT_VERSION,
        protocol_version: PROTOCOL_VERSION,
        ceremony_id: &current.ceremony_id,
        phase: Phase::Phase1,
        contribution_profile: current.contribution_profile,
        previous_state_digest: previous_digest,
        current_state_digest: current_digest,
        capacity_digest: &current.capacity_digest,
        layout_digest: &current.layout_digest,
        circuit_digest: None,
        contributor_index: current.sequence,
        parameters: current.contribution_profile.parameters(),
    })
    .map_err(|error| Phase1ContributionError::PointEncoding(error.to_string()))
    .and_then(|bytes| {
        if previous.ceremony_id == current.ceremony_id {
            Ok(bytes)
        } else {
            Err(Phase1ContributionError::InvalidPreviousState)
        }
    })
}

fn encode_proof(proof: &KernelProof) -> Result<SecretContributionProof, Phase1ContributionError> {
    Ok(SecretContributionProof {
        parameter: proof.parameter,
        contribution_g1: EncodedPoint::from_g1_hex(serialize_g1serde(
            &proof.contribution_g1,
            Compress::Yes,
        ))?,
        contribution_g2: EncodedPoint::from_g2_hex(serialize_g2serde(
            &proof.contribution_g2,
            Compress::Yes,
        ))?,
        proof_of_knowledge_g2: EncodedPoint::from_g2_hex(serialize_g2serde(
            &proof.proof_of_knowledge_g2,
            Compress::Yes,
        ))?,
    })
}

fn decode_proof(proof: &SecretContributionProof) -> Result<KernelProof, Phase1ContributionError> {
    Ok(KernelProof {
        parameter: proof.parameter,
        contribution_g1: deserialize_g1serde(&proof.contribution_g1.hex, Compress::Yes)
            .map_err(Phase1ContributionError::PointEncoding)?,
        contribution_g2: deserialize_g2serde(&proof.contribution_g2.hex, Compress::Yes)
            .map_err(Phase1ContributionError::PointEncoding)?,
        proof_of_knowledge_g2: deserialize_g2serde(&proof.proof_of_knowledge_g2.hex, Compress::Yes)
            .map_err(Phase1ContributionError::PointEncoding)?,
    })
}

fn verify_direct_share_updates(
    previous: &UniversalTauArtifact,
    current: &UniversalTauArtifact,
    proofs: &[KernelProof],
) -> Result<(), Phase1ContributionError> {
    if previous.points.g1 != current.points.g1 || previous.points.g2 != current.points.g2 {
        return Err(Phase1ContributionError::AlgebraicConsistency);
    }
    for parameter in current.state.contribution_profile.parameters() {
        let proof = proofs
            .iter()
            .find(|proof| proof.parameter == *parameter)
            .ok_or(Phase1ContributionError::ReceiptMismatch)?;
        let (before, after) = match parameter {
            TrapdoorParameter::Alpha => (previous.points.alpha_g1[1], current.points.alpha_g1[1]),
            TrapdoorParameter::X => (previous.points.x_g1[1], current.points.x_g1[1]),
            TrapdoorParameter::Y => (previous.points.y_g1[1], current.points.y_g1[1]),
            _ => return Err(Phase1ContributionError::ReceiptMismatch),
        };
        if !same_ratio(before, after, current.points.g2, proof.contribution_g2) {
            return Err(Phase1ContributionError::AlgebraicConsistency);
        }
    }
    Ok(())
}

fn verify_dusk_immutability(
    previous: &UniversalTauPoints,
    current: &UniversalTauPoints,
) -> Result<(), Phase1ContributionError> {
    if previous.g1 != current.g1
        || previous.g2 != current.g2
        || !verify_immutable_g1(&previous.alpha_g1, &current.alpha_g1)
        || !verify_immutable_g2(&previous.alpha_g2, &current.alpha_g2)
        || !verify_immutable_g1(&previous.x_g1, &current.x_g1)
        || !verify_immutable_g2(&previous.x_g2, &current.x_g2)
        || !verify_immutable_g1(&previous.alpha_x_g1, &current.alpha_x_g1)
    {
        return Err(Phase1ContributionError::AdaptedBasisModified);
    }
    Ok(())
}

fn verify_universal_tau_consistency(
    points: &UniversalTauPoints,
    layout: &MonomialLayout,
    challenge: ScalarField,
) -> bool {
    if points.validate_shapes(layout).is_err()
        || points.alpha_g1[0] != points.g1
        || points.alpha_g2[0] != points.g2
        || points.x_g1[0] != points.g1
        || points.x_g2[0] != points.g2
        || points.y_g1[0] != points.g1
        || points.y_g2[0] != points.g2
    {
        return false;
    }
    let alpha_step_g1 = points.alpha_g1[1];
    let alpha_step_g2 = points.alpha_g2[1];
    let x_step_g2 = points.x_g2[1];
    let y_step_g2 = points.y_g2[1];
    if !batch_axis_g1(
        &points.alpha_g1,
        &[layout.alpha_max + 1],
        0,
        points.g2,
        alpha_step_g2,
        challenge,
    ) || !batch_axis_g2(
        &points.alpha_g2,
        &[layout.alpha_max + 1],
        0,
        points.g1,
        alpha_step_g1,
        challenge,
    ) || !batch_axis_g1(
        &points.x_g1,
        &[layout.x_grid_len],
        0,
        points.g2,
        x_step_g2,
        challenge,
    ) || !batch_axis_g1(
        &points.y_g1,
        &[layout.alpha_y_max + 1],
        0,
        points.g2,
        y_step_g2,
        challenge,
    ) {
        return false;
    }
    let families = [
        (
            points.alpha_x_g1.as_slice(),
            vec![layout.alpha_max, layout.alpha_x_max + 1],
            vec![(0, alpha_step_g2), (1, x_step_g2)],
        ),
        (
            points.alpha_y_g1.as_slice(),
            vec![layout.alpha_max, layout.alpha_y_max + 1],
            vec![(0, alpha_step_g2), (1, y_step_g2)],
        ),
        (
            points.xy_g1.as_slice(),
            vec![layout.x_grid_len, layout.y_grid_len],
            vec![(0, x_step_g2), (1, y_step_g2)],
        ),
        (
            points.alpha_xy_abc_g1.as_slice(),
            vec![3, layout.n, layout.s],
            vec![(0, alpha_step_g2), (1, x_step_g2), (2, y_step_g2)],
        ),
        (
            points.alpha4_xy_k_g1.as_slice(),
            vec![layout.m_i, layout.s],
            vec![(0, x_step_g2), (1, y_step_g2)],
        ),
    ];
    for (family, dimensions, axes) in families {
        for (axis, step) in axes {
            if !batch_axis_g1(family, &dimensions, axis, points.g2, step, challenge) {
                return false;
            }
        }
    }
    for k in 1..=layout.alpha_max {
        if points.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1)] != points.alpha_g1[k]
            || points.alpha_y_g1[(k - 1) * (layout.alpha_y_max + 1)] != points.alpha_g1[k]
        {
            return false;
        }
    }
    for a in 0..layout.x_grid_len {
        if points.xy_g1[a * layout.y_grid_len] != points.x_g1[a] {
            return false;
        }
    }
    for k in 1..=3 {
        for a in 0..layout.n {
            if points.alpha_xy_abc_g1[((k - 1) * layout.n + a) * layout.s]
                != points.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1) + a]
            {
                return false;
            }
        }
    }
    for a in 0..layout.m_i {
        if points.alpha4_xy_k_g1[a * layout.s]
            != points.alpha_x_g1[3 * (layout.alpha_x_max + 1) + a]
        {
            return false;
        }
    }
    true
}

fn batch_axis_g1(
    points: &[G1serde],
    dimensions: &[usize],
    axis: usize,
    base_g2: G2serde,
    step_g2: G2serde,
    challenge: ScalarField,
) -> bool {
    let mut left = G1serde::zero();
    let mut right = G1serde::zero();
    let mut weight = ScalarField::one();
    let mut pair_count = 0usize;
    for flat in 0..points.len() {
        let coordinate = coordinate(flat, dimensions, axis);
        if coordinate + 1 < dimensions[axis] {
            let stride = dimensions[axis + 1..].iter().product::<usize>();
            left = left + points[flat] * weight;
            right = right + points[flat + stride] * weight;
            weight = weight * challenge;
            pair_count += 1;
        }
    }
    pair_count == 0 || same_ratio(left, right, base_g2, step_g2)
}

fn batch_axis_g2(
    points: &[G2serde],
    dimensions: &[usize],
    axis: usize,
    base_g1: G1serde,
    step_g1: G1serde,
    challenge: ScalarField,
) -> bool {
    let mut left = G2serde::zero();
    let mut right = G2serde::zero();
    let mut weight = ScalarField::one();
    let mut pair_count = 0usize;
    for flat in 0..points.len() {
        let coordinate = coordinate(flat, dimensions, axis);
        if coordinate + 1 < dimensions[axis] {
            let stride = dimensions[axis + 1..].iter().product::<usize>();
            left = left + points[flat] * weight;
            right = right + points[flat + stride] * weight;
            weight = weight * challenge;
            pair_count += 1;
        }
    }
    pair_count == 0 || same_ratio(base_g1, step_g1, left, right)
}

fn coordinate(flat: usize, dimensions: &[usize], axis: usize) -> usize {
    let stride = dimensions[axis + 1..].iter().product::<usize>();
    (flat / stride) % dimensions[axis]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accumulator::Accumulator;
    use crate::protocol::validate_state_selection;
    use crate::protocol::SourceProvenance;
    use crate::utils::{icicle_g1_generator, icicle_g2_generator, RandomGenerator, RandomStrategy};
    use libs::utils::SetupShape;

    fn shape() -> SetupShape {
        SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        }
    }

    fn shares(profile: ContributionProfile, values: &[u32]) -> SecretShares {
        SecretShares::new(
            profile,
            profile
                .parameters()
                .iter()
                .zip(values)
                .map(|(parameter, value)| (*parameter, ScalarField::from_u32(*value)))
                .collect(),
        )
        .unwrap()
    }

    fn dusk_prepared() -> UniversalTauArtifact {
        let native = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        let state = CeremonyState::new_initial_phase1(
            "ceremony",
            ContributionProfile::DuskY,
            native.state.capacity_digest.clone(),
            native.state.layout_digest.clone(),
            SourceProvenance::DuskAdapted {
                adapted_tau_sha256: Sha256Digest::from_bytes(b"adapted"),
            },
            native.points.protocol_payload(&native.layout).unwrap(),
        )
        .unwrap();
        UniversalTauArtifact {
            layout: native.layout,
            points: native.points,
            state,
        }
    }

    #[test]
    fn native_contribution_updates_all_three_parameters_and_is_self_verified() {
        let genesis = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        let shares = shares(ContributionProfile::NativeAlphaXY, &[2, 3, 5]);
        let contribution =
            contribute_phase1(&genesis, &shares, ContributionEntropyMode::Random).unwrap();
        verify_phase1_transition(&genesis, &contribution).unwrap();
        assert_ne!(
            contribution.artifact.points.alpha_g1[1],
            genesis.points.alpha_g1[1]
        );
        assert_ne!(contribution.artifact.points.x_g1[1], genesis.points.x_g1[1]);
        assert_ne!(contribution.artifact.points.y_g1[1], genesis.points.y_g1[1]);
        assert!(validate_state_selection(
            &contribution.artifact.state,
            &[contribution.receipt.clone()]
        )
        .is_ok());
    }

    #[test]
    fn sequential_native_contributions_equal_the_product_of_test_shares() {
        let genesis = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        let first = contribute_phase1(
            &genesis,
            &shares(ContributionProfile::NativeAlphaXY, &[2, 3, 5]),
            ContributionEntropyMode::Random,
        )
        .unwrap();
        let second = contribute_phase1(
            &first.artifact,
            &shares(ContributionProfile::NativeAlphaXY, &[7, 11, 13]),
            ContributionEntropyMode::Hybrid,
        )
        .unwrap();
        assert_eq!(
            second.artifact.points.alpha_g1[1],
            genesis.points.g1 * ScalarField::from_u32(14)
        );
        assert_eq!(
            second.artifact.points.x_g1[1],
            genesis.points.g1 * ScalarField::from_u32(33)
        );
        assert_eq!(
            second.artifact.points.y_g1[1],
            genesis.points.g1 * ScalarField::from_u32(65)
        );
    }

    #[test]
    fn tampering_and_nonqualifying_selection_are_rejected() {
        let genesis = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        let mut contribution = contribute_phase1(
            &genesis,
            &shares(ContributionProfile::NativeAlphaXY, &[2, 3, 5]),
            ContributionEntropyMode::Beacon,
        )
        .unwrap();
        assert!(validate_state_selection(
            &contribution.artifact.state,
            &[contribution.receipt.clone()]
        )
        .is_err());
        contribution.artifact.points.xy_g1[3] = contribution.artifact.points.g1;
        assert!(verify_phase1_transition(&genesis, &contribution).is_err());
    }

    #[test]
    fn dusk_contribution_updates_only_y_dependent_families() {
        let prepared = dusk_prepared();
        let contribution = contribute_phase1(
            &prepared,
            &shares(ContributionProfile::DuskY, &[5]),
            ContributionEntropyMode::Random,
        )
        .unwrap();
        assert_eq!(
            contribution.artifact.points.alpha_g1,
            prepared.points.alpha_g1
        );
        assert_eq!(
            contribution.artifact.points.alpha_g2,
            prepared.points.alpha_g2
        );
        assert_eq!(contribution.artifact.points.x_g1, prepared.points.x_g1);
        assert_eq!(contribution.artifact.points.x_g2, prepared.points.x_g2);
        assert_eq!(
            contribution.artifact.points.alpha_x_g1,
            prepared.points.alpha_x_g1
        );
        assert_ne!(
            contribution.artifact.points.y_g1[1],
            prepared.points.y_g1[1]
        );
        verify_phase1_transition(&prepared, &contribution).unwrap();
    }

    #[test]
    fn dusk_contribution_rejects_y_with_trivial_s_power() {
        let prepared = dusk_prepared();
        let minus_one = ScalarField::zero() - ScalarField::one();
        let shares = SecretShares::new(
            ContributionProfile::DuskY,
            vec![(TrapdoorParameter::Y, minus_one)],
        )
        .unwrap();
        assert!(contribute_phase1(&prepared, &shares, ContributionEntropyMode::Testing).is_err());
    }

    #[test]
    fn native_alpha_x_slices_match_the_legacy_contribution_semantics() {
        let genesis = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        let mut legacy_rng = RandomGenerator::new(RandomStrategy::Testing, [0u8; 32]);
        let legacy = Accumulator::new(
            icicle_g1_generator(),
            icicle_g2_generator(),
            genesis.layout.alpha_max,
            genesis.layout.alpha_x_max,
            true,
        );
        let (legacy_current, _) = legacy.compute(&mut legacy_rng);
        let current = contribute_phase1(
            &genesis,
            &shares(ContributionProfile::NativeAlphaXY, &[3, 5, 7]),
            ContributionEntropyMode::Testing,
        )
        .unwrap();
        for k in 1..=genesis.layout.alpha_max {
            assert_eq!(
                current.artifact.points.alpha_g1[k],
                legacy_current.get_alpha_g1(k)
            );
            assert_eq!(
                current.artifact.points.alpha_g2[k],
                legacy_current.alpha[k - 1].g2
            );
            for a in 1..=genesis.layout.alpha_x_max {
                assert_eq!(
                    current.artifact.points.alpha_x_g1
                        [(k - 1) * (genesis.layout.alpha_x_max + 1) + a],
                    legacy_current.get_alphax_g1(k, a)
                );
            }
        }
        for a in 1..genesis.layout.x_grid_len {
            assert_eq!(current.artifact.points.x_g1[a], legacy_current.get_x_g1(a));
        }
        assert_eq!(current.artifact.points.x_g2[1], legacy_current.get_x_g2(1));
    }
}
