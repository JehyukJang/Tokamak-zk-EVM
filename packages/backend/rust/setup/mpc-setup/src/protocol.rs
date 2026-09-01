use libs::crs_provenance::DuskSourceProvenance;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

pub const CONTRACT_VERSION: u32 = 1;
pub const PROTOCOL_VERSION: &str = "tokamak-mpc-2phase-v1";

const ADAPTED_TAU_KIND: &str = "tokamakAdaptedTau";
const CEREMONY_STATE_KIND: &str = "tokamakCeremonyState";
const CONTRIBUTION_RECEIPT_KIND: &str = "tokamakContributionReceipt";
const COMPRESSED_G1_BYTES: u64 = 48;
const COMPRESSED_G2_BYTES: u64 = 96;
const POINT_ENCODING: &str = "bls12-381-compressed";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("invalid {field}: {reason}")]
    InvalidField { field: &'static str, reason: String },
    #[error("invalid canonical JSON: {0}")]
    Json(String),
    #[error("document is valid JSON but not in canonical form")]
    NonCanonicalJson,
    #[error("chunk digest mismatch: expected {expected}, got {actual}")]
    ChunkDigestMismatch { expected: String, actual: String },
    #[error("receipt chain is empty")]
    EmptyReceiptChain,
    #[error("receipt chain is broken at contributor index {contributor_index}")]
    BrokenReceiptChain { contributor_index: u64 },
    #[error("no qualifying random or hybrid contribution exists in the selected chain")]
    MissingQualifyingContribution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(format!("sha256:{:x}", Sha256::digest(bytes)))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, ProtocolError> {
        let digest = Self(value.into());
        digest.validate("sha256Digest")?;
        Ok(digest)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn validate(&self, field: &'static str) -> Result<(), ProtocolError> {
        let Some(hex) = self.0.strip_prefix("sha256:") else {
            return invalid(field, "must start with sha256:");
        };
        if hex.len() != 64
            || !hex
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return invalid(
                field,
                "must contain exactly 64 lowercase hexadecimal digits",
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Phase1,
    Phase2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContributionProfile {
    NativeAlphaXY,
    DuskY,
    CircuitGammaDeltaEta,
}

impl ContributionProfile {
    pub fn phase(self) -> Phase {
        match self {
            Self::NativeAlphaXY | Self::DuskY => Phase::Phase1,
            Self::CircuitGammaDeltaEta => Phase::Phase2,
        }
    }

    pub fn parameters(self) -> &'static [TrapdoorParameter] {
        match self {
            Self::NativeAlphaXY => &[
                TrapdoorParameter::Alpha,
                TrapdoorParameter::X,
                TrapdoorParameter::Y,
            ],
            Self::DuskY => &[TrapdoorParameter::Y],
            Self::CircuitGammaDeltaEta => &[
                TrapdoorParameter::Gamma,
                TrapdoorParameter::Delta,
                TrapdoorParameter::Eta,
            ],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StateStatus {
    Genesis,
    Prepared,
    Contributed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContributionEntropyMode {
    Random,
    Hybrid,
    Beacon,
    Testing,
}

impl ContributionEntropyMode {
    pub fn qualifies_for_selection(self) -> bool {
        matches!(self, Self::Random | Self::Hybrid)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrapdoorParameter {
    Alpha,
    X,
    Y,
    Gamma,
    Delta,
    Eta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurveGroup {
    G1,
    G2,
}

impl CurveGroup {
    fn compressed_point_bytes(self) -> u64 {
        match self {
            Self::G1 => COMPRESSED_G1_BYTES,
            Self::G2 => COMPRESSED_G2_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointChunkDescriptor {
    pub family: String,
    pub group: CurveGroup,
    pub shape: Vec<u64>,
    pub start_indices: Vec<u64>,
    pub point_count: u64,
    pub byte_length: u64,
    pub encoding: String,
    pub sha256: Sha256Digest,
}

impl PointChunkDescriptor {
    pub fn from_bytes(
        family: impl Into<String>,
        group: CurveGroup,
        shape: Vec<u64>,
        start_indices: Vec<u64>,
        bytes: &[u8],
    ) -> Result<Self, ProtocolError> {
        let point_count = shape.iter().try_fold(1u64, |count, dimension| {
            count
                .checked_mul(*dimension)
                .ok_or_else(|| ProtocolError::InvalidField {
                    field: "chunk.shape",
                    reason: "point count overflow".to_string(),
                })
        })?;
        let descriptor = Self {
            family: family.into(),
            group,
            shape,
            start_indices,
            point_count,
            byte_length: u64::try_from(bytes.len()).map_err(|_| ProtocolError::InvalidField {
                field: "chunk.byteLength",
                reason: "byte length does not fit in u64".to_string(),
            })?,
            encoding: POINT_ENCODING.to_string(),
            sha256: Sha256Digest::from_bytes(bytes),
        };
        descriptor.validate_bytes(bytes)?;
        Ok(descriptor)
    }

    pub fn content_addressed_file_name(&self) -> String {
        format!(
            "{}.points",
            self.sha256
                .as_str()
                .strip_prefix("sha256:")
                .expect("validated SHA-256 digest always has its prefix")
        )
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        non_empty(&self.family, "chunk.family")?;
        if self.encoding != POINT_ENCODING {
            return invalid("chunk.encoding", format!("must equal {POINT_ENCODING}"));
        }
        if self.shape.is_empty() || self.shape.iter().any(|dimension| *dimension == 0) {
            return invalid("chunk.shape", "must contain only nonzero dimensions");
        }
        if self.shape.len() != self.start_indices.len() {
            return invalid(
                "chunk.startIndices",
                "must have the same rank as chunk.shape",
            );
        }
        let point_count = self.shape.iter().try_fold(1u64, |count, dimension| {
            count
                .checked_mul(*dimension)
                .ok_or_else(|| ProtocolError::InvalidField {
                    field: "chunk.shape",
                    reason: "point count overflow".to_string(),
                })
        })?;
        if self.point_count != point_count {
            return invalid(
                "chunk.pointCount",
                format!("expected {point_count}, got {}", self.point_count),
            );
        }
        let expected_bytes = point_count
            .checked_mul(self.group.compressed_point_bytes())
            .ok_or_else(|| ProtocolError::InvalidField {
                field: "chunk.byteLength",
                reason: "byte length overflow".to_string(),
            })?;
        if self.byte_length != expected_bytes {
            return invalid(
                "chunk.byteLength",
                format!("expected {expected_bytes}, got {}", self.byte_length),
            );
        }
        self.sha256.validate("chunk.sha256")
    }

    pub fn validate_bytes(&self, bytes: &[u8]) -> Result<(), ProtocolError> {
        self.validate()?;
        if u64::try_from(bytes.len()).ok() != Some(self.byte_length) {
            return invalid(
                "chunk.bytes",
                format!("expected {} bytes, got {}", self.byte_length, bytes.len()),
            );
        }
        let actual = Sha256Digest::from_bytes(bytes);
        if actual != self.sha256 {
            return Err(ProtocolError::ChunkDigestMismatch {
                expected: self.sha256.as_str().to_string(),
                actual: actual.as_str().to_string(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuskExponentMapping {
    pub mapping_version: u32,
    pub tokamak_n: u64,
    pub alpha_max: u64,
    pub x_max: u64,
    pub alpha_x_max: u64,
    pub omega_stride: u64,
    pub max_source_g1_exponent: u64,
    pub max_source_g2_exponent: u64,
}

impl DuskExponentMapping {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.mapping_version != 1 {
            return invalid("adaptedTau.mapping.mappingVersion", "must equal 1");
        }
        if self.tokamak_n == 0 || self.alpha_max == 0 || self.x_max == 0 {
            return invalid(
                "adaptedTau.mapping",
                "tokamakN, alphaMax, and xMax must be positive",
            );
        }
        let expected_stride =
            self.tokamak_n
                .checked_mul(2)
                .ok_or_else(|| ProtocolError::InvalidField {
                    field: "adaptedTau.mapping.omegaStride",
                    reason: "value overflow".to_string(),
                })?;
        if self.omega_stride != expected_stride {
            return invalid(
                "adaptedTau.mapping.omegaStride",
                format!("expected {expected_stride}, got {}", self.omega_stride),
            );
        }
        let expected_g1 = self
            .omega_stride
            .checked_mul(self.alpha_max)
            .and_then(|value| value.checked_add(self.alpha_x_max))
            .ok_or_else(|| ProtocolError::InvalidField {
                field: "adaptedTau.mapping.maxSourceG1Exponent",
                reason: "value overflow".to_string(),
            })?;
        let expected_g2 = self
            .omega_stride
            .checked_mul(self.alpha_max)
            .ok_or_else(|| ProtocolError::InvalidField {
                field: "adaptedTau.mapping.maxSourceG2Exponent",
                reason: "value overflow".to_string(),
            })?;
        if self.max_source_g1_exponent != expected_g1 || self.max_source_g2_exponent != expected_g2
        {
            return invalid(
                "adaptedTau.mapping.maxSourceExponent",
                format!(
                    "expected G1={expected_g1} and G2={expected_g2}, got G1={} and G2={}",
                    self.max_source_g1_exponent, self.max_source_g2_exponent
                ),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SourceProvenance {
    Native,
    DuskAdapted { adapted_tau_sha256: Sha256Digest },
}

impl SourceProvenance {
    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Native => Ok(()),
            Self::DuskAdapted { adapted_tau_sha256 } => {
                adapted_tau_sha256.validate("sourceProvenance.adaptedTauSha256")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdaptedTau {
    pub document_kind: String,
    pub contract_version: u32,
    pub protocol_version: String,
    pub source_provenance: DuskSourceProvenance,
    pub capacity_digest: Sha256Digest,
    pub layout_digest: Sha256Digest,
    pub mapping: DuskExponentMapping,
    pub alpha_x_chunks: Vec<PointChunkDescriptor>,
}

impl AdaptedTau {
    pub fn new(
        source_provenance: DuskSourceProvenance,
        capacity_digest: Sha256Digest,
        layout_digest: Sha256Digest,
        mapping: DuskExponentMapping,
        alpha_x_chunks: Vec<PointChunkDescriptor>,
    ) -> Result<Self, ProtocolError> {
        let value = Self {
            document_kind: ADAPTED_TAU_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            source_provenance,
            capacity_digest,
            layout_digest,
            mapping,
            alpha_x_chunks,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        document_header(
            &self.document_kind,
            ADAPTED_TAU_KIND,
            self.contract_version,
            &self.protocol_version,
        )?;
        validate_dusk_source_provenance(&self.source_provenance)?;
        self.capacity_digest.validate("adaptedTau.capacityDigest")?;
        self.layout_digest.validate("adaptedTau.layoutDigest")?;
        self.mapping.validate()?;
        if self.source_provenance.max_g1_exp_used != self.mapping.max_source_g1_exponent as usize
            || self.source_provenance.max_g2_exp_used
                != self.mapping.max_source_g2_exponent as usize
        {
            return invalid(
                "adaptedTau.sourceProvenance.maxExponentUsed",
                "source exponent bounds must equal the committed mapping bounds",
            );
        }
        validate_chunks(&self.alpha_x_chunks, "adaptedTau.alphaXChunks")
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        canonical_json(self)
    }

    pub fn from_canonical_json(bytes: &[u8]) -> Result<Self, ProtocolError> {
        parse_canonical(bytes, Self::validate)
    }

    pub fn digest(&self) -> Result<Sha256Digest, ProtocolError> {
        Ok(Sha256Digest::from_bytes(&self.to_canonical_json()?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UniversalTau {
    pub chunks: Vec<PointChunkDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CircuitSigma {
    pub private_wire_count: u64,
    pub chunks: Vec<PointChunkDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum PhasePayload {
    Phase1(UniversalTau),
    Phase2(CircuitSigma),
}

impl PhasePayload {
    fn phase(&self) -> Phase {
        match self {
            Self::Phase1(_) => Phase::Phase1,
            Self::Phase2(_) => Phase::Phase2,
        }
    }

    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Phase1(payload) => validate_chunks(&payload.chunks, "phase1.chunks"),
            Self::Phase2(payload) => validate_chunks(&payload.chunks, "phase2.chunks"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CeremonyState {
    pub document_kind: String,
    pub contract_version: u32,
    pub protocol_version: String,
    pub ceremony_id: String,
    pub phase: Phase,
    pub contribution_profile: ContributionProfile,
    pub sequence: u64,
    pub status: StateStatus,
    pub previous_state_digest: Option<Sha256Digest>,
    pub previous_phase_digest: Option<Sha256Digest>,
    pub capacity_digest: Sha256Digest,
    pub layout_digest: Sha256Digest,
    pub circuit_digest: Option<Sha256Digest>,
    pub source_provenance: SourceProvenance,
    pub payload: PhasePayload,
}

impl CeremonyState {
    pub fn new_initial_phase1(
        ceremony_id: impl Into<String>,
        contribution_profile: ContributionProfile,
        capacity_digest: Sha256Digest,
        layout_digest: Sha256Digest,
        source_provenance: SourceProvenance,
        payload: UniversalTau,
    ) -> Result<Self, ProtocolError> {
        let status = match contribution_profile {
            ContributionProfile::NativeAlphaXY => StateStatus::Genesis,
            ContributionProfile::DuskY => StateStatus::Prepared,
            ContributionProfile::CircuitGammaDeltaEta => {
                return invalid(
                    "state.contributionProfile",
                    "initial Phase 1 state requires a Phase 1 contribution profile",
                )
            }
        };
        let value = Self {
            document_kind: CEREMONY_STATE_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: ceremony_id.into(),
            phase: Phase::Phase1,
            contribution_profile,
            sequence: 0,
            status,
            previous_state_digest: None,
            previous_phase_digest: None,
            capacity_digest,
            layout_digest,
            circuit_digest: None,
            source_provenance,
            payload: PhasePayload::Phase1(payload),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn next_contributed_phase1(
        previous: &Self,
        payload: UniversalTau,
    ) -> Result<Self, ProtocolError> {
        previous.validate()?;
        if previous.phase != Phase::Phase1 {
            return invalid(
                "state.phase",
                "Phase 1 contribution requires a Phase 1 state",
            );
        }
        let sequence =
            previous
                .sequence
                .checked_add(1)
                .ok_or_else(|| ProtocolError::InvalidField {
                    field: "state.sequence",
                    reason: "sequence overflow".to_string(),
                })?;
        let value = Self {
            document_kind: CEREMONY_STATE_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: previous.ceremony_id.clone(),
            phase: Phase::Phase1,
            contribution_profile: previous.contribution_profile,
            sequence,
            status: StateStatus::Contributed,
            previous_state_digest: Some(previous.digest()?),
            previous_phase_digest: None,
            capacity_digest: previous.capacity_digest.clone(),
            layout_digest: previous.layout_digest.clone(),
            circuit_digest: None,
            source_provenance: previous.source_provenance.clone(),
            payload: PhasePayload::Phase1(payload),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn new_phase2_prepared(
        selected_phase1: &Self,
        circuit_digest: Sha256Digest,
        payload: CircuitSigma,
    ) -> Result<Self, ProtocolError> {
        selected_phase1.validate()?;
        if selected_phase1.phase != Phase::Phase1
            || selected_phase1.status != StateStatus::Contributed
        {
            return invalid(
                "state.previousPhaseDigest",
                "Phase 2 preparation requires a contributed Phase 1 state",
            );
        }
        let value = Self {
            document_kind: CEREMONY_STATE_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: selected_phase1.ceremony_id.clone(),
            phase: Phase::Phase2,
            contribution_profile: ContributionProfile::CircuitGammaDeltaEta,
            sequence: 0,
            status: StateStatus::Prepared,
            previous_state_digest: None,
            previous_phase_digest: Some(selected_phase1.digest()?),
            capacity_digest: selected_phase1.capacity_digest.clone(),
            layout_digest: selected_phase1.layout_digest.clone(),
            circuit_digest: Some(circuit_digest),
            source_provenance: selected_phase1.source_provenance.clone(),
            payload: PhasePayload::Phase2(payload),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn next_contributed_phase2(
        previous: &Self,
        payload: CircuitSigma,
    ) -> Result<Self, ProtocolError> {
        previous.validate()?;
        if previous.phase != Phase::Phase2
            || previous.contribution_profile != ContributionProfile::CircuitGammaDeltaEta
        {
            return invalid(
                "state.phase",
                "Phase 2 contribution requires a Phase 2 state",
            );
        }
        let sequence =
            previous
                .sequence
                .checked_add(1)
                .ok_or_else(|| ProtocolError::InvalidField {
                    field: "state.sequence",
                    reason: "sequence overflow".to_string(),
                })?;
        let value = Self {
            document_kind: CEREMONY_STATE_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: previous.ceremony_id.clone(),
            phase: Phase::Phase2,
            contribution_profile: ContributionProfile::CircuitGammaDeltaEta,
            sequence,
            status: StateStatus::Contributed,
            previous_state_digest: Some(previous.digest()?),
            previous_phase_digest: previous.previous_phase_digest.clone(),
            capacity_digest: previous.capacity_digest.clone(),
            layout_digest: previous.layout_digest.clone(),
            circuit_digest: previous.circuit_digest.clone(),
            source_provenance: previous.source_provenance.clone(),
            payload: PhasePayload::Phase2(payload),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        document_header(
            &self.document_kind,
            CEREMONY_STATE_KIND,
            self.contract_version,
            &self.protocol_version,
        )?;
        non_empty(&self.ceremony_id, "state.ceremonyId")?;
        self.capacity_digest.validate("state.capacityDigest")?;
        self.layout_digest.validate("state.layoutDigest")?;
        self.source_provenance.validate()?;
        self.payload.validate()?;
        if self.phase != self.contribution_profile.phase() || self.phase != self.payload.phase() {
            return invalid(
                "state.phase",
                "phase, contribution profile, and payload kind must agree",
            );
        }
        match (self.phase, self.contribution_profile, self.status) {
            (Phase::Phase1, ContributionProfile::NativeAlphaXY, StateStatus::Genesis)
            | (Phase::Phase1, ContributionProfile::NativeAlphaXY, StateStatus::Contributed)
            | (Phase::Phase1, ContributionProfile::DuskY, StateStatus::Prepared)
            | (Phase::Phase1, ContributionProfile::DuskY, StateStatus::Contributed)
            | (Phase::Phase2, ContributionProfile::CircuitGammaDeltaEta, StateStatus::Prepared)
            | (
                Phase::Phase2,
                ContributionProfile::CircuitGammaDeltaEta,
                StateStatus::Contributed,
            ) => {}
            _ => return invalid("state.status", "invalid phase/profile/status combination"),
        }
        match self.status {
            StateStatus::Genesis | StateStatus::Prepared => {
                if self.sequence != 0 || self.previous_state_digest.is_some() {
                    return invalid(
                        "state.sequence",
                        "genesis and prepared states require sequence 0 and no previous state",
                    );
                }
            }
            StateStatus::Contributed => {
                if self.sequence == 0 || self.previous_state_digest.is_none() {
                    return invalid(
                        "state.sequence",
                        "contributed states require a positive sequence and previous state digest",
                    );
                }
            }
        }
        match self.phase {
            Phase::Phase1 => {
                if self.previous_phase_digest.is_some() || self.circuit_digest.is_some() {
                    return invalid(
                        "state.previousPhaseDigest",
                        "Phase 1 cannot bind a previous phase or circuit digest",
                    );
                }
                match (&self.contribution_profile, &self.source_provenance) {
                    (ContributionProfile::NativeAlphaXY, SourceProvenance::Native)
                    | (ContributionProfile::DuskY, SourceProvenance::DuskAdapted { .. }) => {}
                    _ => {
                        return invalid(
                            "state.sourceProvenance",
                            "Phase 1 profile and source provenance disagree",
                        )
                    }
                }
            }
            Phase::Phase2 => {
                if self.previous_phase_digest.is_none() || self.circuit_digest.is_none() {
                    return invalid(
                        "state.previousPhaseDigest",
                        "Phase 2 requires previous phase and circuit digests",
                    );
                }
                self.previous_phase_digest
                    .as_ref()
                    .expect("checked above")
                    .validate("state.previousPhaseDigest")?;
                self.circuit_digest
                    .as_ref()
                    .expect("checked above")
                    .validate("state.circuitDigest")?;
            }
        }
        if let Some(digest) = &self.previous_state_digest {
            digest.validate("state.previousStateDigest")?;
        }
        Ok(())
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        canonical_json(self)
    }

    pub fn from_canonical_json(bytes: &[u8]) -> Result<Self, ProtocolError> {
        parse_canonical(bytes, Self::validate)
    }

    pub fn digest(&self) -> Result<Sha256Digest, ProtocolError> {
        Ok(Sha256Digest::from_bytes(&self.to_canonical_json()?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EncodedPoint {
    pub encoding: String,
    pub hex: String,
}

impl EncodedPoint {
    pub fn from_g1_hex(hex: impl Into<String>) -> Result<Self, ProtocolError> {
        let point = Self {
            encoding: POINT_ENCODING.to_string(),
            hex: hex.into(),
        };
        point.validate(CurveGroup::G1, "encodedPoint")?;
        Ok(point)
    }

    pub fn from_g2_hex(hex: impl Into<String>) -> Result<Self, ProtocolError> {
        let point = Self {
            encoding: POINT_ENCODING.to_string(),
            hex: hex.into(),
        };
        point.validate(CurveGroup::G2, "encodedPoint")?;
        Ok(point)
    }

    fn validate(&self, group: CurveGroup, field: &'static str) -> Result<(), ProtocolError> {
        if self.encoding != POINT_ENCODING {
            return invalid(field, format!("encoding must equal {POINT_ENCODING}"));
        }
        let expected_hex_len = usize::try_from(group.compressed_point_bytes() * 2)
            .expect("compressed point lengths fit usize");
        if self.hex.len() != expected_hex_len
            || !self
                .hex
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return invalid(
                field,
                format!("must contain {expected_hex_len} lowercase hexadecimal digits"),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretContributionProof {
    pub parameter: TrapdoorParameter,
    pub contribution_g1: EncodedPoint,
    pub contribution_g2: EncodedPoint,
    pub proof_of_knowledge_g2: EncodedPoint,
}

impl SecretContributionProof {
    fn validate(&self) -> Result<(), ProtocolError> {
        self.contribution_g1
            .validate(CurveGroup::G1, "proof.contributionG1")?;
        self.contribution_g2
            .validate(CurveGroup::G2, "proof.contributionG2")?;
        self.proof_of_knowledge_g2
            .validate(CurveGroup::G2, "proof.proofOfKnowledgeG2")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContributionReceipt {
    pub document_kind: String,
    pub contract_version: u32,
    pub protocol_version: String,
    pub ceremony_id: String,
    pub phase: Phase,
    pub contribution_profile: ContributionProfile,
    pub contributor_index: u64,
    pub previous_state_digest: Sha256Digest,
    pub current_state_digest: Sha256Digest,
    pub entropy_mode: ContributionEntropyMode,
    pub secret_proofs: Vec<SecretContributionProof>,
    pub verification_transcript_digest: Sha256Digest,
}

impl ContributionReceipt {
    pub fn new(
        previous: &CeremonyState,
        current: &CeremonyState,
        entropy_mode: ContributionEntropyMode,
        secret_proofs: Vec<SecretContributionProof>,
        verification_transcript_digest: Sha256Digest,
    ) -> Result<Self, ProtocolError> {
        previous.validate()?;
        current.validate()?;
        let value = Self {
            document_kind: CONTRIBUTION_RECEIPT_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: current.ceremony_id.clone(),
            phase: current.phase,
            contribution_profile: current.contribution_profile,
            contributor_index: current.sequence,
            previous_state_digest: previous.digest()?,
            current_state_digest: current.digest()?,
            entropy_mode,
            secret_proofs,
            verification_transcript_digest,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        document_header(
            &self.document_kind,
            CONTRIBUTION_RECEIPT_KIND,
            self.contract_version,
            &self.protocol_version,
        )?;
        non_empty(&self.ceremony_id, "receipt.ceremonyId")?;
        if self.contributor_index == 0 {
            return invalid("receipt.contributorIndex", "must be positive");
        }
        if self.phase != self.contribution_profile.phase() {
            return invalid("receipt.phase", "phase and contribution profile disagree");
        }
        self.previous_state_digest
            .validate("receipt.previousStateDigest")?;
        self.current_state_digest
            .validate("receipt.currentStateDigest")?;
        self.verification_transcript_digest
            .validate("receipt.verificationTranscriptDigest")?;
        if self.previous_state_digest == self.current_state_digest {
            return invalid(
                "receipt.currentStateDigest",
                "must differ from previous state digest",
            );
        }
        let expected_parameters = self.contribution_profile.parameters();
        let actual_parameters = self
            .secret_proofs
            .iter()
            .map(|proof| proof.parameter)
            .collect::<Vec<_>>();
        if actual_parameters != expected_parameters {
            return invalid(
                "receipt.secretProofs",
                "proof parameters or order do not match the contribution profile",
            );
        }
        for proof in &self.secret_proofs {
            proof.validate()?;
        }
        Ok(())
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, ProtocolError> {
        self.validate()?;
        canonical_json(self)
    }

    pub fn from_canonical_json(bytes: &[u8]) -> Result<Self, ProtocolError> {
        parse_canonical(bytes, Self::validate)
    }

    pub fn digest(&self) -> Result<Sha256Digest, ProtocolError> {
        Ok(Sha256Digest::from_bytes(&self.to_canonical_json()?))
    }
}

pub fn validate_state_selection(
    state: &CeremonyState,
    receipts: &[ContributionReceipt],
) -> Result<(), ProtocolError> {
    state.validate()?;
    if state.status != StateStatus::Contributed {
        return invalid("state.status", "only a contributed state can be selected");
    }
    if receipts.is_empty() {
        return Err(ProtocolError::EmptyReceiptChain);
    }
    let mut previous_current: Option<&Sha256Digest> = None;
    let mut has_qualifying = false;
    for (offset, receipt) in receipts.iter().enumerate() {
        receipt.validate()?;
        let expected_index = u64::try_from(offset)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| ProtocolError::InvalidField {
                field: "receipt.contributorIndex",
                reason: "contributor index overflow".to_string(),
            })?;
        if receipt.contributor_index != expected_index {
            return Err(ProtocolError::BrokenReceiptChain {
                contributor_index: receipt.contributor_index,
            });
        }
        if receipt.ceremony_id != state.ceremony_id
            || receipt.phase != state.phase
            || receipt.contribution_profile != state.contribution_profile
        {
            return invalid(
                "receipt",
                "receipt ceremony, phase, or profile differs from selected state",
            );
        }
        if let Some(previous_current) = previous_current {
            if previous_current != &receipt.previous_state_digest {
                return Err(ProtocolError::BrokenReceiptChain {
                    contributor_index: receipt.contributor_index,
                });
            }
        }
        previous_current = Some(&receipt.current_state_digest);
        has_qualifying |= receipt.entropy_mode.qualifies_for_selection();
    }
    if previous_current != Some(&state.digest()?) {
        return Err(ProtocolError::BrokenReceiptChain {
            contributor_index: receipts
                .last()
                .expect("non-empty receipt chain checked above")
                .contributor_index,
        });
    }
    let last_receipt = receipts
        .last()
        .expect("non-empty receipt chain checked above");
    if state.sequence != last_receipt.contributor_index
        || state.previous_state_digest.as_ref() != Some(&last_receipt.previous_state_digest)
    {
        return Err(ProtocolError::BrokenReceiptChain {
            contributor_index: last_receipt.contributor_index,
        });
    }
    if !has_qualifying {
        return Err(ProtocolError::MissingQualifyingContribution);
    }
    Ok(())
}

fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, ProtocolError> {
    serde_json::to_vec(value).map_err(|error| ProtocolError::Json(error.to_string()))
}

fn parse_canonical<T>(
    bytes: &[u8],
    validate: impl FnOnce(&T) -> Result<(), ProtocolError>,
) -> Result<T, ProtocolError>
where
    T: DeserializeOwned + Serialize,
{
    let value: T =
        serde_json::from_slice(bytes).map_err(|error| ProtocolError::Json(error.to_string()))?;
    validate(&value)?;
    if canonical_json(&value)? != bytes {
        return Err(ProtocolError::NonCanonicalJson);
    }
    Ok(value)
}

fn validate_chunks(
    chunks: &[PointChunkDescriptor],
    field: &'static str,
) -> Result<(), ProtocolError> {
    if chunks.is_empty() {
        return invalid(field, "must contain at least one chunk");
    }
    for chunk in chunks {
        chunk.validate()?;
    }
    Ok(())
}

fn validate_dusk_source_provenance(provenance: &DuskSourceProvenance) -> Result<(), ProtocolError> {
    non_empty(
        &provenance.source_url,
        "adaptedTau.sourceProvenance.sourceUrl",
    )?;
    non_empty(
        &provenance.raw_encoding,
        "adaptedTau.sourceProvenance.rawEncoding",
    )?;
    non_empty(
        &provenance.pinned_contribution,
        "adaptedTau.sourceProvenance.pinnedContribution",
    )?;
    non_empty(
        &provenance.pinned_readme_url,
        "adaptedTau.sourceProvenance.pinnedReadmeUrl",
    )?;
    non_empty(
        &provenance.pinned_drive_file_id,
        "adaptedTau.sourceProvenance.pinnedDriveFileId",
    )?;
    lowercase_hex_64(
        &provenance.expected_source_sha256,
        "adaptedTau.sourceProvenance.expectedSourceSha256",
    )?;
    lowercase_hex_64(
        &provenance.actual_source_sha256,
        "adaptedTau.sourceProvenance.actualSourceSha256",
    )?;
    if provenance.expected_source_sha256 != provenance.actual_source_sha256 {
        return invalid(
            "adaptedTau.sourceProvenance.actualSourceSha256",
            "must equal expectedSourceSha256",
        );
    }
    if !matches!(
        provenance.raw_encoding.as_str(),
        "compressed-response" | "uncompressed-challenge"
    ) {
        return invalid(
            "adaptedTau.sourceProvenance.rawEncoding",
            "unsupported Dusk artifact encoding",
        );
    }
    if provenance.max_g1_exp_used == 0 || provenance.max_g2_exp_used == 0 {
        return invalid(
            "adaptedTau.sourceProvenance.maxExponentUsed",
            "verified G1 and G2 exponent bounds must be positive",
        );
    }
    if !provenance.transcript_consistency_verified {
        return invalid(
            "adaptedTau.sourceProvenance.transcriptConsistencyVerified",
            "must be true",
        );
    }
    Ok(())
}

fn lowercase_hex_64(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    if value.len() != 64
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return invalid(
            field,
            "must contain exactly 64 lowercase hexadecimal digits",
        );
    }
    Ok(())
}

fn document_header(
    actual_kind: &str,
    expected_kind: &'static str,
    contract_version: u32,
    protocol_version: &str,
) -> Result<(), ProtocolError> {
    if actual_kind != expected_kind {
        return invalid("documentKind", format!("must equal {expected_kind}"));
    }
    if contract_version != CONTRACT_VERSION {
        return invalid("contractVersion", format!("must equal {CONTRACT_VERSION}"));
    }
    if protocol_version != PROTOCOL_VERSION {
        return invalid("protocolVersion", format!("must equal {PROTOCOL_VERSION}"));
    }
    Ok(())
}

fn non_empty(value: &str, field: &'static str) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return invalid(field, "must not be empty");
    }
    Ok(())
}

fn invalid<T>(field: &'static str, reason: impl Into<String>) -> Result<T, ProtocolError> {
    Err(ProtocolError::InvalidField {
        field,
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: u8) -> Sha256Digest {
        Sha256Digest::from_bytes(&[byte])
    }

    fn point(group: CurveGroup, byte: char) -> EncodedPoint {
        EncodedPoint {
            encoding: POINT_ENCODING.to_string(),
            hex: byte
                .to_string()
                .repeat((group.compressed_point_bytes() * 2) as usize),
        }
    }

    fn proof(parameter: TrapdoorParameter) -> SecretContributionProof {
        SecretContributionProof {
            parameter,
            contribution_g1: point(CurveGroup::G1, '1'),
            contribution_g2: point(CurveGroup::G2, '2'),
            proof_of_knowledge_g2: point(CurveGroup::G2, '3'),
        }
    }

    fn chunk(family: &str) -> PointChunkDescriptor {
        let bytes = vec![7u8; COMPRESSED_G1_BYTES as usize];
        PointChunkDescriptor {
            family: family.to_string(),
            group: CurveGroup::G1,
            shape: vec![1],
            start_indices: vec![0],
            point_count: 1,
            byte_length: COMPRESSED_G1_BYTES,
            encoding: POINT_ENCODING.to_string(),
            sha256: Sha256Digest::from_bytes(&bytes),
        }
    }

    fn dusk_source_provenance() -> DuskSourceProvenance {
        DuskSourceProvenance {
            source_url: "https://example.invalid/dusk.response".to_string(),
            source_size_bytes: 144,
            raw_encoding: "compressed-response".to_string(),
            pinned_contribution: "0015".to_string(),
            pinned_readme_url: "https://example.invalid/README.md".to_string(),
            pinned_drive_file_id: "drive-file".to_string(),
            expected_source_sha256: "1".repeat(64),
            actual_source_sha256: "1".repeat(64),
            auto_downloaded: false,
            downloaded_contribution: None,
            downloaded_readme_url: None,
            downloaded_drive_file_id: None,
            max_g1_exp_used: 80,
            max_g2_exp_used: 64,
            transcript_consistency_verified: true,
        }
    }

    fn state(profile: ContributionProfile, status: StateStatus) -> CeremonyState {
        let phase = profile.phase();
        let source_provenance = match profile {
            ContributionProfile::DuskY => SourceProvenance::DuskAdapted {
                adapted_tau_sha256: digest(9),
            },
            _ => SourceProvenance::Native,
        };
        let payload = match phase {
            Phase::Phase1 => PhasePayload::Phase1(UniversalTau {
                chunks: vec![chunk("xy")],
            }),
            Phase::Phase2 => PhasePayload::Phase2(CircuitSigma {
                private_wire_count: 1,
                chunks: vec![chunk("sigma")],
            }),
        };
        CeremonyState {
            document_kind: CEREMONY_STATE_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: "ceremony-1".to_string(),
            phase,
            contribution_profile: profile,
            sequence: if status == StateStatus::Contributed {
                1
            } else {
                0
            },
            status,
            previous_state_digest: (status == StateStatus::Contributed).then(|| digest(1)),
            previous_phase_digest: (phase == Phase::Phase2).then(|| digest(2)),
            capacity_digest: digest(3),
            layout_digest: digest(4),
            circuit_digest: (phase == Phase::Phase2).then(|| digest(5)),
            source_provenance,
            payload,
        }
    }

    fn receipt(
        profile: ContributionProfile,
        previous: Sha256Digest,
        current: Sha256Digest,
        entropy_mode: ContributionEntropyMode,
    ) -> ContributionReceipt {
        ContributionReceipt {
            document_kind: CONTRIBUTION_RECEIPT_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: "ceremony-1".to_string(),
            phase: profile.phase(),
            contribution_profile: profile,
            contributor_index: 1,
            previous_state_digest: previous,
            current_state_digest: current,
            entropy_mode,
            secret_proofs: profile.parameters().iter().copied().map(proof).collect(),
            verification_transcript_digest: digest(6),
        }
    }

    #[test]
    fn canonical_round_trips_cover_all_state_variants() {
        for value in [
            state(ContributionProfile::NativeAlphaXY, StateStatus::Genesis),
            state(ContributionProfile::NativeAlphaXY, StateStatus::Contributed),
            state(ContributionProfile::DuskY, StateStatus::Prepared),
            state(ContributionProfile::DuskY, StateStatus::Contributed),
            state(
                ContributionProfile::CircuitGammaDeltaEta,
                StateStatus::Prepared,
            ),
            state(
                ContributionProfile::CircuitGammaDeltaEta,
                StateStatus::Contributed,
            ),
        ] {
            let bytes = value.to_canonical_json().unwrap();
            let decoded = CeremonyState::from_canonical_json(&bytes).unwrap();
            assert_eq!(decoded, value);
        }
    }

    #[test]
    fn adapted_tau_round_trips_canonically() {
        let value = AdaptedTau {
            document_kind: ADAPTED_TAU_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            source_provenance: dusk_source_provenance(),
            capacity_digest: digest(2),
            layout_digest: digest(3),
            mapping: DuskExponentMapping {
                mapping_version: 1,
                tokamak_n: 8,
                alpha_max: 4,
                x_max: 16,
                alpha_x_max: 16,
                omega_stride: 16,
                max_source_g1_exponent: 80,
                max_source_g2_exponent: 64,
            },
            alpha_x_chunks: vec![chunk("alphaX")],
        };
        let bytes = value.to_canonical_json().unwrap();
        assert_eq!(AdaptedTau::from_canonical_json(&bytes).unwrap(), value);
    }

    #[test]
    fn receipts_round_trip_with_profile_specific_proofs() {
        for profile in [
            ContributionProfile::NativeAlphaXY,
            ContributionProfile::DuskY,
            ContributionProfile::CircuitGammaDeltaEta,
        ] {
            let value = receipt(
                profile,
                digest(1),
                digest(2),
                ContributionEntropyMode::Random,
            );
            let bytes = value.to_canonical_json().unwrap();
            assert_eq!(
                ContributionReceipt::from_canonical_json(&bytes).unwrap(),
                value
            );
        }
    }

    #[test]
    fn rejects_wrong_versions_kinds_profiles_and_proof_shapes() {
        let mut value = state(ContributionProfile::NativeAlphaXY, StateStatus::Genesis);
        value.contract_version += 1;
        assert!(value.validate().is_err());
        value.contract_version = CONTRACT_VERSION;
        value.document_kind = "legacyState".to_string();
        assert!(value.validate().is_err());

        let mut invalid_profile = state(ContributionProfile::DuskY, StateStatus::Prepared);
        invalid_profile.source_provenance = SourceProvenance::Native;
        assert!(invalid_profile.validate().is_err());

        let mut invalid_receipt = receipt(
            ContributionProfile::NativeAlphaXY,
            digest(1),
            digest(2),
            ContributionEntropyMode::Random,
        );
        invalid_receipt.secret_proofs.pop();
        assert!(invalid_receipt.validate().is_err());
    }

    #[test]
    fn rejects_noncanonical_and_trailing_json() {
        let value = state(ContributionProfile::NativeAlphaXY, StateStatus::Genesis);
        let mut pretty = serde_json::to_vec_pretty(&value).unwrap();
        assert_eq!(
            CeremonyState::from_canonical_json(&pretty).unwrap_err(),
            ProtocolError::NonCanonicalJson
        );
        pretty.extend_from_slice(b" trailing");
        assert!(matches!(
            CeremonyState::from_canonical_json(&pretty),
            Err(ProtocolError::Json(_))
        ));
    }

    #[test]
    fn validates_chunk_length_shape_and_digest() {
        let bytes = vec![7u8; COMPRESSED_G1_BYTES as usize];
        let descriptor = chunk("x");
        descriptor.validate_bytes(&bytes).unwrap();

        let mut malformed = descriptor.clone();
        malformed.shape = vec![2];
        assert!(malformed.validate().is_err());

        let mut corrupted = bytes;
        corrupted[0] ^= 1;
        assert!(matches!(
            descriptor.validate_bytes(&corrupted),
            Err(ProtocolError::ChunkDigestMismatch { .. })
        ));
    }

    #[test]
    fn selection_requires_a_complete_qualifying_chain() {
        let selected = state(ContributionProfile::DuskY, StateStatus::Contributed);
        let selected_digest = selected.digest().unwrap();
        let beacon = receipt(
            ContributionProfile::DuskY,
            digest(1),
            selected_digest.clone(),
            ContributionEntropyMode::Beacon,
        );
        assert_eq!(
            validate_state_selection(&selected, &[beacon.clone()]).unwrap_err(),
            ProtocolError::MissingQualifyingContribution
        );

        let mut random = beacon;
        random.entropy_mode = ContributionEntropyMode::Random;
        validate_state_selection(&selected, &[random]).unwrap();

        let mut wrong_profile = receipt(
            ContributionProfile::NativeAlphaXY,
            digest(1),
            selected_digest,
            ContributionEntropyMode::Random,
        );
        wrong_profile.ceremony_id = selected.ceremony_id.clone();
        assert!(validate_state_selection(&selected, &[wrong_profile]).is_err());
    }

    #[test]
    fn state_digest_changes_when_bound_metadata_changes() {
        let value = state(ContributionProfile::NativeAlphaXY, StateStatus::Genesis);
        let original = value.digest().unwrap();
        let mut changed = value;
        changed.payload = PhasePayload::Phase1(UniversalTau {
            chunks: vec![chunk("different")],
        });
        assert_ne!(changed.digest().unwrap(), original);
    }
}
