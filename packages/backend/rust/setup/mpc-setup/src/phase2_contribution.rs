use crate::contribution_kernel::{
    apply_and_self_verify, batch_challenge, create_proofs, scale_g1_family, scale_g2_family,
    verify_immutable_g1, verify_immutable_g2, verify_proofs, ContributionSpec, FamilyComponent,
    FamilyShape, KernelError, KernelProof, SecretShares,
};
use crate::conversions::{
    deserialize_g1serde, deserialize_g2serde, serialize_g1serde, serialize_g2serde,
};
use crate::phase2_circuit::{CircuitPreparationError, CircuitSigmaArtifact, CircuitSigmaPoints};
use crate::protocol::{
    CeremonyState, ContributionEntropyMode, ContributionProfile, ContributionReceipt, EncodedPoint,
    Phase, PhasePayload, SecretContributionProof, Sha256Digest, StateStatus, TrapdoorParameter,
    CONTRACT_VERSION, PROTOCOL_VERSION,
};
use crate::utils::same_ratio;
use ark_serialize::Compress;
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use libs::group_structures::G1serde;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Phase2ContributionError {
    #[error("invalid Phase 2 state or receipt: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("contribution kernel rejected the transition: {0}")]
    Kernel(#[from] KernelError),
    #[error("invalid circuit sigma: {0}")]
    Circuit(#[from] CircuitPreparationError),
    #[error("invalid universal tau layout: {0}")]
    UniversalTau(#[from] crate::universal_tau::UniversalTauError),
    #[error("point proof encoding is invalid: {0}")]
    PointEncoding(String),
    #[error("Phase 2 contribution requires a compatible prepared or contributed state")]
    InvalidPreviousState,
    #[error("state payload descriptors do not authenticate the supplied circuit sigma")]
    PayloadManifestMismatch,
    #[error("contribution receipt does not authenticate the direct state transition")]
    ReceiptMismatch,
    #[error("contribution modified circuit-fixed or selected-Phase-1 material")]
    ImmutableMaterialModified,
    #[error("direct or inverse contribution relation is inconsistent")]
    ContributionDirectionMismatch,
}

#[derive(Clone, Debug)]
pub struct Phase2Contribution {
    pub artifact: CircuitSigmaArtifact,
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
    previous_phase_digest: &'a Sha256Digest,
    capacity_digest: &'a Sha256Digest,
    layout_digest: &'a Sha256Digest,
    circuit_digest: &'a Sha256Digest,
    contributor_index: u64,
    parameters: &'static [TrapdoorParameter],
}

pub fn contribute_phase2(
    previous: &CircuitSigmaArtifact,
    shares: &SecretShares,
    entropy_mode: ContributionEntropyMode,
) -> Result<Phase2Contribution, Phase2ContributionError> {
    validate_artifact(previous)?;
    if previous.state.phase != Phase::Phase2
        || previous.state.contribution_profile != ContributionProfile::CircuitGammaDeltaEta
    {
        return Err(Phase2ContributionError::InvalidPreviousState);
    }
    let spec = ContributionSpec::for_profile(ContributionProfile::CircuitGammaDeltaEta);
    let points = scale_points(&previous.points, &spec, shares)?;
    let payload = points.protocol_payload(&previous.layout)?;
    let state = CeremonyState::next_contributed_phase2(&previous.state, payload)?;
    let previous_digest = previous.state.digest()?;
    let current_digest = state.digest()?;
    let transcript = proof_transcript(&state, &previous_digest, &current_digest)?;
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
    let candidate = Phase2Contribution {
        artifact: CircuitSigmaArtifact {
            layout: previous.layout.clone(),
            points,
            state,
        },
        receipt,
    };
    apply_and_self_verify(
        || Ok(candidate),
        |candidate| verify_phase2_transition(previous, candidate).is_ok(),
    )
    .map(|verified| verified.into_inner())
    .map_err(Phase2ContributionError::Kernel)
}

pub fn verify_phase2_transition(
    previous: &CircuitSigmaArtifact,
    current: &Phase2Contribution,
) -> Result<(), Phase2ContributionError> {
    validate_artifact(previous)?;
    validate_artifact(&current.artifact)?;
    let expected_sequence = previous
        .state
        .sequence
        .checked_add(1)
        .ok_or(Phase2ContributionError::InvalidPreviousState)?;
    if current.artifact.layout != previous.layout
        || current.artifact.state.phase != Phase::Phase2
        || current.artifact.state.contribution_profile != ContributionProfile::CircuitGammaDeltaEta
        || current.artifact.state.sequence != expected_sequence
        || current.artifact.state.status != StateStatus::Contributed
        || current.artifact.state.previous_state_digest.as_ref() != Some(&previous.state.digest()?)
        || current.artifact.state.previous_phase_digest != previous.state.previous_phase_digest
        || current.artifact.state.circuit_digest != previous.state.circuit_digest
    {
        return Err(Phase2ContributionError::InvalidPreviousState);
    }
    verify_fixed_material(&previous.points, &current.artifact.points)?;
    let previous_digest = previous.state.digest()?;
    let current_digest = current.artifact.state.digest()?;
    let transcript = proof_transcript(&current.artifact.state, &previous_digest, &current_digest)?;
    if current.receipt.ceremony_id != current.artifact.state.ceremony_id
        || current.receipt.phase != Phase::Phase2
        || current.receipt.contribution_profile != ContributionProfile::CircuitGammaDeltaEta
        || current.receipt.contributor_index != current.artifact.state.sequence
        || current.receipt.previous_state_digest != previous_digest
        || current.receipt.current_state_digest != current_digest
        || current.receipt.verification_transcript_digest != Sha256Digest::from_bytes(&transcript)
    {
        return Err(Phase2ContributionError::ReceiptMismatch);
    }
    current.receipt.validate()?;
    let proofs = current
        .receipt
        .secret_proofs
        .iter()
        .map(decode_proof)
        .collect::<Result<Vec<_>, _>>()?;
    verify_proofs(
        ContributionProfile::CircuitGammaDeltaEta,
        &proofs,
        &transcript,
    )?;
    verify_direct_updates(&previous.points, &current.artifact.points, &proofs)?;
    let challenge = batch_challenge(
        &previous_digest,
        &current_digest,
        b"tokamak-phase2-inverse-families-v1",
    );
    verify_inverse_updates(
        &previous.points,
        &current.artifact.points,
        &proofs,
        challenge,
    )
}

fn validate_artifact(artifact: &CircuitSigmaArtifact) -> Result<(), Phase2ContributionError> {
    artifact.state.validate()?;
    if artifact.state.layout_digest != artifact.layout.digest()? {
        return Err(Phase2ContributionError::PayloadManifestMismatch);
    }
    let expected = artifact.points.protocol_payload(&artifact.layout)?;
    match &artifact.state.payload {
        PhasePayload::Phase2(actual) if actual == &expected => Ok(()),
        _ => Err(Phase2ContributionError::PayloadManifestMismatch),
    }
}

fn scale_points(
    previous: &CircuitSigmaPoints,
    spec: &ContributionSpec,
    shares: &SecretShares,
) -> Result<CircuitSigmaPoints, KernelError> {
    let mut current = previous.clone();
    current.gamma_g1 = scale_g1_family(
        spec,
        FamilyComponent::GammaDirect,
        &scalar_shape(),
        &[previous.gamma_g1],
        shares,
    )?[0];
    current.gamma_g2 = scale_g2_family(
        spec,
        FamilyComponent::GammaDirect,
        &scalar_shape(),
        &[previous.gamma_g2],
        shares,
    )?[0];
    current.gamma_inv_o_inst = scale_optional_inverse(
        spec,
        FamilyComponent::GammaInverse,
        &previous.gamma_inv_o_inst,
        shares,
    )?;

    current.delta_g1 = scale_g1_family(
        spec,
        FamilyComponent::DeltaDirect,
        &scalar_shape(),
        &[previous.delta_g1],
        shares,
    )?[0];
    current.delta_g2 = scale_g2_family(
        spec,
        FamilyComponent::DeltaDirect,
        &scalar_shape(),
        &[previous.delta_g2],
        shares,
    )?[0];
    current.delta_inv_li_o_prv = scale_optional_inverse(
        spec,
        FamilyComponent::DeltaInverse,
        &previous.delta_inv_li_o_prv,
        shares,
    )?;
    current.delta_inv_alphak_xh_tx = scale_g1_family(
        spec,
        FamilyComponent::DeltaInverse,
        &vector_shape(previous.delta_inv_alphak_xh_tx.len()),
        &previous.delta_inv_alphak_xh_tx,
        shares,
    )?;
    current.delta_inv_alpha4_xj_tx = scale_g1_family(
        spec,
        FamilyComponent::DeltaInverse,
        &vector_shape(previous.delta_inv_alpha4_xj_tx.len()),
        &previous.delta_inv_alpha4_xj_tx,
        shares,
    )?;
    current.delta_inv_alphak_yi_ty = scale_g1_family(
        spec,
        FamilyComponent::DeltaInverse,
        &vector_shape(previous.delta_inv_alphak_yi_ty.len()),
        &previous.delta_inv_alphak_yi_ty,
        shares,
    )?;

    current.eta_g1 = scale_g1_family(
        spec,
        FamilyComponent::EtaDirect,
        &scalar_shape(),
        &[previous.eta_g1],
        shares,
    )?[0];
    current.eta_g2 = scale_g2_family(
        spec,
        FamilyComponent::EtaDirect,
        &scalar_shape(),
        &[previous.eta_g2],
        shares,
    )?[0];
    current.eta_inv_li_o_inter_alpha4_kj = scale_optional_inverse(
        spec,
        FamilyComponent::EtaInverse,
        &previous.eta_inv_li_o_inter_alpha4_kj,
        shares,
    )?;
    Ok(current)
}

fn scale_optional_inverse(
    spec: &ContributionSpec,
    component: FamilyComponent,
    points: &[G1serde],
    shares: &SecretShares,
) -> Result<Vec<G1serde>, KernelError> {
    if points.is_empty() {
        return Ok(Vec::new());
    }
    scale_g1_family(spec, component, &vector_shape(points.len()), points, shares)
}

fn scalar_shape() -> FamilyShape {
    FamilyShape::new(vec![1], vec![0])
}

fn vector_shape(length: usize) -> FamilyShape {
    FamilyShape::new(vec![length], vec![0])
}

fn verify_fixed_material(
    previous: &CircuitSigmaPoints,
    current: &CircuitSigmaPoints,
) -> Result<(), Phase2ContributionError> {
    if previous.g1 != current.g1
        || previous.g2 != current.g2
        || !verify_immutable_g2(&previous.alpha_g2, &current.alpha_g2)
        || previous.x_g1 != current.x_g1
        || previous.x_g2 != current.x_g2
        || previous.y_g1 != current.y_g1
        || previous.y_g2 != current.y_g2
        || !verify_immutable_g1(&previous.xy_powers, &current.xy_powers)
        || previous.private_wire_count != current.private_wire_count
        || previous.lagrange_kl != current.lagrange_kl
    {
        return Err(Phase2ContributionError::ImmutableMaterialModified);
    }
    Ok(())
}

fn verify_direct_updates(
    previous: &CircuitSigmaPoints,
    current: &CircuitSigmaPoints,
    proofs: &[KernelProof],
) -> Result<(), Phase2ContributionError> {
    for parameter in ContributionProfile::CircuitGammaDeltaEta.parameters() {
        let proof = proof_for(proofs, *parameter)?;
        let (previous_g1, current_g1, previous_g2, current_g2) = match parameter {
            TrapdoorParameter::Gamma => (
                previous.gamma_g1,
                current.gamma_g1,
                previous.gamma_g2,
                current.gamma_g2,
            ),
            TrapdoorParameter::Delta => (
                previous.delta_g1,
                current.delta_g1,
                previous.delta_g2,
                current.delta_g2,
            ),
            TrapdoorParameter::Eta => (
                previous.eta_g1,
                current.eta_g1,
                previous.eta_g2,
                current.eta_g2,
            ),
            _ => return Err(Phase2ContributionError::ReceiptMismatch),
        };
        if !same_ratio(previous_g1, current_g1, current.g2, proof.contribution_g2)
            || !same_ratio(current.g1, proof.contribution_g1, previous_g2, current_g2)
        {
            return Err(Phase2ContributionError::ContributionDirectionMismatch);
        }
    }
    Ok(())
}

fn verify_inverse_updates(
    previous: &CircuitSigmaPoints,
    current: &CircuitSigmaPoints,
    proofs: &[KernelProof],
    challenge: ScalarField,
) -> Result<(), Phase2ContributionError> {
    let families = [
        (
            TrapdoorParameter::Gamma,
            vec![previous.gamma_inv_o_inst.as_slice()],
            vec![current.gamma_inv_o_inst.as_slice()],
        ),
        (
            TrapdoorParameter::Delta,
            vec![
                previous.delta_inv_li_o_prv.as_slice(),
                previous.delta_inv_alphak_xh_tx.as_slice(),
                previous.delta_inv_alpha4_xj_tx.as_slice(),
                previous.delta_inv_alphak_yi_ty.as_slice(),
            ],
            vec![
                current.delta_inv_li_o_prv.as_slice(),
                current.delta_inv_alphak_xh_tx.as_slice(),
                current.delta_inv_alpha4_xj_tx.as_slice(),
                current.delta_inv_alphak_yi_ty.as_slice(),
            ],
        ),
        (
            TrapdoorParameter::Eta,
            vec![previous.eta_inv_li_o_inter_alpha4_kj.as_slice()],
            vec![current.eta_inv_li_o_inter_alpha4_kj.as_slice()],
        ),
    ];
    for (parameter, previous_families, current_families) in families {
        let proof = proof_for(proofs, parameter)?;
        let (previous_sum, current_sum, count) =
            weighted_family_sums(&previous_families, &current_families, challenge)?;
        if count > 0 && !same_ratio(current_sum, previous_sum, current.g2, proof.contribution_g2) {
            return Err(Phase2ContributionError::ContributionDirectionMismatch);
        }
    }
    Ok(())
}

fn weighted_family_sums(
    previous: &[&[G1serde]],
    current: &[&[G1serde]],
    challenge: ScalarField,
) -> Result<(G1serde, G1serde, usize), Phase2ContributionError> {
    if previous.len() != current.len()
        || previous
            .iter()
            .zip(current)
            .any(|(left, right)| left.len() != right.len())
    {
        return Err(Phase2ContributionError::ContributionDirectionMismatch);
    }
    let mut previous_sum = G1serde::zero();
    let mut current_sum = G1serde::zero();
    let mut weight = ScalarField::one();
    let mut count = 0usize;
    for (previous_family, current_family) in previous.iter().zip(current) {
        for (previous_point, current_point) in previous_family.iter().zip(*current_family) {
            previous_sum = previous_sum + *previous_point * weight;
            current_sum = current_sum + *current_point * weight;
            weight = weight * challenge;
            count += 1;
        }
    }
    Ok((previous_sum, current_sum, count))
}

fn proof_for(
    proofs: &[KernelProof],
    parameter: TrapdoorParameter,
) -> Result<&KernelProof, Phase2ContributionError> {
    proofs
        .iter()
        .find(|proof| proof.parameter == parameter)
        .ok_or(Phase2ContributionError::ReceiptMismatch)
}

fn proof_transcript(
    current: &CeremonyState,
    previous_digest: &Sha256Digest,
    current_digest: &Sha256Digest,
) -> Result<Vec<u8>, Phase2ContributionError> {
    let previous_phase_digest = current
        .previous_phase_digest
        .as_ref()
        .ok_or(Phase2ContributionError::InvalidPreviousState)?;
    let circuit_digest = current
        .circuit_digest
        .as_ref()
        .ok_or(Phase2ContributionError::InvalidPreviousState)?;
    serde_json::to_vec(&ProofTranscript {
        contract_version: CONTRACT_VERSION,
        protocol_version: PROTOCOL_VERSION,
        ceremony_id: &current.ceremony_id,
        phase: Phase::Phase2,
        contribution_profile: ContributionProfile::CircuitGammaDeltaEta,
        previous_state_digest: previous_digest,
        current_state_digest: current_digest,
        previous_phase_digest,
        capacity_digest: &current.capacity_digest,
        layout_digest: &current.layout_digest,
        circuit_digest,
        contributor_index: current.sequence,
        parameters: ContributionProfile::CircuitGammaDeltaEta.parameters(),
    })
    .map_err(|error| Phase2ContributionError::PointEncoding(error.to_string()))
}

fn encode_proof(proof: &KernelProof) -> Result<SecretContributionProof, Phase2ContributionError> {
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

fn decode_proof(proof: &SecretContributionProof) -> Result<KernelProof, Phase2ContributionError> {
    Ok(KernelProof {
        parameter: proof.parameter,
        contribution_g1: deserialize_g1serde(&proof.contribution_g1.hex, Compress::Yes)
            .map_err(Phase2ContributionError::PointEncoding)?,
        contribution_g2: deserialize_g2serde(&proof.contribution_g2.hex, Compress::Yes)
            .map_err(Phase2ContributionError::PointEncoding)?,
        proof_of_knowledge_g2: deserialize_g2serde(&proof.proof_of_knowledge_g2.hex, Compress::Yes)
            .map_err(Phase2ContributionError::PointEncoding)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flows::phase2_next_contributor::compute_new_sigma;
    use crate::phase1_contribution::contribute_phase1;
    use crate::phase2_circuit::{prepare_phase2_circuit, CircuitPreparationInput, WirePolynomial};
    use crate::protocol::validate_state_selection;
    use crate::sigma::SigmaV2;
    use crate::universal_tau::UniversalTauArtifact;
    use crate::utils::{RandomGenerator, RandomStrategy};
    use icicle_core::traits::Arithmetic;
    use libs::group_structures::{Sigma, Sigma1, Sigma2};
    use libs::utils::{try_init_ntt_domain, SetupShape};

    fn setup_shape() -> SetupShape {
        SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        }
    }

    fn shares(values: [u32; 3]) -> SecretShares {
        SecretShares::new(
            ContributionProfile::CircuitGammaDeltaEta,
            vec![
                (TrapdoorParameter::Gamma, ScalarField::from_u32(values[0])),
                (TrapdoorParameter::Delta, ScalarField::from_u32(values[1])),
                (TrapdoorParameter::Eta, ScalarField::from_u32(values[2])),
            ],
        )
        .unwrap()
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

    fn circuit_input(digit: char) -> CircuitPreparationInput {
        CircuitPreparationInput {
            circuit_digest: Sha256Digest::parse(format!("sha256:{}", digit.to_string().repeat(64)))
                .unwrap(),
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

    fn prepared(digit: char) -> CircuitSigmaArtifact {
        try_init_ntt_domain(2).unwrap();
        let genesis = UniversalTauArtifact::initialize_native("ceremony", &setup_shape()).unwrap();
        let phase1_shares = SecretShares::new(
            ContributionProfile::NativeAlphaXY,
            vec![
                (TrapdoorParameter::Alpha, ScalarField::from_u32(2)),
                (TrapdoorParameter::X, ScalarField::from_u32(3)),
                (TrapdoorParameter::Y, ScalarField::from_u32(5)),
            ],
        )
        .unwrap();
        let selected =
            contribute_phase1(&genesis, &phase1_shares, ContributionEntropyMode::Random).unwrap();
        prepare_phase2_circuit(
            &selected.artifact,
            &[selected.receipt],
            &circuit_input(digit),
        )
        .unwrap()
    }

    #[test]
    fn sequential_contributions_compose_and_preserve_inverse_direction() {
        let initial = prepared('1');
        let first = contribute_phase2(
            &initial,
            &shares([2, 3, 5]),
            ContributionEntropyMode::Random,
        )
        .unwrap();
        let second = contribute_phase2(
            &first.artifact,
            &shares([7, 11, 13]),
            ContributionEntropyMode::Hybrid,
        )
        .unwrap();
        verify_phase2_transition(&initial, &first).unwrap();
        verify_phase2_transition(&first.artifact, &second).unwrap();

        assert_eq!(
            second.artifact.points.gamma_g1,
            initial.points.gamma_g1 * ScalarField::from_u32(14)
        );
        assert_eq!(
            second.artifact.points.delta_g2,
            initial.points.delta_g2 * ScalarField::from_u32(33)
        );
        assert_eq!(
            second.artifact.points.eta_g1,
            initial.points.eta_g1 * ScalarField::from_u32(65)
        );
        assert_eq!(
            second.artifact.points.gamma_inv_o_inst[0],
            initial.points.gamma_inv_o_inst[0] * ScalarField::from_u32(14).inv()
        );
        assert_eq!(
            second.artifact.points.delta_inv_alphak_xh_tx[0],
            initial.points.delta_inv_alphak_xh_tx[0] * ScalarField::from_u32(33).inv()
        );
        assert_eq!(
            second.artifact.points.eta_inv_li_o_inter_alpha4_kj[0],
            initial.points.eta_inv_li_o_inter_alpha4_kj[0] * ScalarField::from_u32(65).inv()
        );
    }

    #[test]
    fn rejects_swapped_proofs_direction_errors_partial_updates_and_replay() {
        let initial = prepared('1');
        let mut contribution = contribute_phase2(
            &initial,
            &shares([2, 3, 5]),
            ContributionEntropyMode::Random,
        )
        .unwrap();
        contribution.receipt.secret_proofs.swap(0, 1);
        assert!(verify_phase2_transition(&initial, &contribution).is_err());

        let spec = ContributionSpec::for_profile(ContributionProfile::CircuitGammaDeltaEta);
        let mut wrong_direction = initial.points.clone();
        wrong_direction.gamma_inv_o_inst = scale_g1_family(
            &spec,
            FamilyComponent::GammaDirect,
            &vector_shape(initial.points.gamma_inv_o_inst.len()),
            &initial.points.gamma_inv_o_inst,
            &shares([2, 3, 5]),
        )
        .unwrap();
        let proofs = create_proofs(&shares([2, 3, 5]), b"direction-test");
        assert!(verify_inverse_updates(
            &initial.points,
            &wrong_direction,
            &proofs,
            ScalarField::from_u32(17),
        )
        .is_err());

        let mut partial = scale_points(&initial.points, &spec, &shares([2, 3, 5])).unwrap();
        partial.delta_inv_alpha4_xj_tx = initial.points.delta_inv_alpha4_xj_tx.clone();
        assert!(verify_inverse_updates(
            &initial.points,
            &partial,
            &proofs,
            ScalarField::from_u32(19),
        )
        .is_err());

        let other = prepared('2');
        let valid = contribute_phase2(
            &initial,
            &shares([2, 3, 5]),
            ContributionEntropyMode::Random,
        )
        .unwrap();
        assert!(verify_phase2_transition(&other, &valid).is_err());

        let mut mutated = valid.clone();
        mutated.artifact.points.x_g1 = mutated.artifact.points.x_g1 * ScalarField::from_u32(2);
        assert!(verify_phase2_transition(&initial, &mutated).is_err());
    }

    #[test]
    fn prepared_and_nonqualifying_chains_cannot_be_selected() {
        let initial = prepared('1');
        assert!(validate_state_selection(&initial.state, &[]).is_err());
        let beacon = contribute_phase2(
            &initial,
            &shares([2, 3, 5]),
            ContributionEntropyMode::Beacon,
        )
        .unwrap();
        assert!(validate_state_selection(&beacon.artifact.state, &[beacon.receipt]).is_err());
    }

    #[test]
    fn shared_kernel_matches_legacy_inverse_parameter_transition() {
        let initial = prepared('1');
        let legacy_input = to_legacy(&initial);
        let mut rng = RandomGenerator::new(RandomStrategy::Testing, [0u8; 32]);
        let (legacy, _) = compute_new_sigma(&mut rng, &legacy_input);
        let current = scale_points(
            &initial.points,
            &ContributionSpec::for_profile(ContributionProfile::CircuitGammaDeltaEta),
            &shares([5, 3, 7]),
        )
        .unwrap();
        assert_points_match_legacy(&current, &legacy);
    }

    fn rows(points: &[G1serde], width: usize) -> Box<[Box<[G1serde]>]> {
        points
            .chunks(width)
            .map(|row| row.to_vec().into_boxed_slice())
            .collect::<Vec<_>>()
            .into_boxed_slice()
    }

    fn to_legacy(artifact: &CircuitSigmaArtifact) -> SigmaV2 {
        let points = &artifact.points;
        let layout = &artifact.layout;
        SigmaV2 {
            contributor_index: 0,
            sigma: Sigma {
                G: points.g1,
                H: points.g2,
                sigma_1: Sigma1 {
                    xy_powers: points.xy_powers.clone().into_boxed_slice(),
                    x: points.x_g1,
                    y: points.y_g1,
                    delta: points.delta_g1,
                    eta: points.eta_g1,
                    gamma_inv_o_inst: points.gamma_inv_o_inst.clone().into_boxed_slice(),
                    eta_inv_li_o_inter_alpha4_kj: rows(
                        &points.eta_inv_li_o_inter_alpha4_kj,
                        layout.s,
                    ),
                    delta_inv_li_o_prv: rows(&points.delta_inv_li_o_prv, layout.s),
                    delta_inv_alphak_xh_tx: rows(&points.delta_inv_alphak_xh_tx, 3),
                    delta_inv_alpha4_xj_tx: points
                        .delta_inv_alpha4_xj_tx
                        .clone()
                        .into_boxed_slice(),
                    delta_inv_alphak_yi_ty: rows(&points.delta_inv_alphak_yi_ty, 3),
                },
                sigma_2: Sigma2 {
                    alpha: points.alpha_g2[0],
                    alpha2: points.alpha_g2[1],
                    alpha3: points.alpha_g2[2],
                    alpha4: points.alpha_g2[3],
                    gamma: points.gamma_g2,
                    delta: points.delta_g2,
                    eta: points.eta_g2,
                    x: points.x_g2,
                    y: points.y_g2,
                },
                lagrange_KL: points.lagrange_kl,
            },
            gamma: points.gamma_g1,
            public_y_hex: None,
            phase1_source_provenance: None,
        }
    }

    fn flatten(rows: &[Box<[G1serde]>]) -> Vec<G1serde> {
        rows.iter().flat_map(|row| row.iter().copied()).collect()
    }

    fn assert_points_match_legacy(points: &CircuitSigmaPoints, legacy: &SigmaV2) {
        assert_eq!(points.gamma_g1, legacy.gamma);
        assert_eq!(points.gamma_g2, legacy.sigma.sigma_2.gamma);
        assert_eq!(points.delta_g1, legacy.sigma.sigma_1.delta);
        assert_eq!(points.delta_g2, legacy.sigma.sigma_2.delta);
        assert_eq!(points.eta_g1, legacy.sigma.sigma_1.eta);
        assert_eq!(points.eta_g2, legacy.sigma.sigma_2.eta);
        assert_eq!(
            points.gamma_inv_o_inst.as_slice(),
            legacy.sigma.sigma_1.gamma_inv_o_inst.as_ref()
        );
        assert_eq!(
            points.eta_inv_li_o_inter_alpha4_kj,
            flatten(&legacy.sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj)
        );
        assert_eq!(
            points.delta_inv_li_o_prv,
            flatten(&legacy.sigma.sigma_1.delta_inv_li_o_prv)
        );
        assert_eq!(
            points.delta_inv_alphak_xh_tx,
            flatten(&legacy.sigma.sigma_1.delta_inv_alphak_xh_tx)
        );
        assert_eq!(
            points.delta_inv_alpha4_xj_tx.as_slice(),
            legacy.sigma.sigma_1.delta_inv_alpha4_xj_tx.as_ref()
        );
        assert_eq!(
            points.delta_inv_alphak_yi_ty,
            flatten(&legacy.sigma.sigma_1.delta_inv_alphak_yi_ty)
        );
    }
}
