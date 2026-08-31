use crate::accumulator::{Accumulator, AccumulatorRkyv};
use crate::conversions::{
    deserialize_g1_affine, deserialize_g2_affine, serialize_g1_affine, serialize_g2_affine,
};
use crate::protocol::{
    AdaptedTau, CurveGroup, DuskExponentMapping, PointChunkDescriptor, ProtocolError, Sha256Digest,
};
use crate::sigma::{DuskSourceProvenance, Phase1SourceProvenance};
use crate::utils::same_ratio;
use crate::utils::{icicle_g1_generator, icicle_g2_generator};
use ark_serialize::Compress;
use icicle_bls12_381::curve::{G1Affine, G2Affine};
use libs::crs_artifacts::{ArchivedG1SerdeRkyvExt, ArchivedG2SerdeRkyvExt};
use libs::group_structures::{G1serde, G2serde};
use memmap::{Mmap, MmapOptions};
use rayon::prelude::*;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest as ShaDigest, Sha256};
use std::cmp::max;
use std::env;
use std::fs::File;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use tempfile::NamedTempFile;

pub trait AlphaXBasis {
    fn g1(&self) -> G1serde;
    fn g2(&self) -> G2serde;
    fn alpha_g2(&self, exp_alpha: usize) -> G2serde;
    fn x_g2(&self, exp_x: usize) -> G2serde;
    fn x_g1_range(&self, exp_min: usize, exp_max: usize) -> Vec<G1Affine>;
    fn alphax_g1(&self, exp_alpha: usize, exp_x: usize) -> G1serde;
}

struct AccumulatorZeroCopy {
    mmap: Mmap,
}

impl AccumulatorZeroCopy {
    fn load(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let mmap = unsafe { MmapOptions::new().map(&file)? };
        rkyv::check_archived_root::<AccumulatorRkyv>(&mmap).map_err(|err| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Invalid accumulator archive: {err:?}"),
            )
        })?;
        Ok(Self { mmap })
    }

    fn accumulator(&self) -> &rkyv::Archived<AccumulatorRkyv> {
        unsafe { rkyv::archived_root::<AccumulatorRkyv>(&self.mmap) }
    }
}

enum AccumulatorAlphaXBasisInner {
    Owned(Accumulator),
    Mapped(AccumulatorZeroCopy),
}

pub struct AccumulatorAlphaXBasis {
    inner: AccumulatorAlphaXBasisInner,
}

impl AccumulatorAlphaXBasis {
    pub fn read_from_json(path: &str) -> io::Result<Self> {
        let abs_json_path = env::current_dir()?.join(path);
        let rkyv_path = Accumulator::rkyv_path_for_json_path(&abs_json_path);
        if cache_is_fresh(&rkyv_path, &abs_json_path) {
            if let Ok(mapped) = AccumulatorZeroCopy::load(&rkyv_path) {
                return Ok(Self {
                    inner: AccumulatorAlphaXBasisInner::Mapped(mapped),
                });
            }
        }

        let accumulator = Accumulator::read_from_json(path)?;
        let _ = accumulator.write_rkyv_sidecar_for_json_path(path);
        if let Ok(mapped) = AccumulatorZeroCopy::load(&rkyv_path) {
            return Ok(Self {
                inner: AccumulatorAlphaXBasisInner::Mapped(mapped),
            });
        }

        Ok(Self {
            inner: AccumulatorAlphaXBasisInner::Owned(accumulator),
        })
    }
}

const DUSK_HASH_BYTES: usize = 64;
const DUSK_TAU_POWERS_LENGTH: usize = 1 << 21;
const DUSK_TAU_POWERS_G1_LENGTH: usize = (DUSK_TAU_POWERS_LENGTH << 1) - 1;
const DUSK_G1_UNCOMPRESSED_BYTES: usize = 96;
const DUSK_G2_UNCOMPRESSED_BYTES: usize = 192;
const DUSK_G1_COMPRESSED_BYTES: usize = 48;
const DUSK_G2_COMPRESSED_BYTES: usize = 96;
const DUSK_PUBLIC_KEY_BYTES: usize =
    (3 * DUSK_G2_UNCOMPRESSED_BYTES) + (6 * DUSK_G1_UNCOMPRESSED_BYTES);
const DUSK_CHALLENGE_BYTES: usize = DUSK_HASH_BYTES
    + (DUSK_TAU_POWERS_G1_LENGTH * DUSK_G1_UNCOMPRESSED_BYTES)
    + (DUSK_TAU_POWERS_LENGTH * DUSK_G2_UNCOMPRESSED_BYTES)
    + (DUSK_TAU_POWERS_LENGTH * DUSK_G1_UNCOMPRESSED_BYTES)
    + (DUSK_TAU_POWERS_LENGTH * DUSK_G1_UNCOMPRESSED_BYTES)
    + DUSK_G2_UNCOMPRESSED_BYTES;
const DUSK_RESPONSE_BYTES: usize = DUSK_HASH_BYTES
    + (DUSK_TAU_POWERS_G1_LENGTH * DUSK_G1_COMPRESSED_BYTES)
    + (DUSK_TAU_POWERS_LENGTH * DUSK_G2_COMPRESSED_BYTES)
    + (DUSK_TAU_POWERS_LENGTH * DUSK_G1_COMPRESSED_BYTES)
    + (DUSK_TAU_POWERS_LENGTH * DUSK_G1_COMPRESSED_BYTES)
    + DUSK_G2_COMPRESSED_BYTES
    + DUSK_PUBLIC_KEY_BYTES;
const DUSK_TRUSTED_SETUP_REPO: &str = "dusk-network/trusted-setup";
const DUSK_PINNED_CONTRIBUTION: &str = "0015";
const DUSK_PINNED_README_URL: &str =
    "https://raw.githubusercontent.com/dusk-network/trusted-setup/main/contributions/0015/README.md";
const DUSK_PINNED_DRIVE_FILE_ID: &str = "1nv9WpxXWMiP8-YwImd2FVn523u7_sb48";
const DUSK_PINNED_SOURCE_SHA256: &str =
    "52c9d47e5cddd585b9b0c2e5ade6f809046d516289302871766bdc463e7be214";
const DUSK_DOWNLOAD_PROGRESS_STEP_BYTES: u64 = 32 * 1024 * 1024;
const ADAPTED_TAU_CHUNK_POINTS: usize = 1 << 16;

struct DuskResponseDownload {
    contribution: String,
    readme_url: String,
    drive_file_id: String,
}

#[derive(Clone, Copy)]
enum DuskRawEncoding {
    Compressed,
    Uncompressed,
}

impl DuskRawEncoding {
    fn as_str(self) -> &'static str {
        match self {
            DuskRawEncoding::Compressed => "compressed-response",
            DuskRawEncoding::Uncompressed => "uncompressed-challenge",
        }
    }
}

pub struct DuskAdaptedAlphaXBasis {
    g1: G1serde,
    g2: G2serde,
    tau_powers_g1: Vec<G1Affine>,
    tau_powers_g2: Vec<G2Affine>,
    tokamak_n: usize,
    provenance: DuskSourceProvenance,
    manifest: AdaptedTau,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuskAdaptorLayout {
    pub tokamak_n: usize,
    pub alpha_max: usize,
    pub x_max: usize,
    pub alpha_x_max: usize,
}

impl DuskAdaptorLayout {
    pub fn new(tokamak_n: usize, x_max: usize, alpha_x_max: usize) -> io::Result<Self> {
        let value = Self {
            tokamak_n,
            alpha_max: 4,
            x_max,
            alpha_x_max,
        };
        value.mapping()?;
        Ok(value)
    }

    pub fn digest(&self) -> io::Result<Sha256Digest> {
        serde_json::to_vec(self)
            .map(|bytes| Sha256Digest::from_bytes(&bytes))
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    fn mapping(&self) -> io::Result<DuskExponentMapping> {
        if self.tokamak_n == 0 || self.x_max == 0 || self.alpha_x_max < self.x_max {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Dusk adaptor layout requires positive bounds and alpha_x_max >= x_max",
            ));
        }
        let omega_stride = self.tokamak_n.checked_mul(2).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Dusk omega stride overflow")
        })?;
        let max_source_g1_exponent = omega_stride
            .checked_mul(self.alpha_max)
            .and_then(|value| value.checked_add(self.alpha_x_max))
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "Dusk G1 exponent overflow")
            })?;
        let max_source_g2_exponent = omega_stride.checked_mul(self.alpha_max).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Dusk G2 exponent overflow")
        })?;
        let mapping = DuskExponentMapping {
            mapping_version: 1,
            tokamak_n: self.tokamak_n as u64,
            alpha_max: self.alpha_max as u64,
            x_max: self.x_max as u64,
            alpha_x_max: self.alpha_x_max as u64,
            omega_stride: omega_stride as u64,
            max_source_g1_exponent: max_source_g1_exponent as u64,
            max_source_g2_exponent: max_source_g2_exponent as u64,
        };
        mapping.validate().map_err(protocol_io_error)?;
        Ok(mapping)
    }
}

pub struct DuskTauAdaptor;

impl DuskTauAdaptor {
    pub fn adapt_pinned_file(
        path: &str,
        capacity_digest: Sha256Digest,
        layout_digest: Sha256Digest,
        layout: DuskAdaptorLayout,
    ) -> io::Result<DuskAdaptedAlphaXBasis> {
        let downloaded = ensure_dusk_raw_response_available(Path::new(path))?;
        let bytes = std::fs::read(path)?;
        let actual_source_sha256 = verify_pinned_source_digest(&bytes)?;
        let encoding = dusk_raw_encoding(bytes.len())?;

        let mapping = layout.mapping()?;
        let max_g1_exp = usize::try_from(mapping.max_source_g1_exponent).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Dusk G1 exponent does not fit usize",
            )
        })?;
        let max_g2_exp = usize::try_from(mapping.max_source_g2_exponent).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Dusk G2 exponent does not fit usize",
            )
        })?;

        if max_g1_exp >= DUSK_TAU_POWERS_G1_LENGTH || max_g2_exp >= DUSK_TAU_POWERS_LENGTH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "Tokamak adaptor mapping requires tau powers beyond the pinned Dusk artifact bounds"
                ),
            ));
        }

        let (g1_point_bytes, g2_point_bytes, compression) = match encoding {
            DuskRawEncoding::Compressed => (
                DUSK_G1_COMPRESSED_BYTES,
                DUSK_G2_COMPRESSED_BYTES,
                Compress::Yes,
            ),
            DuskRawEncoding::Uncompressed => (
                DUSK_G1_UNCOMPRESSED_BYTES,
                DUSK_G2_UNCOMPRESSED_BYTES,
                Compress::No,
            ),
        };

        let tau_g1_offset = DUSK_HASH_BYTES;
        let tau_g2_offset = tau_g1_offset + (DUSK_TAU_POWERS_G1_LENGTH * g1_point_bytes);

        let mut tau_powers_g1 = Vec::with_capacity(max_g1_exp + 1);
        for exp in 0..=max_g1_exp {
            let start = tau_g1_offset + (exp * g1_point_bytes);
            let end = start + g1_point_bytes;
            tau_powers_g1.push(deserialize_g1_affine(
                &bytes[start..end].to_vec().into_boxed_slice(),
                compression,
            )?);
        }

        let mut tau_powers_g2 = Vec::with_capacity(max_g2_exp + 1);
        for exp in 0..=max_g2_exp {
            let start = tau_g2_offset + (exp * g2_point_bytes);
            let end = start + g2_point_bytes;
            tau_powers_g2.push(deserialize_g2_affine(
                &bytes[start..end].to_vec().into_boxed_slice(),
                compression,
            )?);
        }

        let provenance = DuskSourceProvenance {
            source_url: drive_direct_download_url(DUSK_PINNED_DRIVE_FILE_ID),
            source_size_bytes: bytes.len() as u64,
            raw_encoding: encoding.as_str().to_string(),
            pinned_contribution: DUSK_PINNED_CONTRIBUTION.to_string(),
            pinned_readme_url: DUSK_PINNED_README_URL.to_string(),
            pinned_drive_file_id: DUSK_PINNED_DRIVE_FILE_ID.to_string(),
            expected_source_sha256: DUSK_PINNED_SOURCE_SHA256.to_string(),
            actual_source_sha256,
            auto_downloaded: downloaded.is_some(),
            downloaded_contribution: downloaded.as_ref().map(|value| value.contribution.clone()),
            downloaded_readme_url: downloaded.as_ref().map(|value| value.readme_url.clone()),
            downloaded_drive_file_id: downloaded.as_ref().map(|value| value.drive_file_id.clone()),
            max_g1_exp_used: max_g1_exp,
            max_g2_exp_used: max_g2_exp,
            transcript_consistency_verified: true,
        };
        finish_adaptation(
            tau_powers_g1,
            tau_powers_g2,
            provenance,
            capacity_digest,
            layout_digest,
            layout,
        )
    }
}

fn finish_adaptation(
    tau_powers_g1: Vec<G1Affine>,
    tau_powers_g2: Vec<G2Affine>,
    provenance: DuskSourceProvenance,
    capacity_digest: Sha256Digest,
    layout_digest: Sha256Digest,
    layout: DuskAdaptorLayout,
) -> io::Result<DuskAdaptedAlphaXBasis> {
    let mapping = layout.mapping()?;
    let required_g1 = usize::try_from(mapping.max_source_g1_exponent)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "G1 range overflow"))?;
    let required_g2 = usize::try_from(mapping.max_source_g2_exponent)
        .ok()
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "G2 range overflow"))?;
    if tau_powers_g1.len() < required_g1 || tau_powers_g2.len() < required_g2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Dusk tau has insufficient degree: require at least {required_g1} G1 and {required_g2} G2 powers"
            ),
        ));
    }
    let g1 = G1serde(tau_powers_g1[0]);
    let g2 = G2serde(tau_powers_g2[0]);
    if g1 != icicle_g1_generator() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Dusk raw PoT file: tau^0 in G1 is not the canonical generator",
        ));
    }
    if g2 != icicle_g2_generator() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Dusk raw PoT file: tau^0 in G2 is not the canonical generator",
        ));
    }
    verify_dusk_tau_consistency(&tau_powers_g1, &tau_powers_g2)?;
    let alpha_x_chunks = adapted_chunk_descriptors(&tau_powers_g1, &tau_powers_g2, &layout)?;
    let manifest = AdaptedTau::new(
        provenance.clone(),
        capacity_digest,
        layout_digest,
        mapping,
        alpha_x_chunks,
    )
    .map_err(protocol_io_error)?;
    validate_adapted_chunk_geometry(&manifest)?;
    Ok(DuskAdaptedAlphaXBasis {
        g1,
        g2,
        tau_powers_g1,
        tau_powers_g2,
        tokamak_n: layout.tokamak_n,
        provenance,
        manifest,
    })
}

impl DuskAdaptedAlphaXBasis {
    fn omega_exp(&self, exp_alpha: usize) -> usize {
        2 * self.tokamak_n * exp_alpha
    }

    fn tau_g1(&self, exp: usize) -> G1serde {
        G1serde(self.tau_powers_g1[exp])
    }

    fn tau_g2(&self, exp: usize) -> G2serde {
        G2serde(self.tau_powers_g2[exp])
    }

    pub fn provenance(&self) -> DuskSourceProvenance {
        self.provenance.clone()
    }

    pub fn manifest(&self) -> &AdaptedTau {
        &self.manifest
    }

    pub fn write_bundle(&self, directory: &Path) -> io::Result<()> {
        std::fs::create_dir_all(directory)?;
        let mut descriptor_index = 0usize;
        visit_adapted_chunks(
            &self.tau_powers_g1,
            &self.tau_powers_g2,
            &layout_from_mapping(&self.manifest.mapping)?,
            |descriptor, bytes| {
                let expected = self
                    .manifest
                    .alpha_x_chunks
                    .get(descriptor_index)
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "adapted tau manifest has fewer chunks than its mapped basis",
                        )
                    })?;
                if expected != &descriptor {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "adapted tau chunk differs from its manifest descriptor",
                    ));
                }
                persist_content_addressed_chunk(directory, &descriptor, &bytes)?;
                descriptor_index += 1;
                Ok(())
            },
        )?;
        if descriptor_index != self.manifest.alpha_x_chunks.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "adapted tau manifest has extra chunk descriptors",
            ));
        }
        let manifest_bytes = self
            .manifest
            .to_canonical_json()
            .map_err(protocol_io_error)?;
        persist_named_file(directory, "adapted_tau.json", &manifest_bytes)
    }
}

fn protocol_io_error(error: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

pub fn verify_adapted_tau_bundle(directory: &Path) -> io::Result<AdaptedTau> {
    let manifest_path = directory.join("adapted_tau.json");
    let manifest_bytes = std::fs::read(&manifest_path)?;
    let manifest = AdaptedTau::from_canonical_json(&manifest_bytes).map_err(protocol_io_error)?;
    validate_pinned_provenance(&manifest.source_provenance)?;
    validate_adapted_chunk_geometry(&manifest)?;
    for descriptor in &manifest.alpha_x_chunks {
        let path = directory.join(descriptor.content_addressed_file_name());
        let bytes = std::fs::read(&path)?;
        descriptor
            .validate_bytes(&bytes)
            .map_err(protocol_io_error)?;
    }
    Ok(manifest)
}

fn validate_pinned_provenance(provenance: &DuskSourceProvenance) -> io::Result<()> {
    if provenance.pinned_contribution != DUSK_PINNED_CONTRIBUTION
        || provenance.pinned_readme_url != DUSK_PINNED_README_URL
        || provenance.pinned_drive_file_id != DUSK_PINNED_DRIVE_FILE_ID
        || provenance.expected_source_sha256 != DUSK_PINNED_SOURCE_SHA256
        || provenance.actual_source_sha256 != DUSK_PINNED_SOURCE_SHA256
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "adapted tau provenance does not identify the pinned Dusk artifact",
        ));
    }
    Ok(())
}

fn layout_from_mapping(mapping: &DuskExponentMapping) -> io::Result<DuskAdaptorLayout> {
    DuskAdaptorLayout::new(
        usize::try_from(mapping.tokamak_n).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "tokamakN does not fit usize")
        })?,
        usize::try_from(mapping.x_max)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "xMax does not fit usize"))?,
        usize::try_from(mapping.alpha_x_max).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "alphaXMax does not fit usize")
        })?,
    )
}

fn adapted_chunk_descriptors(
    g1_powers: &[G1Affine],
    g2_powers: &[G2Affine],
    layout: &DuskAdaptorLayout,
) -> io::Result<Vec<PointChunkDescriptor>> {
    let mut descriptors = Vec::new();
    visit_adapted_chunks(g1_powers, g2_powers, layout, |descriptor, _| {
        descriptors.push(descriptor);
        Ok(())
    })?;
    Ok(descriptors)
}

fn visit_adapted_chunks(
    g1_powers: &[G1Affine],
    g2_powers: &[G2Affine],
    layout: &DuskAdaptorLayout,
    mut visit: impl FnMut(PointChunkDescriptor, Vec<u8>) -> io::Result<()>,
) -> io::Result<()> {
    let mapping = layout.mapping()?;
    let stride = usize::try_from(mapping.omega_stride).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "omega stride does not fit usize",
        )
    })?;

    let alpha_g1 = (1..=layout.alpha_max)
        .map(|k| g1_powers[stride * k])
        .collect::<Vec<_>>();
    visit_point_chunk(
        "alpha",
        CurveGroup::G1,
        vec![layout.alpha_max],
        vec![0],
        &alpha_g1,
        &[],
        &mut visit,
    )?;
    let alpha_g2 = (1..=layout.alpha_max)
        .map(|k| g2_powers[stride * k])
        .collect::<Vec<_>>();
    visit_point_chunk(
        "alpha",
        CurveGroup::G2,
        vec![layout.alpha_max],
        vec![0],
        &[],
        &alpha_g2,
        &mut visit,
    )?;

    for start in (0..=layout.x_max).step_by(ADAPTED_TAU_CHUNK_POINTS) {
        let end = (start + ADAPTED_TAU_CHUNK_POINTS).min(layout.x_max + 1);
        visit_point_chunk(
            "x",
            CurveGroup::G1,
            vec![end - start],
            vec![start],
            &g1_powers[start..end],
            &[],
            &mut visit,
        )?;
    }
    visit_point_chunk(
        "x",
        CurveGroup::G2,
        vec![2],
        vec![0],
        &[],
        &g2_powers[..2],
        &mut visit,
    )?;

    for alpha_index in 1..=layout.alpha_max {
        let row_offset = stride * alpha_index;
        for start in (0..=layout.alpha_x_max).step_by(ADAPTED_TAU_CHUNK_POINTS) {
            let end = (start + ADAPTED_TAU_CHUNK_POINTS).min(layout.alpha_x_max + 1);
            visit_point_chunk(
                "alphaX",
                CurveGroup::G1,
                vec![1, end - start],
                vec![alpha_index - 1, start],
                &g1_powers[row_offset + start..row_offset + end],
                &[],
                &mut visit,
            )?;
        }
    }
    Ok(())
}

fn visit_point_chunk(
    family: &str,
    group: CurveGroup,
    shape: Vec<usize>,
    start_indices: Vec<usize>,
    g1_points: &[G1Affine],
    g2_points: &[G2Affine],
    visit: &mut impl FnMut(PointChunkDescriptor, Vec<u8>) -> io::Result<()>,
) -> io::Result<()> {
    let bytes = match group {
        CurveGroup::G1 => g1_points
            .iter()
            .flat_map(|point| serialize_g1_affine(point, Compress::Yes).into_vec())
            .collect::<Vec<u8>>(),
        CurveGroup::G2 => g2_points
            .iter()
            .flat_map(|point| serialize_g2_affine(point, Compress::Yes).into_vec())
            .collect::<Vec<u8>>(),
    };
    let shape = shape
        .into_iter()
        .map(u64::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "chunk shape does not fit u64"))?;
    let start_indices = start_indices
        .into_iter()
        .map(u64::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "chunk offset does not fit u64")
        })?;
    let descriptor = PointChunkDescriptor::from_bytes(family, group, shape, start_indices, &bytes)
        .map_err(protocol_io_error)?;
    visit(descriptor, bytes)
}

fn validate_adapted_chunk_geometry(manifest: &AdaptedTau) -> io::Result<()> {
    let layout = layout_from_mapping(&manifest.mapping)?;
    let mut expected = Vec::new();
    expected.push(("alpha", CurveGroup::G1, vec![layout.alpha_max], vec![0]));
    expected.push(("alpha", CurveGroup::G2, vec![layout.alpha_max], vec![0]));
    for start in (0..=layout.x_max).step_by(ADAPTED_TAU_CHUNK_POINTS) {
        let end = (start + ADAPTED_TAU_CHUNK_POINTS).min(layout.x_max + 1);
        expected.push(("x", CurveGroup::G1, vec![end - start], vec![start]));
    }
    expected.push(("x", CurveGroup::G2, vec![2], vec![0]));
    for alpha_index in 1..=layout.alpha_max {
        for start in (0..=layout.alpha_x_max).step_by(ADAPTED_TAU_CHUNK_POINTS) {
            let end = (start + ADAPTED_TAU_CHUNK_POINTS).min(layout.alpha_x_max + 1);
            expected.push((
                "alphaX",
                CurveGroup::G1,
                vec![1, end - start],
                vec![alpha_index - 1, start],
            ));
        }
    }
    if manifest.alpha_x_chunks.len() != expected.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "adapted tau chunk count does not match its exponent mapping",
        ));
    }
    for (descriptor, (family, group, shape, start_indices)) in
        manifest.alpha_x_chunks.iter().zip(expected)
    {
        let shape = shape
            .into_iter()
            .map(|value| value as u64)
            .collect::<Vec<_>>();
        let start_indices = start_indices
            .into_iter()
            .map(|value| value as u64)
            .collect::<Vec<_>>();
        if descriptor.family != family
            || descriptor.group != group
            || descriptor.shape != shape
            || descriptor.start_indices != start_indices
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "adapted tau chunk geometry does not match its exponent mapping",
            ));
        }
    }
    Ok(())
}

fn persist_content_addressed_chunk(
    directory: &Path,
    descriptor: &PointChunkDescriptor,
    bytes: &[u8],
) -> io::Result<()> {
    let file_name = descriptor.content_addressed_file_name();
    let path = directory.join(&file_name);
    if path.exists() {
        let existing = std::fs::read(&path)?;
        return descriptor
            .validate_bytes(&existing)
            .map_err(protocol_io_error);
    }
    persist_named_file(directory, &file_name, bytes)
}

fn persist_named_file(directory: &Path, file_name: &str, bytes: &[u8]) -> io::Result<()> {
    let mut temporary = NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.flush()?;
    temporary
        .persist(directory.join(file_name))
        .map_err(|error| error.error)?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn verify_pinned_source_digest(bytes: &[u8]) -> io::Result<String> {
    let actual = sha256_hex(bytes);
    if actual != DUSK_PINNED_SOURCE_SHA256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Dusk raw PoT file SHA-256 mismatch: expected {}, got {}",
                DUSK_PINNED_SOURCE_SHA256, actual
            ),
        ));
    }
    Ok(actual)
}

fn dusk_raw_encoding(byte_length: usize) -> io::Result<DuskRawEncoding> {
    match byte_length {
        DUSK_CHALLENGE_BYTES => Ok(DuskRawEncoding::Uncompressed),
        DUSK_RESPONSE_BYTES => Ok(DuskRawEncoding::Compressed),
        len => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unsupported Dusk raw PoT file size {len}; expected challenge size {DUSK_CHALLENGE_BYTES} or response size {DUSK_RESPONSE_BYTES}"
            ),
        )),
    }
}

fn verify_dusk_tau_consistency(g1_powers: &[G1Affine], g2_powers: &[G2Affine]) -> io::Result<()> {
    if g1_powers.len() < 2 || g2_powers.len() < 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Dusk raw PoT file must contain at least tau^0 and tau^1 in both G1 and G2",
        ));
    }

    let g1_gen = G1serde(g1_powers[0]);
    let tau_g1 = G1serde(g1_powers[1]);
    let g2_gen = G2serde(g2_powers[0]);
    let tau_g2 = G2serde(g2_powers[1]);

    if !same_ratio(g1_gen, tau_g1, g2_gen, tau_g2) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Dusk raw PoT file failed tau consistency between G1 and G2 generators",
        ));
    }

    if let Some(index) = (0..g1_powers.len() - 1).into_par_iter().find_any(|&index| {
        !same_ratio(
            G1serde(g1_powers[index]),
            G1serde(g1_powers[index + 1]),
            g2_gen,
            tau_g2,
        )
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Dusk raw PoT file failed G1 tau consistency at exponent {}",
                index + 1
            ),
        ));
    }

    if let Some(index) = (0..g2_powers.len() - 1).into_par_iter().find_any(|&index| {
        !same_ratio(
            g1_gen,
            tau_g1,
            G2serde(g2_powers[index]),
            G2serde(g2_powers[index + 1]),
        )
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Dusk raw PoT file failed G2 tau consistency at exponent {}",
                index + 1
            ),
        ));
    }

    Ok(())
}

fn dusk_http_client() -> io::Result<Client> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("tokamak-zkevm-mpc-setup/1.0"),
    );
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(
            "application/vnd.github+json, text/plain, application/octet-stream",
        ),
    );
    Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|err| io::Error::other(format!("failed to build HTTP client: {err}")))
}

fn pinned_dusk_response() -> DuskResponseDownload {
    DuskResponseDownload {
        contribution: DUSK_PINNED_CONTRIBUTION.to_string(),
        readme_url: DUSK_PINNED_README_URL.to_string(),
        drive_file_id: DUSK_PINNED_DRIVE_FILE_ID.to_string(),
    }
}

fn drive_direct_download_url(file_id: &str) -> String {
    format!("https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t")
}

fn format_progress_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GiB", bytes as f64 / GIB)
    } else {
        format!("{:.2} MiB", bytes as f64 / MIB)
    }
}

fn download_dusk_response(path: &Path) -> io::Result<DuskResponseDownload> {
    let client = dusk_http_client()?;
    let download = pinned_dusk_response();
    let download_url = drive_direct_download_url(&download.drive_file_id);
    println!(
        "Downloading pinned Dusk Groth16 response contribution {} from {} in {}",
        download.contribution, download.readme_url, DUSK_TRUSTED_SETUP_REPO
    );

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let temp_dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| Path::new(".").to_path_buf());
    let mut temp_file = NamedTempFile::new_in(temp_dir)?;

    let mut response = client
        .get(&download_url)
        .send()
        .map_err(|err| io::Error::other(format!("failed to download Dusk response: {err}")))?;
    if !response.status().is_success() {
        return Err(io::Error::other(format!(
            "failed to download Dusk response: HTTP {}",
            response.status()
        )));
    }

    let total_bytes = response.content_length();
    match total_bytes {
        Some(total) => println!(
            "Starting Dusk raw response download: {} total",
            format_progress_bytes(total)
        ),
        None => println!("Starting Dusk raw response download: total size unknown"),
    }

    let report_interval = total_bytes
        .map(|total| max(total / 20, DUSK_DOWNLOAD_PROGRESS_STEP_BYTES))
        .unwrap_or(DUSK_DOWNLOAD_PROGRESS_STEP_BYTES);
    let mut next_report = report_interval;
    let mut downloaded = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];

    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|err| io::Error::other(format!("failed to stream Dusk response: {err}")))?;
        if read == 0 {
            break;
        }
        temp_file
            .write_all(&buffer[..read])
            .map_err(|err| io::Error::other(format!("failed to write Dusk response: {err}")))?;
        downloaded += read as u64;

        if downloaded >= next_report {
            match total_bytes {
                Some(total) => println!(
                    "Dusk raw response download progress: {:.1}% ({}/{})",
                    (downloaded as f64 / total as f64) * 100.0,
                    format_progress_bytes(downloaded),
                    format_progress_bytes(total)
                ),
                None => println!(
                    "Dusk raw response download progress: {} downloaded",
                    format_progress_bytes(downloaded)
                ),
            }
            next_report = next_report.saturating_add(report_interval);
        }
    }

    match total_bytes {
        Some(total) => println!(
            "Completed Dusk raw response download: {}/{}",
            format_progress_bytes(downloaded),
            format_progress_bytes(total)
        ),
        None => println!(
            "Completed Dusk raw response download: {}",
            format_progress_bytes(downloaded)
        ),
    }

    temp_file
        .flush()
        .map_err(|err| io::Error::other(format!("failed to flush Dusk response: {err}")))?;
    temp_file
        .persist(path)
        .map_err(|err| io::Error::other(format!("failed to persist Dusk response: {err}")))?;
    Ok(download)
}

fn ensure_dusk_raw_response_available(path: &Path) -> io::Result<Option<DuskResponseDownload>> {
    if path.exists() {
        return Ok(None);
    }
    println!(
        "Dusk raw response file {} is missing locally; downloading it from the web.",
        path.display()
    );
    download_dusk_response(path).map(Some)
}

pub enum AlphaXBasisSource {
    Accumulator(AccumulatorAlphaXBasis),
    DuskAdapted(DuskAdaptedAlphaXBasis),
}

impl AlphaXBasisSource {
    pub fn provenance(&self) -> Phase1SourceProvenance {
        match self {
            AlphaXBasisSource::Accumulator(_) => Phase1SourceProvenance::Native,
            AlphaXBasisSource::DuskAdapted(source) => {
                Phase1SourceProvenance::DuskGroth16(source.provenance())
            }
        }
    }
}

fn cache_is_fresh(cache_path: &Path, source_path: &Path) -> bool {
    let Ok(cache_meta) = std::fs::metadata(cache_path) else {
        return false;
    };
    let Ok(cache_modified) = cache_meta.modified() else {
        return false;
    };
    let Ok(source_meta) = std::fs::metadata(source_path) else {
        return true;
    };
    let Ok(source_modified) = source_meta.modified() else {
        return true;
    };
    cache_modified >= source_modified
}

fn archived_x_g1_range(
    archived: &rkyv::Archived<AccumulatorRkyv>,
    exp_min: usize,
    exp_max: usize,
) -> Vec<G1Affine> {
    if exp_min > 0 {
        return archived.x.g1[exp_min - 1..exp_max]
            .iter()
            .map(|value| value.to_g1_affine())
            .collect();
    }

    let mut out = Vec::with_capacity(exp_max + 1);
    out.push(archived.g1.to_g1_affine());
    out.extend(
        archived.x.g1[..exp_max]
            .iter()
            .map(|value| value.to_g1_affine()),
    );
    out
}

impl AlphaXBasis for AccumulatorAlphaXBasis {
    fn g1(&self) -> G1serde {
        match &self.inner {
            AccumulatorAlphaXBasisInner::Owned(acc) => acc.g1,
            AccumulatorAlphaXBasisInner::Mapped(acc) => acc.accumulator().g1.to_g1serde(),
        }
    }

    fn g2(&self) -> G2serde {
        match &self.inner {
            AccumulatorAlphaXBasisInner::Owned(acc) => acc.g2,
            AccumulatorAlphaXBasisInner::Mapped(acc) => acc.accumulator().g2.to_g2serde(),
        }
    }

    fn alpha_g2(&self, exp_alpha: usize) -> G2serde {
        match &self.inner {
            AccumulatorAlphaXBasisInner::Owned(acc) => acc.alpha[exp_alpha - 1].g2,
            AccumulatorAlphaXBasisInner::Mapped(acc) => {
                acc.accumulator().alpha[exp_alpha - 1].g2.to_g2serde()
            }
        }
    }

    fn x_g2(&self, exp_x: usize) -> G2serde {
        assert_eq!(exp_x, 1, "the native alpha/X basis stores only x^1 in G2");
        match &self.inner {
            AccumulatorAlphaXBasisInner::Owned(acc) => acc.get_x_g2(exp_x),
            AccumulatorAlphaXBasisInner::Mapped(acc) => acc.accumulator().x.g2.to_g2serde(),
        }
    }

    fn x_g1_range(&self, exp_min: usize, exp_max: usize) -> Vec<G1Affine> {
        match &self.inner {
            AccumulatorAlphaXBasisInner::Owned(acc) => acc.get_x_g1_range(exp_min, exp_max),
            AccumulatorAlphaXBasisInner::Mapped(acc) => {
                archived_x_g1_range(acc.accumulator(), exp_min, exp_max)
            }
        }
    }

    fn alphax_g1(&self, exp_alpha: usize, exp_x: usize) -> G1serde {
        match &self.inner {
            AccumulatorAlphaXBasisInner::Owned(acc) => acc.get_alphax_g1(exp_alpha, exp_x),
            AccumulatorAlphaXBasisInner::Mapped(acc) => {
                let archived = acc.accumulator();
                assert!(exp_alpha <= 4);
                assert!(exp_x <= archived.x.g1.len());
                if exp_alpha == 0 && exp_x == 0 {
                    archived.g1.to_g1serde()
                } else if exp_alpha == 0 {
                    if exp_x == 0 {
                        archived.g1.to_g1serde()
                    } else {
                        archived.x.g1[exp_x - 1].to_g1serde()
                    }
                } else if exp_x == 0 {
                    archived.alpha[exp_alpha - 1].g1.to_g1serde()
                } else {
                    archived.alpha_x[(exp_alpha - 1) * archived.x.g1.len() + exp_x - 1].to_g1serde()
                }
            }
        }
    }
}

impl AlphaXBasis for DuskAdaptedAlphaXBasis {
    fn g1(&self) -> G1serde {
        self.g1
    }

    fn g2(&self) -> G2serde {
        self.g2
    }

    fn alpha_g2(&self, exp_alpha: usize) -> G2serde {
        self.tau_g2(self.omega_exp(exp_alpha))
    }

    fn x_g2(&self, exp_x: usize) -> G2serde {
        assert_eq!(exp_x, 1, "the adapted Dusk basis stores only x^1 in G2");
        self.tau_g2(1)
    }

    fn x_g1_range(&self, exp_min: usize, exp_max: usize) -> Vec<G1Affine> {
        self.tau_powers_g1[exp_min..=exp_max].to_vec()
    }

    fn alphax_g1(&self, exp_alpha: usize, exp_x: usize) -> G1serde {
        if exp_alpha == 0 {
            return self.tau_g1(exp_x);
        }
        self.tau_g1(self.omega_exp(exp_alpha) + exp_x)
    }
}

impl AlphaXBasis for AlphaXBasisSource {
    fn g1(&self) -> G1serde {
        match self {
            AlphaXBasisSource::Accumulator(source) => source.g1(),
            AlphaXBasisSource::DuskAdapted(source) => source.g1(),
        }
    }

    fn g2(&self) -> G2serde {
        match self {
            AlphaXBasisSource::Accumulator(source) => source.g2(),
            AlphaXBasisSource::DuskAdapted(source) => source.g2(),
        }
    }

    fn alpha_g2(&self, exp_alpha: usize) -> G2serde {
        match self {
            AlphaXBasisSource::Accumulator(source) => source.alpha_g2(exp_alpha),
            AlphaXBasisSource::DuskAdapted(source) => source.alpha_g2(exp_alpha),
        }
    }

    fn x_g2(&self, exp_x: usize) -> G2serde {
        match self {
            AlphaXBasisSource::Accumulator(source) => source.x_g2(exp_x),
            AlphaXBasisSource::DuskAdapted(source) => source.x_g2(exp_x),
        }
    }

    fn x_g1_range(&self, exp_min: usize, exp_max: usize) -> Vec<G1Affine> {
        match self {
            AlphaXBasisSource::Accumulator(source) => source.x_g1_range(exp_min, exp_max),
            AlphaXBasisSource::DuskAdapted(source) => source.x_g1_range(exp_min, exp_max),
        }
    }

    fn alphax_g1(&self, exp_alpha: usize, exp_x: usize) -> G1serde {
        match self {
            AlphaXBasisSource::Accumulator(source) => source.alphax_g1(exp_alpha, exp_x),
            AlphaXBasisSource::DuskAdapted(source) => source.alphax_g1(exp_alpha, exp_x),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        dusk_raw_encoding, finish_adaptation, verify_adapted_tau_bundle,
        verify_dusk_tau_consistency, verify_pinned_source_digest, DuskAdaptorLayout,
        DUSK_PINNED_CONTRIBUTION, DUSK_PINNED_DRIVE_FILE_ID, DUSK_PINNED_README_URL,
        DUSK_PINNED_SOURCE_SHA256,
    };
    use crate::protocol::Sha256Digest;
    use crate::sigma::DuskSourceProvenance;
    use crate::utils::{icicle_g1_generator, icicle_g2_generator};
    use icicle_bls12_381::curve::{G1Affine, G2Affine, ScalarField};
    use icicle_core::traits::FieldImpl;
    use tempfile::tempdir;

    fn synthetic_tau_sequences(len: usize, tau: ScalarField) -> (Vec<G1Affine>, Vec<G2Affine>) {
        let g1 = icicle_g1_generator().0;
        let g2 = icicle_g2_generator().0;
        let mut current = ScalarField::one();
        let mut g1_powers = Vec::with_capacity(len);
        let mut g2_powers = Vec::with_capacity(len);
        for _ in 0..len {
            g1_powers.push(G1Affine::from(g1.to_projective() * current));
            g2_powers.push(G2Affine::from(g2.to_projective() * current));
            current = current * tau;
        }
        (g1_powers, g2_powers)
    }

    fn synthetic_provenance(max_g1: usize, max_g2: usize) -> DuskSourceProvenance {
        DuskSourceProvenance {
            source_url: "https://drive.usercontent.google.com/pinned".to_string(),
            source_size_bytes: 1,
            raw_encoding: "compressed-response".to_string(),
            pinned_contribution: DUSK_PINNED_CONTRIBUTION.to_string(),
            pinned_readme_url: DUSK_PINNED_README_URL.to_string(),
            pinned_drive_file_id: DUSK_PINNED_DRIVE_FILE_ID.to_string(),
            expected_source_sha256: DUSK_PINNED_SOURCE_SHA256.to_string(),
            actual_source_sha256: DUSK_PINNED_SOURCE_SHA256.to_string(),
            auto_downloaded: false,
            downloaded_contribution: None,
            downloaded_readme_url: None,
            downloaded_drive_file_id: None,
            max_g1_exp_used: max_g1,
            max_g2_exp_used: max_g2,
            transcript_consistency_verified: true,
        }
    }

    #[test]
    fn dusk_tau_consistency_accepts_valid_sequence() {
        let tau = ScalarField::from_u32(5);
        let (g1_powers, g2_powers) = synthetic_tau_sequences(8, tau);
        assert!(verify_dusk_tau_consistency(&g1_powers, &g2_powers).is_ok());
    }

    #[test]
    fn dusk_tau_consistency_rejects_broken_g1_sequence() {
        let tau = ScalarField::from_u32(5);
        let (mut g1_powers, g2_powers) = synthetic_tau_sequences(8, tau);
        let bad_scalar = ScalarField::from_u32(17);
        g1_powers[4] = G1Affine::from(icicle_g1_generator().0.to_projective() * bad_scalar);
        let err = verify_dusk_tau_consistency(&g1_powers, &g2_powers)
            .expect_err("broken G1 tau sequence must fail consistency validation");
        assert!(err.to_string().contains("G1 tau consistency"));
    }

    #[test]
    fn dusk_tau_consistency_rejects_broken_g2_sequence() {
        let tau = ScalarField::from_u32(5);
        let (g1_powers, mut g2_powers) = synthetic_tau_sequences(8, tau);
        let bad_scalar = ScalarField::from_u32(19);
        g2_powers[5] = G2Affine::from(icicle_g2_generator().0.to_projective() * bad_scalar);
        let err = verify_dusk_tau_consistency(&g1_powers, &g2_powers)
            .expect_err("broken G2 tau sequence must fail consistency validation");
        assert!(err.to_string().contains("G2 tau consistency"));
    }

    #[test]
    fn synthetic_dusk_input_produces_a_verified_content_addressed_bundle() {
        let layout = DuskAdaptorLayout::new(2, 4, 4).unwrap();
        let mapping = layout.mapping().unwrap();
        let len = mapping.max_source_g1_exponent as usize + 1;
        let (g1_powers, g2_powers) = synthetic_tau_sequences(len, ScalarField::from_u32(5));
        let adapted = finish_adaptation(
            g1_powers,
            g2_powers,
            synthetic_provenance(
                mapping.max_source_g1_exponent as usize,
                mapping.max_source_g2_exponent as usize,
            ),
            Sha256Digest::from_bytes(b"capacity"),
            Sha256Digest::from_bytes(b"layout"),
            layout,
        )
        .unwrap();
        let directory = tempdir().unwrap();
        adapted.write_bundle(directory.path()).unwrap();
        let verified = verify_adapted_tau_bundle(directory.path()).unwrap();
        assert_eq!(&verified, adapted.manifest());
        assert!(!verified.alpha_x_chunks.is_empty());
        assert!(directory.path().join("adapted_tau.json").is_file());
    }

    #[test]
    fn adaptor_rejects_insufficient_degree_and_mapping_tampering() {
        let layout = DuskAdaptorLayout::new(2, 4, 4).unwrap();
        let mapping = layout.mapping().unwrap();
        let (g1_powers, g2_powers) = synthetic_tau_sequences(8, ScalarField::from_u32(5));
        let error = match finish_adaptation(
            g1_powers,
            g2_powers,
            synthetic_provenance(
                mapping.max_source_g1_exponent as usize,
                mapping.max_source_g2_exponent as usize,
            ),
            Sha256Digest::from_bytes(b"capacity"),
            Sha256Digest::from_bytes(b"layout"),
            layout.clone(),
        ) {
            Ok(_) => panic!("insufficient Dusk powers must be rejected"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("insufficient degree"));

        let len = mapping.max_source_g1_exponent as usize + 1;
        let (g1_powers, g2_powers) = synthetic_tau_sequences(len, ScalarField::from_u32(5));
        let adapted = finish_adaptation(
            g1_powers,
            g2_powers,
            synthetic_provenance(
                mapping.max_source_g1_exponent as usize,
                mapping.max_source_g2_exponent as usize,
            ),
            Sha256Digest::from_bytes(b"capacity"),
            Sha256Digest::from_bytes(b"layout"),
            layout,
        )
        .unwrap();
        let directory = tempdir().unwrap();
        adapted.write_bundle(directory.path()).unwrap();
        let mut tampered = adapted.manifest().clone();
        tampered.alpha_x_chunks[0].family = "wrongFamily".to_string();
        std::fs::write(
            directory.path().join("adapted_tau.json"),
            tampered.to_canonical_json().unwrap(),
        )
        .unwrap();
        let error = verify_adapted_tau_bundle(directory.path())
            .expect_err("mapping geometry tampering must be rejected");
        assert!(error.to_string().contains("geometry"));
    }

    #[test]
    fn adaptor_rejects_source_hash_and_encoding_mismatches() {
        assert!(verify_pinned_source_digest(b"not the pinned artifact").is_err());
        assert!(dusk_raw_encoding(17).is_err());
    }
}
