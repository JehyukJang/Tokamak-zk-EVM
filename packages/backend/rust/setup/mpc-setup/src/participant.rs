use crate::contribution_kernel::{KernelError, SecretShares};
use crate::phase1_contribution::{contribute_phase1, Phase1ContributionError};
use crate::phase2_contribution::{contribute_phase2, Phase2ContributionError};
use crate::protocol::{ContributionEntropyMode, ContributionReceipt, Phase, StateStatus};
use crate::state_bundle::{
    read_state_bundle, verify_bundle_transition, write_phase1_bundle, write_phase2_bundle,
    StateArtifact, StateBundleError,
};
use crate::utils::{initialize_random_generator_with_seed_input, Mode};
use libs::cli::CliDiagnostic;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ParticipantError {
    #[error("invalid participant command: {0}")]
    InvalidCommand(String),
    #[error(transparent)]
    Bundle(#[from] StateBundleError),
    #[error(transparent)]
    Kernel(#[from] KernelError),
    #[error(transparent)]
    Phase1(#[from] Phase1ContributionError),
    #[error(transparent)]
    Phase2(#[from] Phase2ContributionError),
    #[error("failed to read receipt at {}: {source}", path.display())]
    ReceiptIo {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid receipt document: {0}")]
    ReceiptProtocol(#[from] crate::protocol::ProtocolError),
}

impl CliDiagnostic for ParticipantError {
    fn hint(&self) -> &'static str {
        match self {
            Self::InvalidCommand(_) => {
                "Use the phase declared by the verified input state and provide a seed in beacon mode."
            }
            Self::Bundle(_) => {
                "Use a complete immutable state bundle and do not reuse an existing output path."
            }
            Self::Kernel(_) | Self::Phase1(_) | Self::Phase2(_) => {
                "Reject this transition and inspect the input state, contribution profile, and point chunks."
            }
            Self::ReceiptIo { .. } | Self::ReceiptProtocol(_) => {
                "Use the canonical receipt.json from the current contributed-state bundle."
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContributeConfig {
    pub expected_phase: Phase,
    pub input: PathBuf,
    pub output: PathBuf,
    pub seed_input: Option<String>,
    pub beacon_mode: bool,
}

#[derive(Debug, Clone)]
pub struct VerifyTransitionConfig {
    pub previous: PathBuf,
    pub current: PathBuf,
    pub receipt: PathBuf,
}

pub fn run_contribute(config: &ContributeConfig) -> Result<(), ParticipantError> {
    if config.beacon_mode && config.seed_input.is_none() {
        return Err(ParticipantError::InvalidCommand(
            "--beacon-mode requires --seed-input".to_string(),
        ));
    }
    let previous = read_state_bundle(&config.input)?;
    let state = previous.state();
    if state.phase != config.expected_phase {
        return Err(ParticipantError::InvalidCommand(format!(
            "--phase {:?} differs from verified input phase {:?}",
            config.expected_phase, state.phase
        )));
    }
    if !matches!(
        state.status,
        StateStatus::Genesis | StateStatus::Prepared | StateStatus::Contributed
    ) {
        return Err(ParticipantError::InvalidCommand(
            "input state status cannot accept a contribution".to_string(),
        ));
    }
    println!(
        "Verified participant input: phase={:?}, contributionProfile={:?}, sequence={}",
        state.phase, state.contribution_profile, state.sequence
    );
    let mode = if config.beacon_mode {
        Mode::Beacon
    } else {
        Mode::Random
    };
    let entropy_mode = entropy_mode(config);
    let mut random =
        initialize_random_generator_with_seed_input(&mode, config.seed_input.as_deref());
    let shares = SecretShares::sample(state.contribution_profile, &mut random)?;
    match previous.artifact {
        StateArtifact::Phase1(previous) => {
            let contribution = contribute_phase1(&previous, &shares, entropy_mode)?;
            drop(shares);
            write_phase1_bundle(
                &config.output,
                &contribution.artifact,
                Some(&contribution.receipt),
            )?;
        }
        StateArtifact::Phase2(previous) => {
            let contribution = contribute_phase2(&previous, &shares, entropy_mode)?;
            drop(shares);
            write_phase2_bundle(
                &config.output,
                &contribution.artifact,
                Some(&contribution.receipt),
            )?;
        }
    }
    let written = read_state_bundle(&config.output)?;
    println!(
        "Contribution self-verified and committed: {}",
        written.state().digest()?.as_str()
    );
    Ok(())
}

pub fn run_verify_transition(config: &VerifyTransitionConfig) -> Result<(), ParticipantError> {
    let previous = read_state_bundle(&config.previous)?;
    let current = read_state_bundle(&config.current)?;
    let explicit_receipt = read_receipt(&config.receipt)?;
    if current.incoming_receipt.as_ref() != Some(&explicit_receipt) {
        return Err(ParticipantError::InvalidCommand(
            "--receipt differs from the current bundle's incoming receipt".to_string(),
        ));
    }
    verify_bundle_transition(&previous, &current)?;
    println!(
        "Verified transition: phase={:?}, contributionProfile={:?}, sequence={}, stateDigest={}",
        current.state().phase,
        current.state().contribution_profile,
        current.state().sequence,
        current.state().digest()?.as_str()
    );
    Ok(())
}

fn entropy_mode(config: &ContributeConfig) -> ContributionEntropyMode {
    if crate::testing_mode_enabled() {
        ContributionEntropyMode::Testing
    } else if config.beacon_mode {
        ContributionEntropyMode::Beacon
    } else if config.seed_input.is_some() {
        ContributionEntropyMode::Hybrid
    } else {
        ContributionEntropyMode::Random
    }
}

fn read_receipt(path: &Path) -> Result<ContributionReceipt, ParticipantError> {
    let bytes = fs::read(path).map_err(|source| ParticipantError::ReceiptIo {
        path: path.to_path_buf(),
        source,
    })?;
    ContributionReceipt::from_canonical_json(&bytes).map_err(ParticipantError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_bundle::write_phase1_bundle;
    use crate::universal_tau::UniversalTauArtifact;
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
    fn common_command_contributes_and_verifies_from_the_state_profile() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("input");
        let output = root.path().join("output");
        let genesis =
            UniversalTauArtifact::initialize_native("participant-test", &shape()).unwrap();
        write_phase1_bundle(&input, &genesis, None).unwrap();
        run_contribute(&ContributeConfig {
            expected_phase: Phase::Phase1,
            input: input.clone(),
            output: output.clone(),
            seed_input: Some("participant entropy".to_string()),
            beacon_mode: false,
        })
        .unwrap();
        run_verify_transition(&VerifyTransitionConfig {
            previous: input,
            current: output.clone(),
            receipt: output.join("receipt.json"),
        })
        .unwrap();
    }

    #[test]
    fn rejects_phase_override_and_beacon_without_seed_before_computation() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("input");
        let genesis =
            UniversalTauArtifact::initialize_native("participant-test", &shape()).unwrap();
        write_phase1_bundle(&input, &genesis, None).unwrap();
        assert!(run_contribute(&ContributeConfig {
            expected_phase: Phase::Phase2,
            input: input.clone(),
            output: root.path().join("wrong-phase"),
            seed_input: Some("entropy".to_string()),
            beacon_mode: false,
        })
        .is_err());
        assert!(run_contribute(&ContributeConfig {
            expected_phase: Phase::Phase1,
            input,
            output: root.path().join("missing-seed"),
            seed_input: None,
            beacon_mode: true,
        })
        .is_err());
    }
}
