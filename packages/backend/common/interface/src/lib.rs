//! Shared, byte-stable Rust interfaces for Tokamak zk-EVM backend artifacts.
//!
//! This crate owns only archive schemas and deterministic archive projections.
//! Native curve conversion and browser binding code belong to their respective
//! runtime packages.

#![deny(unsafe_code)]
#![allow(non_snake_case)]

use rkyv::check_archived_root;

pub const COMBINED_SIGMA_PAYLOAD_MAGIC: &[u8; 8] = b"TKCRS001";
pub const COMBINED_SIGMA_SECTION_COUNT: u32 = 9;
pub const G1_SERIALIZED_BYTES: usize = 96;
pub const G2_SERIALIZED_BYTES: usize = 192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupportedArchiveKind {
    CombinedSigma,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveDecodeError {
    archive_kind: SupportedArchiveKind,
    message: String,
}

impl ArchiveDecodeError {
    pub fn new(archive_kind: SupportedArchiveKind, message: impl Into<String>) -> Self {
        Self {
            archive_kind,
            message: message.into(),
        }
    }

    pub fn archive_kind(&self) -> SupportedArchiveKind {
        self.archive_kind
    }
}

impl core::fmt::Display for ArchiveDecodeError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            formatter,
            "{:?} rkyv archive decode failed: {}",
            self.archive_kind, self.message
        )
    }
}

impl std::error::Error for ArchiveDecodeError {}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct G1SerdeRkyv {
    pub x: [u8; 48],
    pub y: [u8; 48],
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct G2SerdeRkyv {
    pub x: [u8; 96],
    pub y: [u8; 96],
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct SigmaRkyv {
    pub G: G1SerdeRkyv,
    pub H: G2SerdeRkyv,
    pub sigma_1: Sigma1Rkyv,
    pub sigma_2: Sigma2Rkyv,
    pub lagrange_KL: G1SerdeRkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct Sigma1Rkyv {
    pub xy_powers: Vec<G1SerdeRkyv>,
    pub x: G1SerdeRkyv,
    pub y: G1SerdeRkyv,
    pub delta: G1SerdeRkyv,
    pub eta: G1SerdeRkyv,
    pub gamma_inv_o_inst: Vec<G1SerdeRkyv>,
    pub eta_inv_li_o_inter_alpha4_kj: Vec<Vec<G1SerdeRkyv>>,
    pub delta_inv_li_o_prv: Vec<Vec<G1SerdeRkyv>>,
    pub delta_inv_alphak_xh_tx: Vec<Vec<G1SerdeRkyv>>,
    pub delta_inv_alpha4_xj_tx: Vec<G1SerdeRkyv>,
    pub delta_inv_alphak_yi_ty: Vec<Vec<G1SerdeRkyv>>,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct PartialSigma1Rkyv {
    pub xy_powers: Vec<G1SerdeRkyv>,
    pub gamma_inv_o_inst: Vec<G1SerdeRkyv>,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct SigmaPreprocessRkyv {
    pub sigma_1: PartialSigma1Rkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct PartialSigma1VerifyRkyv {
    pub x: G1SerdeRkyv,
    pub y: G1SerdeRkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct SigmaVerifyRkyv {
    pub G: G1SerdeRkyv,
    pub H: G2SerdeRkyv,
    pub sigma_1: PartialSigma1VerifyRkyv,
    pub sigma_2: Sigma2Rkyv,
    pub lagrange_KL: G1SerdeRkyv,
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct Sigma2Rkyv {
    pub alpha: G2SerdeRkyv,
    pub alpha2: G2SerdeRkyv,
    pub alpha3: G2SerdeRkyv,
    pub alpha4: G2SerdeRkyv,
    pub gamma: G2SerdeRkyv,
    pub delta: G2SerdeRkyv,
    pub eta: G2SerdeRkyv,
    pub x: G2SerdeRkyv,
    pub y: G2SerdeRkyv,
}

/// Validate a combined Sigma archive and project it into the `TKCRS001`
/// payload consumed by the browser binary-artifact writer.
pub fn decode_combined_sigma(input: &[u8]) -> Result<Vec<u8>, ArchiveDecodeError> {
    let sigma = check_archived_root::<SigmaRkyv>(input).map_err(|error| {
        ArchiveDecodeError::new(
            SupportedArchiveKind::CombinedSigma,
            format!("invalid archive shape: {error:?}"),
        )
    })?;
    Ok(encode_combined_sigma_payload(sigma))
}

/// Project an already validated combined Sigma archive into `TKCRS001`.
pub fn encode_combined_sigma_payload(sigma: &ArchivedSigmaRkyv) -> Vec<u8> {
    let sections = [
        encode_sigma_g1(sigma),
        encode_g1_slice(sigma.sigma_1.xy_powers.as_slice()),
        encode_g1_slice(sigma.sigma_1.gamma_inv_o_inst.as_slice()),
        encode_nested_g1_slice(sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj.as_slice()),
        encode_nested_g1_slice(sigma.sigma_1.delta_inv_li_o_prv.as_slice()),
        encode_nested_g1_slice(sigma.sigma_1.delta_inv_alphak_xh_tx.as_slice()),
        encode_g1_slice(sigma.sigma_1.delta_inv_alpha4_xj_tx.as_slice()),
        encode_nested_g1_slice(sigma.sigma_1.delta_inv_alphak_yi_ty.as_slice()),
        encode_sigma_g2(sigma),
    ];
    let total_section_bytes = sections.iter().map(Vec::len).sum::<usize>();
    let mut output = Vec::with_capacity(12 + sections.len() * 4 + total_section_bytes);
    output.extend_from_slice(COMBINED_SIGMA_PAYLOAD_MAGIC);
    output.extend_from_slice(&COMBINED_SIGMA_SECTION_COUNT.to_le_bytes());
    for section in &sections {
        output.extend_from_slice(&(section.len() as u32).to_le_bytes());
    }
    for section in sections {
        output.extend_from_slice(&section);
    }
    output
}

fn encode_sigma_g1(sigma: &ArchivedSigmaRkyv) -> Vec<u8> {
    let mut output = Vec::with_capacity(6 * G1_SERIALIZED_BYTES);
    for point in [
        &sigma.G,
        &sigma.sigma_1.x,
        &sigma.sigma_1.y,
        &sigma.sigma_1.delta,
        &sigma.sigma_1.eta,
        &sigma.lagrange_KL,
    ] {
        push_g1(&mut output, point);
    }
    output
}

fn encode_sigma_g2(sigma: &ArchivedSigmaRkyv) -> Vec<u8> {
    let mut output = Vec::with_capacity(10 * G2_SERIALIZED_BYTES);
    for point in [
        &sigma.H,
        &sigma.sigma_2.alpha,
        &sigma.sigma_2.alpha2,
        &sigma.sigma_2.alpha3,
        &sigma.sigma_2.alpha4,
        &sigma.sigma_2.gamma,
        &sigma.sigma_2.delta,
        &sigma.sigma_2.eta,
        &sigma.sigma_2.x,
        &sigma.sigma_2.y,
    ] {
        push_g2(&mut output, point);
    }
    output
}

fn encode_g1_slice(points: &[ArchivedG1SerdeRkyv]) -> Vec<u8> {
    let mut output = Vec::with_capacity(points.len() * G1_SERIALIZED_BYTES);
    for point in points {
        push_g1(&mut output, point);
    }
    output
}

fn encode_nested_g1_slice(rows: &[rkyv::vec::ArchivedVec<ArchivedG1SerdeRkyv>]) -> Vec<u8> {
    let mut output =
        Vec::with_capacity(rows.iter().map(|row| row.len()).sum::<usize>() * G1_SERIALIZED_BYTES);
    for row in rows {
        for point in row.as_slice() {
            push_g1(&mut output, point);
        }
    }
    output
}

fn push_g1(output: &mut Vec<u8>, point: &ArchivedG1SerdeRkyv) {
    output.extend_from_slice(&point.x);
    output.extend_from_slice(&point.y);
}

fn push_g2(output: &mut Vec<u8>, point: &ArchivedG2SerdeRkyv) {
    output.extend_from_slice(&point.x);
    output.extend_from_slice(&point.y);
}
