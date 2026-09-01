use crate::alpha_x_basis::{
    read_adapted_tau_bundle, DuskTauAdaptor,
};
use crate::ceremony_workspace::{
    append_bundle, initialize_workspace, selected_phase1, verify_workspace,
    CeremonyWorkspaceError,
};
use crate::flows::{phase2_prepare::prepare_selected_phase1_from_qap, MpcSetupError};
use crate::protocol::Sha256Digest;
use crate::state_bundle::{write_phase1_bundle, write_phase2_bundle, StateBundleError};
use crate::universal_tau::{MonomialLayout, UniversalTauArtifact, UniversalTauError};
use libs::cli::CliDiagnostic;
use libs::errors::ArtifactError;
use libs::frontend_artifacts::SetupParams;
use libs::utils::{try_setup_shape, try_validate_setup_shape, SetupShape};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tempfile::Builder;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OperatorError {
    #[error("invalid operator command: {0}")]
    InvalidCommand(String),
    #[error("failed to {operation} at {}: {source}", path.display())]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    UniversalTau(#[from] UniversalTauError),
    #[error(transparent)]
    Bundle(#[from] StateBundleError),
    #[error(transparent)]
    Workspace(#[from] CeremonyWorkspaceError),
    #[error("invalid ceremony protocol identity: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error(transparent)]
    Setup(#[from] MpcSetupError),
}

impl CliDiagnostic for OperatorError {
    fn hint(&self) -> &'static str {
        match self {
            Self::InvalidCommand(_) => "Use a new output path and the preceding verified operator artifact.",
            Self::Io { .. } | Self::Artifact(_) => "Check the QAP and artifact paths and their read/write permissions.",
            Self::UniversalTau(_) | Self::Bundle(_) | Self::Protocol(_) => "Reject the artifact and verify its layout, state manifest, and point chunks.",
            Self::Workspace(_) => "Verify the append-only ceremony workspace before selecting or appending a state.",
            Self::Setup(_) => "Inspect the circuit artifacts and selected Phase 1 state before retrying preparation.",
        }
    }
}

pub fn initialize_native(
    ceremony_id: &str,
    qap_path: &Path,
    output: &Path,
) -> Result<(), OperatorError> {
    require_ceremony_id(ceremony_id)?;
    let shape = load_shape(qap_path)?;
    let artifact = UniversalTauArtifact::initialize_native(ceremony_id, &shape)?;
    write_phase1_bundle(output, &artifact, None)?;
    println!("Native Phase 1 genesis committed: {}", artifact.state.digest()?.as_str());
    Ok(())
}

pub fn adapt_dusk(
    qap_path: &Path,
    raw_path: &Path,
    output: &Path,
) -> Result<(), OperatorError> {
    if output.exists() {
        return Err(OperatorError::InvalidCommand(format!(
            "refusing to overwrite existing adaptor output {}",
            output.display()
        )));
    }
    let shape = load_shape(qap_path)?;
    let layout = MonomialLayout::derive(&shape)?;
    let adapted = DuskTauAdaptor::adapt_pinned_file(
        raw_path
            .to_str()
            .ok_or_else(|| OperatorError::InvalidCommand("Dusk raw path is not UTF-8".into()))?,
        MonomialLayout::capacity_digest(&shape)?,
        layout.digest()?,
        layout.dusk_adaptor_layout()?,
    )
    .map_err(|source| io_error("adapt pinned Dusk tau", raw_path, source))?;
    let parent = output.parent().filter(|value| !value.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|source| io_error("create adaptor output parent", parent, source))?;
    let temporary = Builder::new()
        .prefix(".adapted-tau-")
        .tempdir_in(parent)
        .map_err(|source| io_error("create temporary adaptor bundle", parent, source))?;
    adapted
        .write_bundle(temporary.path())
        .map_err(|source| io_error("write adapted tau bundle", temporary.path(), source))?;
    read_adapted_tau_bundle(temporary.path())
        .map_err(|source| io_error("verify adapted tau bundle", temporary.path(), source))?;
    let temporary_path = temporary.keep();
    if let Err(source) = fs::rename(&temporary_path, output) {
        let _ = fs::remove_dir_all(&temporary_path);
        return Err(io_error("commit adapted tau bundle", output, source));
    }
    println!("Dusk tau adaptation committed: {}", adapted.manifest().digest()?.as_str());
    Ok(())
}

pub fn prepare_dusk_phase1(
    ceremony_id: &str,
    qap_path: &Path,
    adapted_tau: &Path,
    output: &Path,
) -> Result<(), OperatorError> {
    require_ceremony_id(ceremony_id)?;
    let shape = load_shape(qap_path)?;
    let adapted = read_adapted_tau_bundle(adapted_tau)
        .map_err(|source| io_error("read adapted tau bundle", adapted_tau, source))?;
    let artifact = UniversalTauArtifact::prepare_from_adapted_tau(ceremony_id, &shape, &adapted)?;
    write_phase1_bundle(output, &artifact, None)?;
    println!("Dusk-backed Phase 1 preparation committed: {}", artifact.state.digest()?.as_str());
    Ok(())
}

pub fn prepare_circuit(
    workspace: &Path,
    qap_path: &Path,
    output: &Path,
) -> Result<(), OperatorError> {
    let (selected, receipts) = selected_phase1(workspace)?;
    let circuit_digest = Sha256Digest::parse(
        env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_SOURCE_DIGEST").to_string(),
    )?;
    let artifact = prepare_selected_phase1_from_qap(
        &selected,
        &receipts,
        qap_path,
        circuit_digest,
    )?;
    write_phase2_bundle(output, &artifact, None)?;
    println!("Circuit-bound Phase 2 preparation committed: {}", artifact.state.digest()?.as_str());
    Ok(())
}

pub fn initialize_chain(workspace: &Path, initial: &Path) -> Result<(), OperatorError> {
    let chain = initialize_workspace(workspace, initial)?;
    println!("Ceremony workspace initialized with {} state", chain.entries.len());
    Ok(())
}

pub fn append_chain(workspace: &Path, bundle: &Path) -> Result<(), OperatorError> {
    let chain = append_bundle(workspace, bundle)?;
    println!("Verified state appended; workspace now contains {} states", chain.entries.len());
    Ok(())
}

pub fn verify_chain(workspace: &Path) -> Result<(), OperatorError> {
    let chain = verify_workspace(workspace)?;
    println!("Verified ceremony workspace with {} immutable states", chain.entries.len());
    Ok(())
}

fn load_shape(qap_path: &Path) -> Result<SetupShape, OperatorError> {
    let setup_path = qap_path.join("setupParams.json");
    let setup = SetupParams::read_from_json(setup_path.clone()).map_err(|source| OperatorError::Io {
        operation: "read setup parameters",
        path: setup_path.clone(),
        source,
    })?;
    let shape = try_setup_shape(&setup, &setup_path)?;
    try_validate_setup_shape(&shape, &setup_path)?;
    Ok(shape)
}

fn require_ceremony_id(value: &str) -> Result<(), OperatorError> {
    if value.trim().is_empty() || value != value.trim() {
        return Err(OperatorError::InvalidCommand(
            "ceremony ID must be nonempty and have no surrounding whitespace".into(),
        ));
    }
    Ok(())
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> OperatorError {
    OperatorError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}
