use crate::ceremony_workspace::{verified_bundles, CeremonyWorkspaceError};
use crate::protocol::{
    validate_state_selection, AdaptedTau, ContributionEntropyMode, ContributionProfile, Phase,
    Sha256Digest, SourceProvenance, StateStatus, CONTRACT_VERSION, PROTOCOL_VERSION,
};
use crate::state_bundle::StateBundle;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use thiserror::Error;

pub const TRANSCRIPT_FILE_NAME: &str = "ceremony_transcript.json";
const TRANSCRIPT_DOCUMENT_KIND: &str = "tokamakCeremonyTranscript";

#[derive(Debug, Error)]
pub enum TranscriptError {
    #[error("invalid ceremony transcript: {0}")]
    Invalid(String),
    #[error(transparent)]
    Workspace(#[from] CeremonyWorkspaceError),
    #[error("invalid ceremony protocol chain: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("failed to {operation} at {}: {source}", path.display())]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptEntry {
    pub state_digest: Sha256Digest,
    pub sequence: u64,
    pub status: StateStatus,
    pub incoming_receipt_digest: Option<Sha256Digest>,
    pub entropy_mode: Option<ContributionEntropyMode>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPhase {
    pub phase: Phase,
    pub contribution_profile: ContributionProfile,
    pub entries: Vec<TranscriptEntry>,
    pub selected_state_digest: Sha256Digest,
    pub qualifying_contribution_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CeremonyTranscript {
    pub document_kind: String,
    pub contract_version: u32,
    pub protocol_version: String,
    pub ceremony_id: String,
    pub source_provenance: SourceProvenance,
    pub adapted_tau: Option<AdaptedTau>,
    pub capacity_digest: Sha256Digest,
    pub layout_digest: Sha256Digest,
    pub circuit_digest: Sha256Digest,
    pub phase1: TranscriptPhase,
    pub phase2: TranscriptPhase,
}

impl CeremonyTranscript {
    pub fn build(
        workspace: &Path,
        adapted_tau: Option<AdaptedTau>,
    ) -> Result<Self, TranscriptError> {
        let bundles = verified_bundles(workspace)?;
        let first = bundles
            .first()
            .ok_or_else(|| TranscriptError::Invalid("workspace contains no states".into()))?;
        let phase1_bundles = bundles
            .iter()
            .take_while(|bundle| bundle.state().phase == Phase::Phase1)
            .collect::<Vec<_>>();
        let phase2_bundles = bundles
            .iter()
            .skip(phase1_bundles.len())
            .collect::<Vec<_>>();
        if phase1_bundles.is_empty()
            || phase2_bundles.is_empty()
            || phase2_bundles
                .iter()
                .any(|bundle| bundle.state().phase != Phase::Phase2)
        {
            return invalid("transcript requires complete ordered Phase 1 and Phase 2 chains");
        }
        let phase1 = transcript_phase(Phase::Phase1, &phase1_bundles)?;
        let phase2 = transcript_phase(Phase::Phase2, &phase2_bundles)?;
        let last = phase2_bundles.last().expect("Phase 2 chain is nonempty");
        let circuit_digest =
            last.state().circuit_digest.clone().ok_or_else(|| {
                TranscriptError::Invalid("Phase 2 state omits circuit digest".into())
            })?;
        let source_provenance = first.state().source_provenance.clone();
        validate_adaptor(&source_provenance, adapted_tau.as_ref(), first)?;
        let value = Self {
            document_kind: TRANSCRIPT_DOCUMENT_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: first.state().ceremony_id.clone(),
            source_provenance,
            adapted_tau,
            capacity_digest: first.state().capacity_digest.clone(),
            layout_digest: first.state().layout_digest.clone(),
            circuit_digest,
            phase1,
            phase2,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), TranscriptError> {
        if self.document_kind != TRANSCRIPT_DOCUMENT_KIND
            || self.contract_version != CONTRACT_VERSION
            || self.protocol_version != PROTOCOL_VERSION
            || self.ceremony_id.is_empty()
            || self.phase1.phase != Phase::Phase1
            || self.phase2.phase != Phase::Phase2
            || self.phase1.entries.is_empty()
            || self.phase2.entries.is_empty()
            || self.phase1.qualifying_contribution_count == 0
            || self.phase2.qualifying_contribution_count == 0
        {
            return invalid("header, phase order, entries, or qualifying counts are invalid");
        }
        self.capacity_digest.validate("transcript.capacityDigest")?;
        self.layout_digest.validate("transcript.layoutDigest")?;
        self.circuit_digest.validate("transcript.circuitDigest")?;
        if self.phase1.selected_state_digest
            != self
                .phase1
                .entries
                .last()
                .expect("nonempty Phase 1 entries")
                .state_digest
            || self.phase2.selected_state_digest
                != self
                    .phase2
                    .entries
                    .last()
                    .expect("nonempty Phase 2 entries")
                    .state_digest
        {
            return invalid("selected state digest is not the final state of its phase");
        }
        match (&self.source_provenance, &self.adapted_tau) {
            (SourceProvenance::Native, None) => {}
            (SourceProvenance::DuskAdapted { adapted_tau_sha256 }, Some(adapted_tau))
                if &adapted_tau.digest()? == adapted_tau_sha256
                    && adapted_tau.capacity_digest == self.capacity_digest
                    && adapted_tau.layout_digest == self.layout_digest => {}
            _ => return invalid("source provenance and adapted tau manifest disagree"),
        }
        Ok(())
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, TranscriptError> {
        self.validate()?;
        serde_json::to_vec(self).map_err(|error| TranscriptError::Invalid(error.to_string()))
    }

    pub fn from_canonical_json(bytes: &[u8]) -> Result<Self, TranscriptError> {
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|error| TranscriptError::Invalid(error.to_string()))?;
        value.validate()?;
        if value.to_canonical_json()? != bytes {
            return invalid("transcript is not canonical JSON");
        }
        Ok(value)
    }

    pub fn digest(&self) -> Result<Sha256Digest, TranscriptError> {
        Ok(Sha256Digest::from_bytes(&self.to_canonical_json()?))
    }

    pub fn persist(&self, workspace: &Path) -> Result<(), TranscriptError> {
        let destination = workspace.join(TRANSCRIPT_FILE_NAME);
        let bytes = self.to_canonical_json()?;
        if destination.exists() {
            let existing = fs::read(&destination)
                .map_err(|source| io_error("read existing transcript", &destination, source))?;
            if existing == bytes {
                return Ok(());
            }
            return invalid("refusing to overwrite a different ceremony transcript");
        }
        let mut temporary = NamedTempFile::new_in(workspace)
            .map_err(|source| io_error("create temporary transcript", workspace, source))?;
        use std::io::Write as _;
        temporary
            .write_all(&bytes)
            .map_err(|source| io_error("write temporary transcript", temporary.path(), source))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|source| io_error("sync temporary transcript", temporary.path(), source))?;
        temporary
            .persist(&destination)
            .map_err(|error| io_error("commit ceremony transcript", &destination, error.error))?;
        Ok(())
    }

    pub fn verify_persisted(
        workspace: &Path,
        adapted_tau: Option<AdaptedTau>,
    ) -> Result<Self, TranscriptError> {
        let path = workspace.join(TRANSCRIPT_FILE_NAME);
        let bytes = fs::read(&path)
            .map_err(|source| io_error("read ceremony transcript", &path, source))?;
        let persisted = Self::from_canonical_json(&bytes)?;
        let expected = Self::build(workspace, adapted_tau)?;
        if persisted != expected {
            return invalid(
                "persisted transcript does not match the verified ceremony workspace and source",
            );
        }
        Ok(persisted)
    }
}

fn transcript_phase(
    phase: Phase,
    bundles: &[&StateBundle],
) -> Result<TranscriptPhase, TranscriptError> {
    let selected = bundles
        .last()
        .ok_or_else(|| TranscriptError::Invalid("phase has no states".into()))?;
    let receipts = bundles
        .iter()
        .filter_map(|bundle| bundle.incoming_receipt.clone())
        .collect::<Vec<_>>();
    validate_state_selection(selected.state(), &receipts)?;
    let profile = selected.state().contribution_profile;
    if bundles
        .iter()
        .any(|bundle| bundle.state().contribution_profile != profile)
    {
        return invalid("contribution profile changes within a phase");
    }
    let qualifying = receipts
        .iter()
        .filter(|receipt| receipt.entropy_mode.qualifies_for_selection())
        .count();
    Ok(TranscriptPhase {
        phase,
        contribution_profile: profile,
        entries: bundles
            .iter()
            .map(|bundle| {
                Ok(TranscriptEntry {
                    state_digest: bundle.state().digest()?,
                    sequence: bundle.state().sequence,
                    status: bundle.state().status,
                    incoming_receipt_digest: bundle
                        .incoming_receipt
                        .as_ref()
                        .map(|receipt| receipt.digest())
                        .transpose()?,
                    entropy_mode: bundle
                        .incoming_receipt
                        .as_ref()
                        .map(|receipt| receipt.entropy_mode),
                })
            })
            .collect::<Result<Vec<_>, crate::protocol::ProtocolError>>()?,
        selected_state_digest: selected.state().digest()?,
        qualifying_contribution_count: u64::try_from(qualifying)
            .map_err(|_| TranscriptError::Invalid("qualifying count exceeds u64".into()))?,
    })
}

fn validate_adaptor(
    source: &SourceProvenance,
    adapted_tau: Option<&AdaptedTau>,
    first: &StateBundle,
) -> Result<(), TranscriptError> {
    match (source, adapted_tau) {
        (SourceProvenance::Native, None) => Ok(()),
        (SourceProvenance::DuskAdapted { adapted_tau_sha256 }, Some(adapted_tau))
            if adapted_tau.digest()? == *adapted_tau_sha256
                && adapted_tau.capacity_digest == first.state().capacity_digest
                && adapted_tau.layout_digest == first.state().layout_digest =>
        {
            Ok(())
        }
        (SourceProvenance::Native, Some(_)) => {
            invalid("native transcript must not contain an adapted tau manifest")
        }
        (SourceProvenance::DuskAdapted { .. }, None) => {
            invalid("Dusk-backed transcript requires its adapted tau manifest")
        }
        _ => invalid("adapted tau digest or layout differs from Phase 1"),
    }
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> TranscriptError {
    TranscriptError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn invalid<T>(reason: impl Into<String>) -> Result<T, TranscriptError> {
    Err(TranscriptError::Invalid(reason.into()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ceremony_workspace::{append_bundle, initialize_workspace};
    use crate::contribution_kernel::SecretShares;
    use crate::phase1_contribution::contribute_phase1;
    use crate::phase2_circuit::{prepare_phase2_circuit, CircuitPreparationInput, WirePolynomial};
    use crate::phase2_contribution::contribute_phase2;
    use crate::protocol::{ContributionEntropyMode, TrapdoorParameter};
    use crate::state_bundle::{write_phase1_bundle, write_phase2_bundle};
    use crate::universal_tau::UniversalTauArtifact;
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    use libs::utils::{try_init_ntt_domain, SetupShape};

    pub(crate) fn fixture() -> (tempfile::TempDir, PathBuf) {
        try_init_ntt_domain(2).unwrap();
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let shape = SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        };
        let genesis = UniversalTauArtifact::initialize_native("transcript-test", &shape).unwrap();
        let genesis_path = root.path().join("phase1-genesis");
        write_phase1_bundle(&genesis_path, &genesis, None).unwrap();
        initialize_workspace(&workspace, &genesis_path).unwrap();

        let phase1_shares = SecretShares::new(
            ContributionProfile::NativeAlphaXY,
            vec![
                (TrapdoorParameter::Alpha, ScalarField::from_u32(2)),
                (TrapdoorParameter::X, ScalarField::from_u32(3)),
                (TrapdoorParameter::Y, ScalarField::from_u32(5)),
            ],
        )
        .unwrap();
        let phase1 =
            contribute_phase1(&genesis, &phase1_shares, ContributionEntropyMode::Random).unwrap();
        let phase1_path = root.path().join("phase1-contributed");
        write_phase1_bundle(&phase1_path, &phase1.artifact, Some(&phase1.receipt)).unwrap();
        append_bundle(&workspace, &phase1_path).unwrap();

        let wire = |value| WirePolynomial {
            alpha_abc_x_coefficients: [
                vec![ScalarField::from_u32(value), ScalarField::zero()],
                vec![ScalarField::zero(), ScalarField::one()],
                vec![ScalarField::one(), ScalarField::one()],
            ],
        };
        let prepared = prepare_phase2_circuit(
            &phase1.artifact,
            &[phase1.receipt.clone()],
            &CircuitPreparationInput {
                circuit_digest: Sha256Digest::parse(format!("sha256:{}", "1".repeat(64))).unwrap(),
                wire_polynomials: vec![wire(1), wire(2), wire(3), wire(4)],
                public_placement_phases: vec![Some(0)],
                public_m_x_coefficients: vec![vec![ScalarField::one(), ScalarField::zero()]],
                intermediate_k_x_coefficients: vec![
                    vec![ScalarField::one(), ScalarField::zero()],
                    vec![ScalarField::zero(), ScalarField::one()],
                ],
            },
        )
        .unwrap();
        let prepared_path = root.path().join("phase2-prepared");
        write_phase2_bundle(&prepared_path, &prepared, None).unwrap();
        append_bundle(&workspace, &prepared_path).unwrap();

        let phase2_shares = SecretShares::new(
            ContributionProfile::CircuitGammaDeltaEta,
            vec![
                (TrapdoorParameter::Gamma, ScalarField::from_u32(7)),
                (TrapdoorParameter::Delta, ScalarField::from_u32(11)),
                (TrapdoorParameter::Eta, ScalarField::from_u32(13)),
            ],
        )
        .unwrap();
        let phase2 =
            contribute_phase2(&prepared, &phase2_shares, ContributionEntropyMode::Hybrid).unwrap();
        let phase2_path = root.path().join("phase2-contributed");
        write_phase2_bundle(&phase2_path, &phase2.artifact, Some(&phase2.receipt)).unwrap();
        append_bundle(&workspace, &phase2_path).unwrap();
        (root, workspace)
    }

    pub(crate) fn dusk_fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        try_init_ntt_domain(2).unwrap();
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let adapted_path = root.path().join("adapted-tau");
        let shape = SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        };
        let adapted = crate::alpha_x_basis::tests::synthetic_bundle(&adapted_path, &shape);
        let prepared_phase1 = UniversalTauArtifact::prepare_from_adapted_tau(
            "dusk-transcript-test",
            &shape,
            &adapted,
        )
        .unwrap();
        let prepared_phase1_path = root.path().join("phase1-prepared");
        write_phase1_bundle(&prepared_phase1_path, &prepared_phase1, None).unwrap();
        initialize_workspace(&workspace, &prepared_phase1_path).unwrap();

        let phase1_shares = SecretShares::new(
            ContributionProfile::DuskY,
            vec![(TrapdoorParameter::Y, ScalarField::from_u32(5))],
        )
        .unwrap();
        let phase1 = contribute_phase1(
            &prepared_phase1,
            &phase1_shares,
            ContributionEntropyMode::Random,
        )
        .unwrap();
        let phase1_path = root.path().join("phase1-contributed");
        write_phase1_bundle(&phase1_path, &phase1.artifact, Some(&phase1.receipt)).unwrap();
        append_bundle(&workspace, &phase1_path).unwrap();

        let wire = |value| WirePolynomial {
            alpha_abc_x_coefficients: [
                vec![ScalarField::from_u32(value), ScalarField::zero()],
                vec![ScalarField::zero(), ScalarField::one()],
                vec![ScalarField::one(), ScalarField::one()],
            ],
        };
        let prepared_phase2 = prepare_phase2_circuit(
            &phase1.artifact,
            &[phase1.receipt.clone()],
            &CircuitPreparationInput {
                circuit_digest: Sha256Digest::parse(format!("sha256:{}", "4".repeat(64))).unwrap(),
                wire_polynomials: vec![wire(1), wire(2), wire(3), wire(4)],
                public_placement_phases: vec![Some(0)],
                public_m_x_coefficients: vec![vec![ScalarField::one(), ScalarField::zero()]],
                intermediate_k_x_coefficients: vec![
                    vec![ScalarField::one(), ScalarField::zero()],
                    vec![ScalarField::zero(), ScalarField::one()],
                ],
            },
        )
        .unwrap();
        let prepared_phase2_path = root.path().join("phase2-prepared");
        write_phase2_bundle(&prepared_phase2_path, &prepared_phase2, None).unwrap();
        append_bundle(&workspace, &prepared_phase2_path).unwrap();

        let phase2_shares = SecretShares::new(
            ContributionProfile::CircuitGammaDeltaEta,
            vec![
                (TrapdoorParameter::Gamma, ScalarField::from_u32(7)),
                (TrapdoorParameter::Delta, ScalarField::from_u32(11)),
                (TrapdoorParameter::Eta, ScalarField::from_u32(13)),
            ],
        )
        .unwrap();
        let phase2 = contribute_phase2(
            &prepared_phase2,
            &phase2_shares,
            ContributionEntropyMode::Hybrid,
        )
        .unwrap();
        let phase2_path = root.path().join("phase2-contributed");
        write_phase2_bundle(&phase2_path, &phase2.artifact, Some(&phase2.receipt)).unwrap();
        append_bundle(&workspace, &phase2_path).unwrap();
        (root, workspace, adapted_path)
    }

    #[test]
    fn transcript_round_trips_and_matches_verified_workspace() {
        let (_root, workspace) = fixture();
        let transcript = CeremonyTranscript::build(&workspace, None).unwrap();
        assert_eq!(transcript.phase1.qualifying_contribution_count, 1);
        assert_eq!(transcript.phase2.qualifying_contribution_count, 1);
        assert_eq!(
            CeremonyTranscript::from_canonical_json(&transcript.to_canonical_json().unwrap())
                .unwrap(),
            transcript
        );
        transcript.persist(&workspace).unwrap();
        assert_eq!(
            CeremonyTranscript::verify_persisted(&workspace, None).unwrap(),
            transcript
        );
    }

    #[test]
    fn transcript_digest_and_workspace_check_reject_authenticated_field_mutations() {
        let (_root, workspace) = fixture();
        let transcript = CeremonyTranscript::build(&workspace, None).unwrap();
        let original_digest = transcript.digest().unwrap();

        let mut mutations = Vec::new();
        let mut selected = transcript.clone();
        selected.phase2.selected_state_digest = selected.phase2.entries[0].state_digest.clone();
        mutations.push(selected);
        let mut receipt = transcript.clone();
        receipt.phase1.entries[1].incoming_receipt_digest = None;
        mutations.push(receipt);
        let mut profile = transcript.clone();
        profile.phase1.contribution_profile = ContributionProfile::DuskY;
        mutations.push(profile);
        let mut layout = transcript.clone();
        layout.layout_digest = Sha256Digest::parse(format!("sha256:{}", "2".repeat(64))).unwrap();
        mutations.push(layout);
        let mut circuit = transcript.clone();
        circuit.circuit_digest = Sha256Digest::parse(format!("sha256:{}", "3".repeat(64))).unwrap();
        mutations.push(circuit);

        for mutation in mutations {
            if let Ok(digest) = mutation.digest() {
                assert_ne!(digest, original_digest);
            }
        }

        let mut persisted = transcript.clone();
        persisted.ceremony_id = "different-ceremony".into();
        fs::write(
            workspace.join(TRANSCRIPT_FILE_NAME),
            persisted.to_canonical_json().unwrap(),
        )
        .unwrap();
        assert!(CeremonyTranscript::verify_persisted(&workspace, None).is_err());
    }
}
