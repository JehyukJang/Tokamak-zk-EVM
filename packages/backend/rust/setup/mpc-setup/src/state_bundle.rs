use crate::conversions::{
    deserialize_g1_bytes, deserialize_g2_bytes, serialize_g1_affine, serialize_g2_affine,
};
use crate::phase1_contribution::{verify_phase1_transition, Phase1Contribution};
use crate::phase2_circuit::{CircuitSigmaArtifact, CircuitSigmaPoints};
use crate::phase2_contribution::{verify_phase2_transition, Phase2Contribution};
use crate::protocol::{
    CeremonyState, ContributionReceipt, CurveGroup, PhasePayload, PointChunkDescriptor, StateStatus,
};
use crate::universal_tau::{MonomialLayout, UniversalTauArtifact, UniversalTauPoints};
use ark_serialize::Compress;
use libs::group_structures::{G1serde, G2serde};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tempfile::Builder;
use thiserror::Error;

const STATE_FILE: &str = "state.json";
const LAYOUT_FILE: &str = "layout.json";
const RECEIPT_FILE: &str = "receipt.json";
const CHUNKS_DIRECTORY: &str = "chunks";

#[derive(Debug, Error)]
pub enum StateBundleError {
    #[error("failed to {operation} at {}: {source}", path.display())]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("invalid ceremony protocol document: {0}")]
    Protocol(#[from] crate::protocol::ProtocolError),
    #[error("invalid monomial layout or Phase 1 payload: {0}")]
    UniversalTau(#[from] crate::universal_tau::UniversalTauError),
    #[error("invalid Phase 2 payload: {0}")]
    Circuit(#[from] crate::phase2_circuit::CircuitPreparationError),
    #[error("invalid Phase 1 transition: {0}")]
    Phase1(#[from] crate::phase1_contribution::Phase1ContributionError),
    #[error("invalid Phase 2 transition: {0}")]
    Phase2(#[from] crate::phase2_contribution::Phase2ContributionError),
    #[error("invalid state bundle: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug)]
pub enum StateArtifact {
    Phase1(UniversalTauArtifact),
    Phase2(CircuitSigmaArtifact),
}

impl StateArtifact {
    pub fn state(&self) -> &CeremonyState {
        match self {
            Self::Phase1(artifact) => &artifact.state,
            Self::Phase2(artifact) => &artifact.state,
        }
    }

    pub fn layout(&self) -> &MonomialLayout {
        match self {
            Self::Phase1(artifact) => &artifact.layout,
            Self::Phase2(artifact) => &artifact.layout,
        }
    }
}

#[derive(Clone, Debug)]
pub struct StateBundle {
    pub artifact: StateArtifact,
    pub incoming_receipt: Option<ContributionReceipt>,
}

impl StateBundle {
    pub fn state(&self) -> &CeremonyState {
        self.artifact.state()
    }
}

pub fn write_phase1_bundle(
    output: &Path,
    artifact: &UniversalTauArtifact,
    incoming_receipt: Option<&ContributionReceipt>,
) -> Result<(), StateBundleError> {
    write_bundle_atomic(
        output,
        &StateBundle {
            artifact: StateArtifact::Phase1(artifact.clone()),
            incoming_receipt: incoming_receipt.cloned(),
        },
    )
}

pub fn write_phase2_bundle(
    output: &Path,
    artifact: &CircuitSigmaArtifact,
    incoming_receipt: Option<&ContributionReceipt>,
) -> Result<(), StateBundleError> {
    write_bundle_atomic(
        output,
        &StateBundle {
            artifact: StateArtifact::Phase2(artifact.clone()),
            incoming_receipt: incoming_receipt.cloned(),
        },
    )
}

pub fn read_state_bundle(directory: &Path) -> Result<StateBundle, StateBundleError> {
    let state_bytes = read_file(&directory.join(STATE_FILE), "read state manifest")?;
    let state = CeremonyState::from_canonical_json(&state_bytes)?;
    let layout_bytes = read_file(&directory.join(LAYOUT_FILE), "read monomial layout")?;
    let layout = MonomialLayout::from_canonical_json(&layout_bytes)?;
    if state.layout_digest != layout.digest()? {
        return invalid("layout digest differs from state.layoutDigest");
    }
    let incoming_receipt = read_receipt(directory, &state)?;
    let artifact = match &state.payload {
        PhasePayload::Phase1(payload) => {
            let points = read_phase1_points(directory, &layout, &payload.chunks)?;
            let artifact = UniversalTauArtifact {
                layout,
                points,
                state,
            };
            if artifact.points.protocol_payload(&artifact.layout)?
                != match &artifact.state.payload {
                    PhasePayload::Phase1(payload) => payload.clone(),
                    _ => unreachable!(),
                }
            {
                return invalid("Phase 1 point data differs from the state manifest");
            }
            StateArtifact::Phase1(artifact)
        }
        PhasePayload::Phase2(payload) => {
            let private_wire_count = usize::try_from(payload.private_wire_count).map_err(|_| {
                StateBundleError::Invalid("private wire count exceeds usize".into())
            })?;
            let points =
                read_phase2_points(directory, &layout, private_wire_count, &payload.chunks)?;
            let artifact = CircuitSigmaArtifact {
                layout,
                points,
                state,
            };
            if artifact.points.protocol_payload(&artifact.layout)?
                != match &artifact.state.payload {
                    PhasePayload::Phase2(payload) => payload.clone(),
                    _ => unreachable!(),
                }
            {
                return invalid("Phase 2 point data differs from the state manifest");
            }
            StateArtifact::Phase2(artifact)
        }
    };
    Ok(StateBundle {
        artifact,
        incoming_receipt,
    })
}

pub fn verify_bundle_transition(
    previous: &StateBundle,
    current: &StateBundle,
) -> Result<(), StateBundleError> {
    let receipt = current.incoming_receipt.clone().ok_or_else(|| {
        StateBundleError::Invalid("current bundle has no incoming receipt".into())
    })?;
    match (&previous.artifact, &current.artifact) {
        (StateArtifact::Phase1(previous), StateArtifact::Phase1(current)) => {
            verify_phase1_transition(
                previous,
                &Phase1Contribution {
                    artifact: current.clone(),
                    receipt,
                },
            )?;
        }
        (StateArtifact::Phase2(previous), StateArtifact::Phase2(current)) => {
            verify_phase2_transition(
                previous,
                &Phase2Contribution {
                    artifact: current.clone(),
                    receipt,
                },
            )?;
        }
        _ => return invalid("previous and current bundles belong to different phases"),
    }
    Ok(())
}

fn write_bundle_atomic(output: &Path, bundle: &StateBundle) -> Result<(), StateBundleError> {
    if output.exists() {
        return invalid(format!(
            "refusing to overwrite existing output {}",
            output.display()
        ));
    }
    validate_receipt_for_state(bundle.state(), bundle.incoming_receipt.as_ref())?;
    validate_artifact_manifest(&bundle.artifact)?;
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|source| io_error("create output parent", parent, source))?;
    let temp = Builder::new()
        .prefix(".mpc-state-")
        .tempdir_in(parent)
        .map_err(|source| io_error("create temporary state bundle", parent, source))?;
    write_bundle_contents(temp.path(), bundle)?;
    let verified = read_state_bundle(temp.path())?;
    if verified.state().digest()? != bundle.state().digest()? {
        return invalid("self-verified bundle state digest changed during persistence");
    }
    let temp_path = temp.keep();
    if let Err(source) = fs::rename(&temp_path, output) {
        let _ = fs::remove_dir_all(&temp_path);
        return Err(io_error("commit verified state bundle", output, source));
    }
    Ok(())
}

fn write_bundle_contents(directory: &Path, bundle: &StateBundle) -> Result<(), StateBundleError> {
    let chunks = directory.join(CHUNKS_DIRECTORY);
    fs::create_dir(&chunks)
        .map_err(|source| io_error("create chunk directory", &chunks, source))?;
    write_file(
        &directory.join(STATE_FILE),
        &bundle.state().to_canonical_json()?,
        "write state manifest",
    )?;
    write_file(
        &directory.join(LAYOUT_FILE),
        &bundle.artifact.layout().to_canonical_json()?,
        "write monomial layout",
    )?;
    if let Some(receipt) = &bundle.incoming_receipt {
        write_file(
            &directory.join(RECEIPT_FILE),
            &receipt.to_canonical_json()?,
            "write incoming receipt",
        )?;
    }
    match &bundle.artifact {
        StateArtifact::Phase1(artifact) => write_phase1_chunks(&chunks, artifact)?,
        StateArtifact::Phase2(artifact) => write_phase2_chunks(&chunks, artifact)?,
    }
    Ok(())
}

fn validate_artifact_manifest(artifact: &StateArtifact) -> Result<(), StateBundleError> {
    artifact.state().validate()?;
    if artifact.state().layout_digest != artifact.layout().digest()? {
        return invalid("artifact layout differs from its state digest");
    }
    match artifact {
        StateArtifact::Phase1(artifact) => {
            artifact.points.validate_shapes(&artifact.layout)?;
            if artifact.state.payload
                != PhasePayload::Phase1(artifact.points.protocol_payload(&artifact.layout)?)
            {
                return invalid("Phase 1 artifact differs from its state manifest");
            }
        }
        StateArtifact::Phase2(artifact) => {
            if artifact.state.payload
                != PhasePayload::Phase2(artifact.points.protocol_payload(&artifact.layout)?)
            {
                return invalid("Phase 2 artifact differs from its state manifest");
            }
        }
    }
    Ok(())
}

fn read_receipt(
    directory: &Path,
    state: &CeremonyState,
) -> Result<Option<ContributionReceipt>, StateBundleError> {
    let path = directory.join(RECEIPT_FILE);
    let receipt = if path.exists() {
        let bytes = read_file(&path, "read incoming receipt")?;
        Some(ContributionReceipt::from_canonical_json(&bytes)?)
    } else {
        None
    };
    validate_receipt_for_state(state, receipt.as_ref())?;
    Ok(receipt)
}

fn validate_receipt_for_state(
    state: &CeremonyState,
    receipt: Option<&ContributionReceipt>,
) -> Result<(), StateBundleError> {
    match (state.status, receipt) {
        (StateStatus::Contributed, Some(receipt)) => {
            receipt.validate()?;
            if receipt.ceremony_id != state.ceremony_id
                || receipt.phase != state.phase
                || receipt.contribution_profile != state.contribution_profile
                || receipt.contributor_index != state.sequence
                || receipt.current_state_digest != state.digest()?
                || state.previous_state_digest.as_ref() != Some(&receipt.previous_state_digest)
            {
                return invalid("incoming receipt does not identify the bundled state transition");
            }
        }
        (StateStatus::Contributed, None) => {
            return invalid("a contributed state bundle requires receipt.json")
        }
        (_, Some(_)) => {
            return invalid("genesis and prepared bundles must not contain receipt.json")
        }
        (_, None) => {}
    }
    Ok(())
}

fn write_phase1_chunks(
    chunks_directory: &Path,
    artifact: &UniversalTauArtifact,
) -> Result<(), StateBundleError> {
    let descriptors = phase1_descriptors(&artifact.state)?;
    let layout = &artifact.layout;
    let points = &artifact.points;
    write_g1_family(
        chunks_directory,
        descriptors,
        "generator",
        &[1],
        &[points.g1],
    )?;
    write_g2_family(
        chunks_directory,
        descriptors,
        "generator",
        &[1],
        &[points.g2],
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "alpha",
        &[layout.alpha_max + 1],
        &points.alpha_g1,
    )?;
    write_g2_family(
        chunks_directory,
        descriptors,
        "alpha",
        &[layout.alpha_max + 1],
        &points.alpha_g2,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "x",
        &[layout.x_grid_len],
        &points.x_g1,
    )?;
    write_g2_family(chunks_directory, descriptors, "x", &[2], &points.x_g2)?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "y",
        &[layout.alpha_y_max + 1],
        &points.y_g1,
    )?;
    write_g2_family(chunks_directory, descriptors, "y", &[2], &points.y_g2)?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "alphaX",
        &[layout.alpha_max, layout.alpha_x_max + 1],
        &points.alpha_x_g1,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "alphaY",
        &[layout.alpha_max, layout.alpha_y_max + 1],
        &points.alpha_y_g1,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "xy",
        &[layout.x_grid_len, layout.y_grid_len],
        &points.xy_g1,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "alphaXYAbc",
        &[3, layout.n, layout.s],
        &points.alpha_xy_abc_g1,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "alpha4XYK",
        &[layout.m_i, layout.s],
        &points.alpha4_xy_k_g1,
    )
}

fn write_phase2_chunks(
    chunks_directory: &Path,
    artifact: &CircuitSigmaArtifact,
) -> Result<(), StateBundleError> {
    let descriptors = phase2_descriptors(&artifact.state)?;
    let layout = &artifact.layout;
    let points = &artifact.points;
    write_g1_family(
        chunks_directory,
        descriptors,
        "generator",
        &[1],
        &[points.g1],
    )?;
    write_g2_family(
        chunks_directory,
        descriptors,
        "generator",
        &[1],
        &[points.g2],
    )?;
    write_g2_family(
        chunks_directory,
        descriptors,
        "alpha",
        &[4],
        &points.alpha_g2,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "directParameters",
        &[5],
        &[
            points.x_g1,
            points.y_g1,
            points.gamma_g1,
            points.delta_g1,
            points.eta_g1,
        ],
    )?;
    write_g2_family(
        chunks_directory,
        descriptors,
        "directParameters",
        &[5],
        &[
            points.x_g2,
            points.y_g2,
            points.gamma_g2,
            points.delta_g2,
            points.eta_g2,
        ],
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "xyPowers",
        &[layout.x_grid_len, layout.y_grid_len],
        &points.xy_powers,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "gammaInvOInst",
        &[points.gamma_inv_o_inst.len()],
        &points.gamma_inv_o_inst,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "etaInvLiOInterAlpha4Kj",
        &[layout.m_i, layout.s],
        &points.eta_inv_li_o_inter_alpha4_kj,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "deltaInvLiOPrv",
        &[points.private_wire_count, layout.s],
        &points.delta_inv_li_o_prv,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "deltaInvAlphaKXhTx",
        &[3, 3],
        &points.delta_inv_alphak_xh_tx,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "deltaInvAlpha4XjTx",
        &[2],
        &points.delta_inv_alpha4_xj_tx,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "deltaInvAlphaKYiTy",
        &[4, 3],
        &points.delta_inv_alphak_yi_ty,
    )?;
    write_g1_family(
        chunks_directory,
        descriptors,
        "lagrangeKL",
        &[1],
        &[points.lagrange_kl],
    )
}

fn read_phase1_points(
    directory: &Path,
    layout: &MonomialLayout,
    descriptors: &[PointChunkDescriptor],
) -> Result<UniversalTauPoints, StateBundleError> {
    let chunks = directory.join(CHUNKS_DIRECTORY);
    ensure_known_descriptors(descriptors, PHASE1_FAMILIES)?;
    Ok(UniversalTauPoints {
        g1: one_g1(
            load_g1_family(&chunks, descriptors, "generator", &[1])?,
            "generator",
        )?,
        g2: one_g2(
            load_g2_family(&chunks, descriptors, "generator", &[1])?,
            "generator",
        )?,
        alpha_g1: load_g1_family(&chunks, descriptors, "alpha", &[layout.alpha_max + 1])?,
        alpha_g2: load_g2_family(&chunks, descriptors, "alpha", &[layout.alpha_max + 1])?,
        x_g1: load_g1_family(&chunks, descriptors, "x", &[layout.x_grid_len])?,
        x_g2: load_g2_family(&chunks, descriptors, "x", &[2])?,
        y_g1: load_g1_family(&chunks, descriptors, "y", &[layout.alpha_y_max + 1])?,
        y_g2: load_g2_family(&chunks, descriptors, "y", &[2])?,
        alpha_x_g1: load_g1_family(
            &chunks,
            descriptors,
            "alphaX",
            &[layout.alpha_max, layout.alpha_x_max + 1],
        )?,
        alpha_y_g1: load_g1_family(
            &chunks,
            descriptors,
            "alphaY",
            &[layout.alpha_max, layout.alpha_y_max + 1],
        )?,
        xy_g1: load_g1_family(
            &chunks,
            descriptors,
            "xy",
            &[layout.x_grid_len, layout.y_grid_len],
        )?,
        alpha_xy_abc_g1: load_g1_family(
            &chunks,
            descriptors,
            "alphaXYAbc",
            &[3, layout.n, layout.s],
        )?,
        alpha4_xy_k_g1: load_g1_family(&chunks, descriptors, "alpha4XYK", &[layout.m_i, layout.s])?,
    })
}

fn read_phase2_points(
    directory: &Path,
    layout: &MonomialLayout,
    private_wire_count: usize,
    descriptors: &[PointChunkDescriptor],
) -> Result<CircuitSigmaPoints, StateBundleError> {
    let chunks = directory.join(CHUNKS_DIRECTORY);
    ensure_known_descriptors(descriptors, PHASE2_FAMILIES)?;
    let direct_g1 = load_g1_family(&chunks, descriptors, "directParameters", &[5])?;
    let direct_g2 = load_g2_family(&chunks, descriptors, "directParameters", &[5])?;
    let alpha_g2 = load_g2_family(&chunks, descriptors, "alpha", &[4])?;
    Ok(CircuitSigmaPoints {
        g1: one_g1(
            load_g1_family(&chunks, descriptors, "generator", &[1])?,
            "generator",
        )?,
        g2: one_g2(
            load_g2_family(&chunks, descriptors, "generator", &[1])?,
            "generator",
        )?,
        alpha_g2,
        x_g1: direct_g1[0],
        y_g1: direct_g1[1],
        gamma_g1: direct_g1[2],
        delta_g1: direct_g1[3],
        eta_g1: direct_g1[4],
        x_g2: direct_g2[0],
        y_g2: direct_g2[1],
        gamma_g2: direct_g2[2],
        delta_g2: direct_g2[3],
        eta_g2: direct_g2[4],
        xy_powers: load_g1_family(
            &chunks,
            descriptors,
            "xyPowers",
            &[layout.x_grid_len, layout.y_grid_len],
        )?,
        gamma_inv_o_inst: load_g1_family(
            &chunks,
            descriptors,
            "gammaInvOInst",
            &family_shape(descriptors, "gammaInvOInst", CurveGroup::G1)?,
        )?,
        eta_inv_li_o_inter_alpha4_kj: load_g1_family(
            &chunks,
            descriptors,
            "etaInvLiOInterAlpha4Kj",
            &[layout.m_i, layout.s],
        )?,
        delta_inv_li_o_prv: load_g1_family(
            &chunks,
            descriptors,
            "deltaInvLiOPrv",
            &[private_wire_count, layout.s],
        )?,
        private_wire_count,
        delta_inv_alphak_xh_tx: load_g1_family(
            &chunks,
            descriptors,
            "deltaInvAlphaKXhTx",
            &[3, 3],
        )?,
        delta_inv_alpha4_xj_tx: load_g1_family(&chunks, descriptors, "deltaInvAlpha4XjTx", &[2])?,
        delta_inv_alphak_yi_ty: load_g1_family(
            &chunks,
            descriptors,
            "deltaInvAlphaKYiTy",
            &[4, 3],
        )?,
        lagrange_kl: one_g1(
            load_g1_family(&chunks, descriptors, "lagrangeKL", &[1])?,
            "lagrangeKL",
        )?,
    })
}

const PHASE1_FAMILIES: &[(&str, CurveGroup)] = &[
    ("generator", CurveGroup::G1),
    ("generator", CurveGroup::G2),
    ("alpha", CurveGroup::G1),
    ("alpha", CurveGroup::G2),
    ("x", CurveGroup::G1),
    ("x", CurveGroup::G2),
    ("y", CurveGroup::G1),
    ("y", CurveGroup::G2),
    ("alphaX", CurveGroup::G1),
    ("alphaY", CurveGroup::G1),
    ("xy", CurveGroup::G1),
    ("alphaXYAbc", CurveGroup::G1),
    ("alpha4XYK", CurveGroup::G1),
];

const PHASE2_FAMILIES: &[(&str, CurveGroup)] = &[
    ("generator", CurveGroup::G1),
    ("generator", CurveGroup::G2),
    ("alpha", CurveGroup::G2),
    ("directParameters", CurveGroup::G1),
    ("directParameters", CurveGroup::G2),
    ("xyPowers", CurveGroup::G1),
    ("gammaInvOInst", CurveGroup::G1),
    ("etaInvLiOInterAlpha4Kj", CurveGroup::G1),
    ("deltaInvLiOPrv", CurveGroup::G1),
    ("deltaInvAlphaKXhTx", CurveGroup::G1),
    ("deltaInvAlpha4XjTx", CurveGroup::G1),
    ("deltaInvAlphaKYiTy", CurveGroup::G1),
    ("lagrangeKL", CurveGroup::G1),
];

fn phase1_descriptors(state: &CeremonyState) -> Result<&[PointChunkDescriptor], StateBundleError> {
    match &state.payload {
        PhasePayload::Phase1(payload) => Ok(&payload.chunks),
        _ => invalid("Phase 1 artifact contains a Phase 2 payload"),
    }
}

fn phase2_descriptors(state: &CeremonyState) -> Result<&[PointChunkDescriptor], StateBundleError> {
    match &state.payload {
        PhasePayload::Phase2(payload) => Ok(&payload.chunks),
        _ => invalid("Phase 2 artifact contains a Phase 1 payload"),
    }
}

fn ensure_known_descriptors(
    descriptors: &[PointChunkDescriptor],
    allowed: &[(&str, CurveGroup)],
) -> Result<(), StateBundleError> {
    if let Some(descriptor) = descriptors.iter().find(|descriptor| {
        !allowed
            .iter()
            .any(|(family, group)| descriptor.family == *family && descriptor.group == *group)
    }) {
        return invalid(format!(
            "unknown point family/group combination: {}/{:?}",
            descriptor.family, descriptor.group
        ));
    }
    Ok(())
}

fn family_shape(
    descriptors: &[PointChunkDescriptor],
    family: &str,
    group: CurveGroup,
) -> Result<Vec<usize>, StateBundleError> {
    let matching = descriptors
        .iter()
        .filter(|descriptor| descriptor.family == family && descriptor.group == group)
        .collect::<Vec<_>>();
    if matching.is_empty() {
        return Ok(vec![0]);
    }
    if matching.len() == 1 && matching[0].start_indices.iter().all(|value| *value == 0) {
        return matching[0]
            .shape
            .iter()
            .map(|value| {
                usize::try_from(*value)
                    .map_err(|_| StateBundleError::Invalid("family shape exceeds usize".into()))
            })
            .collect();
    }
    let maximum = matching.iter().try_fold(0usize, |maximum, descriptor| {
        let start = usize::try_from(descriptor.start_indices[0])
            .map_err(|_| StateBundleError::Invalid("family offset exceeds usize".into()))?;
        let length = usize::try_from(descriptor.point_count)
            .map_err(|_| StateBundleError::Invalid("family point count exceeds usize".into()))?;
        start
            .checked_add(length)
            .map(|end| maximum.max(end))
            .ok_or_else(|| StateBundleError::Invalid("family length overflow".into()))
    })?;
    Ok(vec![maximum])
}

fn write_g1_family(
    directory: &Path,
    descriptors: &[PointChunkDescriptor],
    family: &str,
    full_shape: &[usize],
    points: &[G1serde],
) -> Result<(), StateBundleError> {
    validate_family_point_count(full_shape, points.len(), family)?;
    for descriptor in matching_descriptors(descriptors, family, CurveGroup::G1) {
        let selected = select_chunk(points, full_shape, descriptor)?;
        let bytes = selected
            .iter()
            .flat_map(|point| serialize_g1_affine(&point.0, Compress::Yes).into_vec())
            .collect::<Vec<_>>();
        persist_chunk(directory, descriptor, &bytes)?;
    }
    Ok(())
}

fn write_g2_family(
    directory: &Path,
    descriptors: &[PointChunkDescriptor],
    family: &str,
    full_shape: &[usize],
    points: &[G2serde],
) -> Result<(), StateBundleError> {
    validate_family_point_count(full_shape, points.len(), family)?;
    for descriptor in matching_descriptors(descriptors, family, CurveGroup::G2) {
        let selected = select_chunk(points, full_shape, descriptor)?;
        let bytes = selected
            .iter()
            .flat_map(|point| serialize_g2_affine(&point.0, Compress::Yes).into_vec())
            .collect::<Vec<_>>();
        persist_chunk(directory, descriptor, &bytes)?;
    }
    Ok(())
}

fn load_g1_family(
    directory: &Path,
    descriptors: &[PointChunkDescriptor],
    family: &str,
    full_shape: &[usize],
) -> Result<Vec<G1serde>, StateBundleError> {
    load_family(
        directory,
        descriptors,
        family,
        CurveGroup::G1,
        full_shape,
        48,
        |bytes| deserialize_g1_bytes(bytes, Compress::Yes),
    )
}

fn load_g2_family(
    directory: &Path,
    descriptors: &[PointChunkDescriptor],
    family: &str,
    full_shape: &[usize],
) -> Result<Vec<G2serde>, StateBundleError> {
    load_family(
        directory,
        descriptors,
        family,
        CurveGroup::G2,
        full_shape,
        96,
        |bytes| deserialize_g2_bytes(bytes, Compress::Yes),
    )
}

fn load_family<T: Copy>(
    directory: &Path,
    descriptors: &[PointChunkDescriptor],
    family: &str,
    group: CurveGroup,
    full_shape: &[usize],
    point_bytes: usize,
    decode: impl Fn(&[u8]) -> Result<T, String>,
) -> Result<Vec<T>, StateBundleError> {
    let total = shape_product(full_shape)?;
    let matching = matching_descriptors(descriptors, family, group);
    if total == 0 {
        if !matching.is_empty() {
            return invalid(format!("empty family {family} has point descriptors"));
        }
        return Ok(Vec::new());
    }
    let mut slots = vec![None; total];
    for descriptor in matching {
        let path = directory.join(descriptor.content_addressed_file_name());
        let bytes = read_file(&path, "read point chunk")?;
        descriptor.validate_bytes(&bytes)?;
        let decoded = bytes
            .chunks_exact(point_bytes)
            .map(|encoding| decode(encoding).map_err(StateBundleError::Invalid))
            .collect::<Result<Vec<_>, _>>()?;
        if !bytes.chunks_exact(point_bytes).remainder().is_empty() {
            return invalid(format!("point chunk for {family} has a partial encoding"));
        }
        place_chunk(&mut slots, full_shape, descriptor, &decoded)?;
    }
    slots
        .into_iter()
        .enumerate()
        .map(|(index, point)| {
            point.ok_or_else(|| {
                StateBundleError::Invalid(format!(
                    "point family {family} is missing element {index}"
                ))
            })
        })
        .collect()
}

fn matching_descriptors<'a>(
    descriptors: &'a [PointChunkDescriptor],
    family: &str,
    group: CurveGroup,
) -> Vec<&'a PointChunkDescriptor> {
    descriptors
        .iter()
        .filter(|descriptor| descriptor.family == family && descriptor.group == group)
        .collect()
}

fn select_chunk<T: Copy>(
    points: &[T],
    full_shape: &[usize],
    descriptor: &PointChunkDescriptor,
) -> Result<Vec<T>, StateBundleError> {
    let indices = chunk_global_indices(full_shape, descriptor)?;
    indices
        .into_iter()
        .map(|index| {
            points.get(index).copied().ok_or_else(|| {
                StateBundleError::Invalid(format!(
                    "chunk {} exceeds family {}",
                    descriptor.content_addressed_file_name(),
                    descriptor.family
                ))
            })
        })
        .collect()
}

fn place_chunk<T: Copy>(
    slots: &mut [Option<T>],
    full_shape: &[usize],
    descriptor: &PointChunkDescriptor,
    points: &[T],
) -> Result<(), StateBundleError> {
    let indices = chunk_global_indices(full_shape, descriptor)?;
    if indices.len() != points.len() {
        return invalid("decoded point count differs from chunk geometry");
    }
    for (index, point) in indices.into_iter().zip(points.iter().copied()) {
        let slot = slots
            .get_mut(index)
            .ok_or_else(|| StateBundleError::Invalid("chunk index exceeds family".into()))?;
        if slot.replace(point).is_some() {
            return invalid(format!(
                "overlapping point chunks in family {}",
                descriptor.family
            ));
        }
    }
    Ok(())
}

fn chunk_global_indices(
    full_shape: &[usize],
    descriptor: &PointChunkDescriptor,
) -> Result<Vec<usize>, StateBundleError> {
    if descriptor.shape.len() != full_shape.len()
        || descriptor.start_indices.len() != full_shape.len()
    {
        return invalid(format!(
            "chunk rank differs from family {}",
            descriptor.family
        ));
    }
    let chunk_shape = descriptor
        .shape
        .iter()
        .map(|value| {
            usize::try_from(*value)
                .map_err(|_| StateBundleError::Invalid("chunk dimension exceeds usize".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let starts = descriptor
        .start_indices
        .iter()
        .map(|value| {
            usize::try_from(*value)
                .map_err(|_| StateBundleError::Invalid("chunk offset exceeds usize".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    for ((start, extent), full) in starts.iter().zip(chunk_shape.iter()).zip(full_shape.iter()) {
        if start.checked_add(*extent).is_none_or(|end| end > *full) {
            return invalid(format!("chunk exceeds family {}", descriptor.family));
        }
    }
    let count = shape_product(&chunk_shape)?;
    let mut result = Vec::with_capacity(count);
    for local_linear in 0..count {
        let mut remainder = local_linear;
        let mut global_linear = 0usize;
        let mut stride = 1usize;
        for axis in (0..full_shape.len()).rev() {
            let coordinate = remainder % chunk_shape[axis];
            remainder /= chunk_shape[axis];
            let global = starts[axis] + coordinate;
            global_linear = global_linear
                .checked_add(
                    global
                        .checked_mul(stride)
                        .ok_or_else(|| StateBundleError::Invalid("chunk index overflow".into()))?,
                )
                .ok_or_else(|| StateBundleError::Invalid("chunk index overflow".into()))?;
            stride = stride
                .checked_mul(full_shape[axis])
                .ok_or_else(|| StateBundleError::Invalid("family stride overflow".into()))?;
        }
        result.push(global_linear);
    }
    Ok(result)
}

fn validate_family_point_count(
    shape: &[usize],
    count: usize,
    family: &str,
) -> Result<(), StateBundleError> {
    let expected = shape_product(shape)?;
    if count != expected {
        return invalid(format!(
            "point family {family} has {count} points; expected {expected}"
        ));
    }
    Ok(())
}

fn shape_product(shape: &[usize]) -> Result<usize, StateBundleError> {
    shape.iter().try_fold(1usize, |total, dimension| {
        total
            .checked_mul(*dimension)
            .ok_or_else(|| StateBundleError::Invalid("point family size overflow".into()))
    })
}

fn persist_chunk(
    directory: &Path,
    descriptor: &PointChunkDescriptor,
    bytes: &[u8],
) -> Result<(), StateBundleError> {
    descriptor.validate_bytes(bytes)?;
    let path = directory.join(descriptor.content_addressed_file_name());
    if path.exists() {
        let existing = read_file(&path, "read existing content-addressed chunk")?;
        if existing != bytes {
            return invalid(format!(
                "content-addressed chunk collision at {}",
                path.display()
            ));
        }
        return Ok(());
    }
    write_file(&path, bytes, "write point chunk")
}

fn one_g1(mut points: Vec<G1serde>, family: &str) -> Result<G1serde, StateBundleError> {
    if points.len() != 1 {
        return invalid(format!("family {family} must contain one G1 point"));
    }
    Ok(points.remove(0))
}

fn one_g2(mut points: Vec<G2serde>, family: &str) -> Result<G2serde, StateBundleError> {
    if points.len() != 1 {
        return invalid(format!("family {family} must contain one G2 point"));
    }
    Ok(points.remove(0))
}

fn read_file(path: &Path, operation: &'static str) -> Result<Vec<u8>, StateBundleError> {
    fs::read(path).map_err(|source| io_error(operation, path, source))
}

fn write_file(path: &Path, bytes: &[u8], operation: &'static str) -> Result<(), StateBundleError> {
    fs::write(path, bytes).map_err(|source| io_error(operation, path, source))
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> StateBundleError {
    StateBundleError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

fn invalid<T>(reason: impl Into<String>) -> Result<T, StateBundleError> {
    Err(StateBundleError::Invalid(reason.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contribution_kernel::SecretShares;
    use crate::phase1_contribution::contribute_phase1;
    use crate::phase2_circuit::{prepare_phase2_circuit, CircuitPreparationInput, WirePolynomial};
    use crate::phase2_contribution::contribute_phase2;
    use crate::protocol::{
        ContributionEntropyMode, ContributionProfile, Sha256Digest, TrapdoorParameter,
    };
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    use libs::utils::{try_init_ntt_domain, SetupShape};

    fn shape() -> SetupShape {
        SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        }
    }

    fn phase1() -> Phase1Contribution {
        try_init_ntt_domain(2).unwrap();
        let genesis = UniversalTauArtifact::initialize_native("bundle-test", &shape()).unwrap();
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

    fn phase2(selected: &Phase1Contribution) -> Phase2Contribution {
        let wire = |value| WirePolynomial {
            alpha_abc_x_coefficients: [
                vec![ScalarField::from_u32(value), ScalarField::zero()],
                vec![ScalarField::zero(), ScalarField::one()],
                vec![ScalarField::one(), ScalarField::one()],
            ],
        };
        let input = CircuitPreparationInput {
            circuit_digest: Sha256Digest::parse(format!("sha256:{}", "1".repeat(64))).unwrap(),
            wire_polynomials: vec![wire(1), wire(2), wire(3), wire(4)],
            public_placement_phases: vec![Some(0)],
            public_m_x_coefficients: vec![vec![ScalarField::one(), ScalarField::zero()]],
            intermediate_k_x_coefficients: vec![
                vec![ScalarField::one(), ScalarField::zero()],
                vec![ScalarField::zero(), ScalarField::one()],
            ],
        };
        let prepared =
            prepare_phase2_circuit(&selected.artifact, &[selected.receipt.clone()], &input)
                .unwrap();
        let shares = SecretShares::new(
            ContributionProfile::CircuitGammaDeltaEta,
            vec![
                (TrapdoorParameter::Gamma, ScalarField::from_u32(7)),
                (TrapdoorParameter::Delta, ScalarField::from_u32(11)),
                (TrapdoorParameter::Eta, ScalarField::from_u32(13)),
            ],
        )
        .unwrap();
        contribute_phase2(&prepared, &shares, ContributionEntropyMode::Hybrid).unwrap()
    }

    #[test]
    fn phase1_and_phase2_bundles_round_trip_and_verify_transitions() {
        let root = tempfile::tempdir().unwrap();
        let genesis = UniversalTauArtifact::initialize_native("bundle-test", &shape()).unwrap();
        let genesis_path = root.path().join("genesis");
        write_phase1_bundle(&genesis_path, &genesis, None).unwrap();
        let selected = phase1();
        let selected_path = root.path().join("phase1-selected");
        write_phase1_bundle(&selected_path, &selected.artifact, Some(&selected.receipt)).unwrap();
        let genesis_bundle = read_state_bundle(&genesis_path).unwrap();
        let selected_bundle = read_state_bundle(&selected_path).unwrap();
        verify_bundle_transition(&genesis_bundle, &selected_bundle).unwrap();

        let contribution = phase2(&selected);
        let prepared = {
            let wire = |value| WirePolynomial {
                alpha_abc_x_coefficients: [
                    vec![ScalarField::from_u32(value), ScalarField::zero()],
                    vec![ScalarField::zero(), ScalarField::one()],
                    vec![ScalarField::one(), ScalarField::one()],
                ],
            };
            prepare_phase2_circuit(
                &selected.artifact,
                &[selected.receipt.clone()],
                &CircuitPreparationInput {
                    circuit_digest: Sha256Digest::parse(format!("sha256:{}", "1".repeat(64)))
                        .unwrap(),
                    wire_polynomials: vec![wire(1), wire(2), wire(3), wire(4)],
                    public_placement_phases: vec![Some(0)],
                    public_m_x_coefficients: vec![vec![ScalarField::one(), ScalarField::zero()]],
                    intermediate_k_x_coefficients: vec![
                        vec![ScalarField::one(), ScalarField::zero()],
                        vec![ScalarField::zero(), ScalarField::one()],
                    ],
                },
            )
            .unwrap()
        };
        let prepared_path = root.path().join("phase2-prepared");
        write_phase2_bundle(&prepared_path, &prepared, None).unwrap();
        let contribution_path = root.path().join("phase2-contributed");
        write_phase2_bundle(
            &contribution_path,
            &contribution.artifact,
            Some(&contribution.receipt),
        )
        .unwrap();
        let prepared_bundle = read_state_bundle(&prepared_path).unwrap();
        let contribution_bundle = read_state_bundle(&contribution_path).unwrap();
        verify_bundle_transition(&prepared_bundle, &contribution_bundle).unwrap();
    }

    #[test]
    fn writer_refuses_overwrite_and_reader_rejects_tampering() {
        let root = tempfile::tempdir().unwrap();
        let genesis = UniversalTauArtifact::initialize_native("bundle-test", &shape()).unwrap();
        let path = root.path().join("genesis");
        write_phase1_bundle(&path, &genesis, None).unwrap();
        assert!(write_phase1_bundle(&path, &genesis, None).is_err());

        let descriptor = phase1_descriptors(&genesis.state).unwrap()[0].clone();
        let chunk = path
            .join(CHUNKS_DIRECTORY)
            .join(descriptor.content_addressed_file_name());
        let mut bytes = fs::read(&chunk).unwrap();
        bytes[0] ^= 1;
        fs::write(chunk, bytes).unwrap();
        assert!(read_state_bundle(&path).is_err());
    }
}
