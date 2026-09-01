use crate::protocol::{
    validate_state_selection, ContributionProfile, ContributionReceipt, Phase, Sha256Digest,
    StateStatus, CONTRACT_VERSION, PROTOCOL_VERSION,
};
use crate::state_bundle::{
    read_state_bundle, verify_bundle_transition, write_phase1_bundle, write_phase2_bundle,
    StateArtifact, StateBundle, StateBundleError,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use thiserror::Error;

const CHAIN_FILE: &str = "chain.json";
const STATES_DIRECTORY: &str = "states";
const CHAIN_DOCUMENT_KIND: &str = "tokamakMpcCeremonyChain";

#[derive(Debug, Error)]
pub enum CeremonyWorkspaceError {
    #[error("failed to {operation} at {}: {source}", path.display())]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("invalid ceremony workspace: {0}")]
    Invalid(String),
    #[error(transparent)]
    Bundle(#[from] StateBundleError),
    #[error("invalid ceremony protocol chain: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CeremonyChainEntry {
    pub state_digest: Sha256Digest,
    pub phase: Phase,
    pub contribution_profile: ContributionProfile,
    pub sequence: u64,
    pub status: StateStatus,
    pub incoming_receipt_digest: Option<Sha256Digest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CeremonyChain {
    pub document_kind: String,
    pub contract_version: u32,
    pub protocol_version: String,
    pub ceremony_id: String,
    pub entries: Vec<CeremonyChainEntry>,
}

impl CeremonyChain {
    fn new(first: &StateBundle) -> Result<Self, CeremonyWorkspaceError> {
        Ok(Self {
            document_kind: CHAIN_DOCUMENT_KIND.to_string(),
            contract_version: CONTRACT_VERSION,
            protocol_version: PROTOCOL_VERSION.to_string(),
            ceremony_id: first.state().ceremony_id.clone(),
            entries: vec![entry(first)?],
        })
    }

    fn validate_header(&self) -> Result<(), CeremonyWorkspaceError> {
        if self.document_kind != CHAIN_DOCUMENT_KIND
            || self.contract_version != CONTRACT_VERSION
            || self.protocol_version != PROTOCOL_VERSION
            || self.ceremony_id.is_empty()
            || self.entries.is_empty()
        {
            return invalid("chain header, version, ceremony ID, or entries are invalid");
        }
        Ok(())
    }

    fn to_canonical_json(&self) -> Result<Vec<u8>, CeremonyWorkspaceError> {
        self.validate_header()?;
        serde_json::to_vec(self).map_err(|error| CeremonyWorkspaceError::Invalid(error.to_string()))
    }

    fn from_canonical_json(bytes: &[u8]) -> Result<Self, CeremonyWorkspaceError> {
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|error| CeremonyWorkspaceError::Invalid(error.to_string()))?;
        value.validate_header()?;
        if value.to_canonical_json()? != bytes {
            return invalid("chain.json is not in canonical form");
        }
        Ok(value)
    }
}

pub fn initialize_workspace(
    workspace: &Path,
    initial_bundle: &Path,
) -> Result<CeremonyChain, CeremonyWorkspaceError> {
    if workspace.exists() {
        return invalid(format!(
            "refusing to overwrite existing ceremony workspace {}",
            workspace.display()
        ));
    }
    let initial = read_state_bundle(initial_bundle)?;
    if initial.state().sequence != 0
        || initial.state().status == StateStatus::Contributed
        || initial.incoming_receipt.is_some()
    {
        return invalid("initial workspace state must be a sequence-zero genesis or preparation");
    }
    fs::create_dir_all(workspace.join(STATES_DIRECTORY)).map_err(|source| {
        io_error(
            "create ceremony workspace",
            &workspace.join(STATES_DIRECTORY),
            source,
        )
    })?;
    persist_bundle(workspace, &initial)?;
    let chain = CeremonyChain::new(&initial)?;
    write_chain(workspace, &chain)?;
    verify_workspace(workspace)
}

pub fn append_bundle(
    workspace: &Path,
    candidate_bundle: &Path,
) -> Result<CeremonyChain, CeremonyWorkspaceError> {
    let mut chain = verify_workspace(workspace)?;
    let candidate = read_state_bundle(candidate_bundle)?;
    if candidate.state().ceremony_id != chain.ceremony_id {
        return invalid("candidate ceremony ID differs from the workspace");
    }
    let previous = load_entry_bundle(
        workspace,
        chain
            .entries
            .last()
            .expect("validated chain contains an entry"),
    )?;
    verify_append_transition(workspace, &chain, &previous, &candidate)?;
    persist_bundle(workspace, &candidate)?;
    chain.entries.push(entry(&candidate)?);
    write_chain(workspace, &chain)?;
    verify_workspace(workspace)
}

pub fn verify_workspace(workspace: &Path) -> Result<CeremonyChain, CeremonyWorkspaceError> {
    let path = workspace.join(CHAIN_FILE);
    let bytes = fs::read(&path).map_err(|source| io_error("read ceremony chain", &path, source))?;
    let chain = CeremonyChain::from_canonical_json(&bytes)?;
    let mut previous: Option<StateBundle> = None;
    for (position, expected_entry) in chain.entries.iter().enumerate() {
        let current = load_entry_bundle(workspace, expected_entry)?;
        if current.state().ceremony_id != chain.ceremony_id || entry(&current)? != *expected_entry {
            return invalid(format!(
                "chain entry {position} differs from its state bundle"
            ));
        }
        if let Some(previous) = &previous {
            verify_append_transition(workspace, &chain, previous, &current)?;
        } else if current.state().sequence != 0
            || current.state().status == StateStatus::Contributed
        {
            return invalid("the first chain entry must be a sequence-zero genesis or preparation");
        }
        previous = Some(current);
    }
    Ok(chain)
}

pub fn state_bundle_path(workspace: &Path, digest: &Sha256Digest) -> PathBuf {
    workspace.join(STATES_DIRECTORY).join(
        digest
            .as_str()
            .strip_prefix("sha256:")
            .expect("validated digest"),
    )
}

pub fn selected_phase1(
    workspace: &Path,
) -> Result<
    (
        crate::universal_tau::UniversalTauArtifact,
        Vec<ContributionReceipt>,
    ),
    CeremonyWorkspaceError,
> {
    let chain = verify_workspace(workspace)?;
    let selected_entry = chain
        .entries
        .iter()
        .rev()
        .find(|entry| entry.phase == Phase::Phase1)
        .ok_or_else(|| {
            CeremonyWorkspaceError::Invalid("workspace contains no Phase 1 state".into())
        })?;
    let selected = load_entry_bundle(workspace, selected_entry)?;
    let receipts = phase_receipts(workspace, &chain, Phase::Phase1)?;
    validate_state_selection(selected.state(), &receipts)?;
    match selected.artifact {
        StateArtifact::Phase1(artifact) => Ok((artifact, receipts)),
        StateArtifact::Phase2(_) => unreachable!("selected entry is authenticated as Phase 1"),
    }
}

fn verify_append_transition(
    workspace: &Path,
    chain: &CeremonyChain,
    previous: &StateBundle,
    current: &StateBundle,
) -> Result<(), CeremonyWorkspaceError> {
    match (previous.state().phase, current.state().phase) {
        (left, right) if left == right => verify_bundle_transition(previous, current)?,
        (Phase::Phase1, Phase::Phase2) => {
            if previous.state().status != StateStatus::Contributed
                || current.state().status != StateStatus::Prepared
                || current.state().sequence != 0
                || current.incoming_receipt.is_some()
                || current.state().previous_phase_digest.as_ref()
                    != Some(&previous.state().digest()?)
                || current.state().capacity_digest != previous.state().capacity_digest
                || current.state().layout_digest != previous.state().layout_digest
            {
                return invalid("invalid selected Phase 1 to prepared Phase 2 boundary");
            }
            let receipts = phase_receipts(workspace, chain, Phase::Phase1)?;
            validate_state_selection(previous.state(), &receipts)?;
        }
        _ => {
            return invalid("ceremony phases are reordered or skip the Phase 1 to Phase 2 boundary")
        }
    }
    Ok(())
}

fn phase_receipts(
    workspace: &Path,
    chain: &CeremonyChain,
    phase: Phase,
) -> Result<Vec<ContributionReceipt>, CeremonyWorkspaceError> {
    chain
        .entries
        .iter()
        .filter(|entry| entry.phase == phase && entry.status == StateStatus::Contributed)
        .map(|entry| {
            load_entry_bundle(workspace, entry)?
                .incoming_receipt
                .ok_or_else(|| {
                    CeremonyWorkspaceError::Invalid("contributed state omits its receipt".into())
                })
        })
        .collect()
}

fn persist_bundle(workspace: &Path, bundle: &StateBundle) -> Result<(), CeremonyWorkspaceError> {
    let digest = bundle.state().digest()?;
    let destination = state_bundle_path(workspace, &digest);
    if destination.exists() {
        let existing = read_state_bundle(&destination)?;
        if existing.state().digest()? == digest
            && existing.incoming_receipt == bundle.incoming_receipt
        {
            return Ok(());
        }
        return invalid(format!(
            "state digest directory {} contains different data",
            destination.display()
        ));
    }
    match &bundle.artifact {
        StateArtifact::Phase1(artifact) => {
            write_phase1_bundle(&destination, artifact, bundle.incoming_receipt.as_ref())?
        }
        StateArtifact::Phase2(artifact) => {
            write_phase2_bundle(&destination, artifact, bundle.incoming_receipt.as_ref())?
        }
    }
    Ok(())
}

fn load_entry_bundle(
    workspace: &Path,
    entry: &CeremonyChainEntry,
) -> Result<StateBundle, CeremonyWorkspaceError> {
    read_state_bundle(&state_bundle_path(workspace, &entry.state_digest)).map_err(Into::into)
}

fn entry(bundle: &StateBundle) -> Result<CeremonyChainEntry, CeremonyWorkspaceError> {
    Ok(CeremonyChainEntry {
        state_digest: bundle.state().digest()?,
        phase: bundle.state().phase,
        contribution_profile: bundle.state().contribution_profile,
        sequence: bundle.state().sequence,
        status: bundle.state().status,
        incoming_receipt_digest: bundle
            .incoming_receipt
            .as_ref()
            .map(ContributionReceipt::digest)
            .transpose()?,
    })
}

fn write_chain(workspace: &Path, chain: &CeremonyChain) -> Result<(), CeremonyWorkspaceError> {
    let bytes = chain.to_canonical_json()?;
    let mut temporary = NamedTempFile::new_in(workspace)
        .map_err(|source| io_error("create temporary chain index", workspace, source))?;
    use std::io::Write as _;
    temporary
        .write_all(&bytes)
        .map_err(|source| io_error("write temporary chain index", temporary.path(), source))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| io_error("sync temporary chain index", temporary.path(), source))?;
    let destination = workspace.join(CHAIN_FILE);
    temporary
        .persist(&destination)
        .map_err(|error| io_error("commit ceremony chain", &destination, error.error))?;
    Ok(())
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> CeremonyWorkspaceError {
    CeremonyWorkspaceError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn invalid<T>(reason: impl Into<String>) -> Result<T, CeremonyWorkspaceError> {
    Err(CeremonyWorkspaceError::Invalid(reason.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contribution_kernel::SecretShares;
    use crate::phase1_contribution::contribute_phase1;
    use crate::protocol::{ContributionEntropyMode, TrapdoorParameter};
    use crate::universal_tau::UniversalTauArtifact;
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    use libs::utils::SetupShape;

    fn shape() -> SetupShape {
        SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        }
    }

    #[test]
    fn workspace_appends_only_verified_immutable_states_and_revalidates_index() {
        let root = tempfile::tempdir().unwrap();
        let initial_path = root.path().join("initial");
        let contributed_path = root.path().join("contributed");
        let workspace = root.path().join("workspace");
        let initial = UniversalTauArtifact::initialize_native("workspace-test", &shape()).unwrap();
        write_phase1_bundle(&initial_path, &initial, None).unwrap();
        initialize_workspace(&workspace, &initial_path).unwrap();

        let shares = SecretShares::new(
            ContributionProfile::NativeAlphaXY,
            vec![
                (TrapdoorParameter::Alpha, ScalarField::from_u32(2)),
                (TrapdoorParameter::X, ScalarField::from_u32(3)),
                (TrapdoorParameter::Y, ScalarField::from_u32(5)),
            ],
        )
        .unwrap();
        let contributed =
            contribute_phase1(&initial, &shares, ContributionEntropyMode::Random).unwrap();
        write_phase1_bundle(
            &contributed_path,
            &contributed.artifact,
            Some(&contributed.receipt),
        )
        .unwrap();
        let chain = append_bundle(&workspace, &contributed_path).unwrap();
        assert_eq!(chain.entries.len(), 2);
        assert_eq!(verify_workspace(&workspace).unwrap(), chain);

        let mut tampered: serde_json::Value =
            serde_json::from_slice(&fs::read(workspace.join(CHAIN_FILE)).unwrap()).unwrap();
        tampered["entries"][1]["sequence"] = serde_json::json!(9);
        fs::write(
            workspace.join(CHAIN_FILE),
            serde_json::to_vec(&tampered).unwrap(),
        )
        .unwrap();
        assert!(verify_workspace(&workspace).is_err());
    }
}
