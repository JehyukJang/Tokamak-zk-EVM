// CRS fields and encoders preserve protocol notation shared with archived artifacts.
#![allow(non_snake_case)]

use crate::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use crate::frontend_artifacts::public_wire_layout::PublicWireLayout;
use crate::frontend_artifacts::{HexString, PlacementVariables, SetupParams, SubcircuitInfo};
use crate::group_structures::{
    count_statement_nvar, encode_o_pub_fix_common, encode_o_pub_free_common,
    encode_statement_common, G1serde, G2serde, PartialSigma1Verify, Sigma, Sigma2, SigmaVerify,
};
#[cfg(feature = "timing")]
use crate::timing::{record as record_timing, SizeInfo};
use crate::vector_operations::resize;
use icicle_bls12_381::curve::{
    BaseField, G1Affine, G1Projective, G2Affine, G2BaseField, ScalarField,
};
use icicle_core::msm::{self, MSMConfig};
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::HostSlice;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process;
#[cfg(feature = "timing")]
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

impl Sigma {
    pub fn sigma_verify(&self) -> SigmaVerify {
        let partial_sigma1_verify: PartialSigma1Verify = PartialSigma1Verify {
            x: self.sigma_1.x,
            y: self.sigma_1.y,
        };
        SigmaVerify {
            G: self.G,
            H: self.H,
            sigma_1: partial_sigma1_verify,
            sigma_2: self.sigma_2,
            lagrange_KL: self.lagrange_KL,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FinalCrsDigests {
    pub combined_sigma_sha256: String,
    pub sigma_preprocess_sha256: String,
    pub sigma_verify_sha256: String,
}

pub fn write_final_crs_artifacts(output_dir: &Path, sigma: &Sigma) -> io::Result<FinalCrsDigests> {
    fs::create_dir_all(output_dir)?;

    let sigma_rkyv = SigmaRkyv::from_sigma(sigma);
    let combined_sigma_bytes = rkyv::to_bytes::<_, 256>(&sigma_rkyv).map_err(io::Error::other)?;
    let sigma_preprocess_rkyv = SigmaPreprocessRkyv::from_sigma(sigma);
    let sigma_preprocess_bytes =
        rkyv::to_bytes::<_, 256>(&sigma_preprocess_rkyv).map_err(io::Error::other)?;

    let sigma_verify = sigma.sigma_verify();
    let sigma_verify_bytes = serde_json::to_vec_pretty(&sigma_verify).map_err(io::Error::other)?;
    write_final_crs_artifact_files(
        output_dir,
        &[
            ("combined_sigma.rkyv", combined_sigma_bytes.as_ref()),
            ("sigma_preprocess.rkyv", sigma_preprocess_bytes.as_ref()),
            ("sigma_verify.json", &sigma_verify_bytes),
        ],
        |path, contents| fs::write(path, contents),
    )?;

    Ok(FinalCrsDigests {
        combined_sigma_sha256: sha256_hex(combined_sigma_bytes.as_ref()),
        sigma_preprocess_sha256: sha256_hex(sigma_preprocess_bytes.as_ref()),
        sigma_verify_sha256: sha256_hex(&sigma_verify_bytes),
    })
}

fn write_final_crs_artifact_files<F>(
    output_dir: &Path,
    artifacts: &[(&str, &[u8])],
    mut write_file: F,
) -> io::Result<()>
where
    F: FnMut(&Path, &[u8]) -> io::Result<()>,
{
    for (file_name, contents) in artifacts {
        write_file(&output_dir.join(file_name), contents)?;
    }
    Ok(())
}

/// A complete but inactive MPC CRS generation.
///
/// The finalization flow writes and validates every public CRS file here before
/// replacing the caller's active output path. Dropping an inactive stage removes
/// only its private staging directory.
pub struct StagedFinalCrs {
    active_output: PathBuf,
    generations_directory: PathBuf,
    staging_directory: Option<PathBuf>,
}

impl StagedFinalCrs {
    pub fn staging_directory(&self) -> io::Result<&Path> {
        self.staging_directory
            .as_deref()
            .ok_or_else(|| io::Error::other("CRS staging directory is no longer available"))
    }

    pub fn write_provenance(&self, provenance: &[u8]) -> io::Result<()> {
        fs::write(
            self.staging_directory()?.join("crs_provenance.json"),
            provenance,
        )
    }

    pub fn verify_artifact_digests(&self, expected: &FinalCrsDigests) -> io::Result<()> {
        verify_final_crs_artifact_digests(self.staging_directory()?, expected)
    }

    /// Atomically make this complete generation available at the configured
    /// output path. The former active generation is deleted immediately after
    /// activation succeeds.
    pub fn activate(mut self) -> io::Result<()> {
        let staging_directory = self.staging_directory()?.to_path_buf();
        activate_staged_final_crs_directory(
            &self.active_output,
            &self.generations_directory,
            &staging_directory,
        )?;
        self.staging_directory = None;
        Ok(())
    }
}

impl Drop for StagedFinalCrs {
    fn drop(&mut self) {
        if let Some(staging_directory) = &self.staging_directory {
            let _ = fs::remove_dir_all(staging_directory);
        }
    }
}

/// Create an inactive generation containing all three final Sigma artifacts.
/// The caller must write and validate `crs_provenance.json` before activation.
pub fn stage_final_crs_artifacts(
    active_output: &Path,
    sigma: &Sigma,
) -> io::Result<(StagedFinalCrs, FinalCrsDigests)> {
    let output_parent = active_output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let generations_directory = output_parent.join("generations");
    let staging_directory = create_staging_directory(&generations_directory)?;
    let stage = StagedFinalCrs {
        active_output: active_output.to_path_buf(),
        generations_directory,
        staging_directory: Some(staging_directory),
    };
    let digests = write_final_crs_artifacts(stage.staging_directory()?, sigma)?;
    Ok((stage, digests))
}

fn create_staging_directory(generations_directory: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(generations_directory)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let process_id = process::id();
    for attempt in 0..32 {
        let staging_directory =
            generations_directory.join(format!(".staging-{timestamp}-{process_id}-{attempt}"));
        match fs::create_dir(&staging_directory) {
            Ok(()) => return Ok(staging_directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique CRS staging directory",
    ))
}

fn activate_staged_final_crs_directory(
    active_output: &Path,
    generations_directory: &Path,
    staging_directory: &Path,
) -> io::Result<()> {
    activate_staged_final_crs_directory_with_remove(
        active_output,
        generations_directory,
        staging_directory,
        |path| fs::remove_dir_all(path),
    )
}

fn activate_staged_final_crs_directory_with_remove<F>(
    active_output: &Path,
    generations_directory: &Path,
    staging_directory: &Path,
    mut remove_directory: F,
) -> io::Result<()>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    let generation_directory = generation_directory_for(staging_directory)?;
    fs::rename(staging_directory, &generation_directory)?;

    let previous_generation =
        match activate_generation(active_output, generations_directory, &generation_directory) {
            Ok(previous_generation) => previous_generation,
            Err(error) => {
                let _ = fs::remove_dir_all(&generation_directory);
                return Err(error);
            }
        };

    if let Some(previous_generation) = previous_generation {
        remove_directory(&previous_generation)?;
    }
    Ok(())
}

fn generation_directory_for(staging_directory: &Path) -> io::Result<PathBuf> {
    let staging_name = staging_directory.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CRS staging directory has no file name",
        )
    })?;
    let staging_name = staging_name.to_string_lossy();
    let generation_name = staging_name.strip_prefix(".staging-").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CRS staging directory does not use the expected name",
        )
    })?;
    let parent = staging_directory.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CRS staging directory has no parent",
        )
    })?;
    Ok(parent.join(format!("generation-{generation_name}")))
}

fn activate_generation(
    active_output: &Path,
    generations_directory: &Path,
    next_generation: &Path,
) -> io::Result<Option<PathBuf>> {
    let output_state = inspect_active_output(active_output, generations_directory)?;
    let temporary_link = temporary_link_path(active_output, next_generation)?;
    create_directory_symlink(
        next_generation
            .strip_prefix(
                active_output
                    .parent()
                    .filter(|path| !path.as_os_str().is_empty())
                    .unwrap_or_else(|| Path::new(".")),
            )
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "CRS generation is not located below the active output parent",
                )
            })?,
        &temporary_link,
    )?;

    let migrated_legacy_directory = if output_state == ActiveOutput::Directory {
        let legacy_directory = generations_directory.join(format!(
            "legacy-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_nanos(),
            process::id()
        ));
        if let Err(error) = fs::rename(active_output, &legacy_directory) {
            let _ = fs::remove_file(&temporary_link);
            return Err(error);
        }
        Some(legacy_directory)
    } else {
        None
    };

    if let Err(error) = fs::rename(&temporary_link, active_output) {
        let _ = fs::remove_file(&temporary_link);
        if let Some(legacy_directory) = &migrated_legacy_directory {
            let _ = fs::rename(legacy_directory, active_output);
        }
        return Err(error);
    }

    Ok(match output_state {
        ActiveOutput::Missing => None,
        ActiveOutput::Directory => migrated_legacy_directory,
        ActiveOutput::ManagedSymlink(previous_generation) => Some(previous_generation),
    })
}

#[derive(Debug, PartialEq, Eq)]
enum ActiveOutput {
    Missing,
    Directory,
    ManagedSymlink(PathBuf),
}

fn inspect_active_output(
    active_output: &Path,
    generations_directory: &Path,
) -> io::Result<ActiveOutput> {
    match fs::symlink_metadata(active_output) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(ActiveOutput::Directory),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let canonical_generations_directory = fs::canonicalize(generations_directory)?;
            let canonical_target = fs::canonicalize(active_output).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "cannot resolve existing CRS output symlink {}: {error}",
                        active_output.display()
                    ),
                )
            })?;
            if canonical_target.starts_with(&canonical_generations_directory)
                && canonical_target != canonical_generations_directory
                && fs::metadata(&canonical_target)?.is_dir()
            {
                Ok(ActiveOutput::ManagedSymlink(canonical_target))
            } else {
                Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "existing CRS output symlink {} does not target a managed generation",
                        active_output.display()
                    ),
                ))
            }
        }
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "existing CRS output path is neither a directory nor a symbolic link: {}",
                active_output.display()
            ),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(ActiveOutput::Missing),
        Err(error) => Err(error),
    }
}

fn temporary_link_path(active_output: &Path, next_generation: &Path) -> io::Result<PathBuf> {
    let output_name = active_output.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CRS output path has no file name",
        )
    })?;
    let generation_name = next_generation.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "CRS generation path has no file name",
        )
    })?;
    Ok(active_output.with_file_name(format!(
        ".{}.next-{}",
        output_name.to_string_lossy(),
        generation_name.to_string_lossy()
    )))
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn create_directory_symlink(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic CRS activation requires Unix directory symlinks",
    ))
}

/// Verify that final CRS artifacts still match the digests recorded when they
/// were generated.
///
/// This is a publication-boundary integrity primitive. It deliberately does
/// not define CRS compatibility and callers outside an artifact distribution
/// boundary must not use it as an eligibility requirement.
pub fn verify_final_crs_artifact_digests(
    output_dir: &Path,
    expected: &FinalCrsDigests,
) -> io::Result<()> {
    let checks = [
        (
            "combined_sigma.rkyv",
            "combined_sigma_sha256",
            expected.combined_sigma_sha256.as_str(),
        ),
        (
            "sigma_preprocess.rkyv",
            "sigma_preprocess_sha256",
            expected.sigma_preprocess_sha256.as_str(),
        ),
        (
            "sigma_verify.json",
            "sigma_verify_sha256",
            expected.sigma_verify_sha256.as_str(),
        ),
    ];

    for (file_name, digest_field, expected_digest) in checks {
        let artifact_path = output_dir.join(file_name);
        let actual_digest = sha256_file_hex(&artifact_path)?;
        if actual_digest != expected_digest {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "{file_name} SHA-256 does not match crs_provenance.json {digest_field}: expected={expected_digest} actual={actual_digest}"
                ),
            ));
        }
    }
    Ok(())
}

fn sha256_file_hex(path: &Path) -> io::Result<String> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..count]);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

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

impl G1SerdeRkyv {
    pub fn from_g1serde(value: &G1serde) -> Self {
        let x_bytes: [u8; 48] = value
            .0
            .x
            .to_bytes_le()
            .try_into()
            .expect("G1 x bytes length");
        let y_bytes: [u8; 48] = value
            .0
            .y
            .to_bytes_le()
            .try_into()
            .expect("G1 y bytes length");
        Self {
            x: x_bytes,
            y: y_bytes,
        }
    }

    pub fn to_g1serde(&self) -> G1serde {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1serde(G1Affine::from_limbs(x_field, y_field))
    }

    pub fn to_g1_affine(&self) -> G1Affine {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1Affine::from_limbs(x_field, y_field)
    }
}

impl G2SerdeRkyv {
    pub fn from_g2serde(value: &G2serde) -> Self {
        let x_bytes: [u8; 96] = value
            .0
            .x
            .to_bytes_le()
            .try_into()
            .expect("G2 x bytes length");
        let y_bytes: [u8; 96] = value
            .0
            .y
            .to_bytes_le()
            .try_into()
            .expect("G2 y bytes length");
        Self {
            x: x_bytes,
            y: y_bytes,
        }
    }

    pub fn to_g2serde(&self) -> G2serde {
        let x_field = G2BaseField::from_bytes_le(&self.x).into();
        let y_field = G2BaseField::from_bytes_le(&self.y).into();
        G2serde(G2Affine::from_limbs(x_field, y_field))
    }
}

impl SigmaRkyv {
    pub fn from_sigma(sigma: &Sigma) -> Self {
        Self {
            G: G1SerdeRkyv::from_g1serde(&sigma.G),
            H: G2SerdeRkyv::from_g2serde(&sigma.H),
            sigma_1: Sigma1Rkyv::from_sigma(&sigma.sigma_1),
            sigma_2: Sigma2Rkyv::from_sigma(&sigma.sigma_2),
            lagrange_KL: G1SerdeRkyv::from_g1serde(&sigma.lagrange_KL),
        }
    }
}

impl SigmaVerifyRkyv {
    pub fn from_sigma(sigma: &Sigma) -> Self {
        Self {
            G: G1SerdeRkyv::from_g1serde(&sigma.G),
            H: G2SerdeRkyv::from_g2serde(&sigma.H),
            sigma_1: PartialSigma1VerifyRkyv {
                x: G1SerdeRkyv::from_g1serde(&sigma.sigma_1.x),
                y: G1SerdeRkyv::from_g1serde(&sigma.sigma_1.y),
            },
            sigma_2: Sigma2Rkyv::from_sigma(&sigma.sigma_2),
            lagrange_KL: G1SerdeRkyv::from_g1serde(&sigma.lagrange_KL),
        }
    }
}

impl SigmaPreprocessRkyv {
    pub fn from_sigma(sigma: &Sigma) -> Self {
        Self {
            sigma_1: PartialSigma1Rkyv::from_sigma(&sigma.sigma_1),
        }
    }
}

impl Sigma1Rkyv {
    fn from_sigma(sigma: &crate::group_structures::Sigma1) -> Self {
        let xy_powers = sigma
            .xy_powers
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let gamma_inv_o_inst = sigma
            .gamma_inv_o_inst
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let eta_inv_li_o_inter_alpha4_kj = sigma
            .eta_inv_li_o_inter_alpha4_kj
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();
        let delta_inv_li_o_prv = sigma
            .delta_inv_li_o_prv
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();
        let delta_inv_alphak_xh_tx = sigma
            .delta_inv_alphak_xh_tx
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();
        let delta_inv_alpha4_xj_tx = sigma
            .delta_inv_alpha4_xj_tx
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let delta_inv_alphak_yi_ty = sigma
            .delta_inv_alphak_yi_ty
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();

        Self {
            xy_powers,
            x: G1SerdeRkyv::from_g1serde(&sigma.x),
            y: G1SerdeRkyv::from_g1serde(&sigma.y),
            delta: G1SerdeRkyv::from_g1serde(&sigma.delta),
            eta: G1SerdeRkyv::from_g1serde(&sigma.eta),
            gamma_inv_o_inst,
            eta_inv_li_o_inter_alpha4_kj,
            delta_inv_li_o_prv,
            delta_inv_alphak_xh_tx,
            delta_inv_alpha4_xj_tx,
            delta_inv_alphak_yi_ty,
        }
    }
}

impl PartialSigma1Rkyv {
    fn from_sigma(sigma: &crate::group_structures::Sigma1) -> Self {
        let xy_powers = sigma
            .xy_powers
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let gamma_inv_o_inst = sigma
            .gamma_inv_o_inst
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        Self {
            xy_powers,
            gamma_inv_o_inst,
        }
    }
}

impl Sigma2Rkyv {
    fn from_sigma(sigma: &crate::group_structures::Sigma2) -> Self {
        Self {
            alpha: G2SerdeRkyv::from_g2serde(&sigma.alpha),
            alpha2: G2SerdeRkyv::from_g2serde(&sigma.alpha2),
            alpha3: G2SerdeRkyv::from_g2serde(&sigma.alpha3),
            alpha4: G2SerdeRkyv::from_g2serde(&sigma.alpha4),
            gamma: G2SerdeRkyv::from_g2serde(&sigma.gamma),
            delta: G2SerdeRkyv::from_g2serde(&sigma.delta),
            eta: G2SerdeRkyv::from_g2serde(&sigma.eta),
            x: G2SerdeRkyv::from_g2serde(&sigma.x),
            y: G2SerdeRkyv::from_g2serde(&sigma.y),
        }
    }
}

impl ArchivedG1SerdeRkyv {
    pub fn to_g1serde(&self) -> G1serde {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1serde(G1Affine::from_limbs(x_field, y_field))
    }

    pub fn to_g1_affine(&self) -> G1Affine {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1Affine::from_limbs(x_field, y_field)
    }
}

impl ArchivedG2SerdeRkyv {
    pub fn to_g2serde(&self) -> G2serde {
        let x_field = G2BaseField::from_bytes_le(&self.x).into();
        let y_field = G2BaseField::from_bytes_le(&self.y).into();
        G2serde(G2Affine::from_limbs(x_field, y_field))
    }
}

impl ArchivedSigma2Rkyv {
    pub fn to_sigma2(&self) -> Sigma2 {
        Sigma2 {
            alpha: self.alpha.to_g2serde(),
            alpha2: self.alpha2.to_g2serde(),
            alpha3: self.alpha3.to_g2serde(),
            alpha4: self.alpha4.to_g2serde(),
            gamma: self.gamma.to_g2serde(),
            delta: self.delta.to_g2serde(),
            eta: self.eta.to_g2serde(),
            x: self.x.to_g2serde(),
            y: self.y.to_g2serde(),
        }
    }
}

impl ArchivedSigmaVerifyRkyv {
    pub fn g(&self) -> G1serde {
        self.G.to_g1serde()
    }

    pub fn h(&self) -> G2serde {
        self.H.to_g2serde()
    }

    pub fn sigma1_x(&self) -> G1serde {
        self.sigma_1.x.to_g1serde()
    }

    pub fn sigma1_y(&self) -> G1serde {
        self.sigma_1.y.to_g1serde()
    }

    pub fn sigma2(&self) -> Sigma2 {
        self.sigma_2.to_sigma2()
    }

    pub fn lagrange_kl(&self) -> G1serde {
        self.lagrange_KL.to_g1serde()
    }
}

fn encode_poly_from_xy_powers(
    poly: &mut DensePolynomialExt,
    params: &SetupParams,
    xy_powers: &[ArchivedG1SerdeRkyv],
) -> G1serde {
    encode_poly_from_xy_powers_with_timing(poly, params, xy_powers, None, None)
}

fn encode_poly_from_xy_powers_with_timing(
    poly: &mut DensePolynomialExt,
    params: &SetupParams,
    xy_powers: &[ArchivedG1SerdeRkyv],
    decoded_xy_powers: Option<&[G1Affine]>,
    _timing_name: Option<&'static str>,
) -> G1serde {
    poly.optimize_size();
    let x_size = poly.x_size;
    let y_size = poly.y_size;
    let rs_x_size = std::cmp::max(2 * params.n, 2 * (params.l_D - params.l));
    let rs_y_size = params.s_max * 2;
    let target_x_size = (poly.x_degree + 1) as usize;
    let target_y_size = (poly.y_degree + 1) as usize;
    if target_x_size > rs_x_size || target_y_size > rs_y_size {
        panic!("Insufficient length of sigma.sigma_1.xy_powers");
    }
    if let Some(decoded) = decoded_xy_powers {
        if decoded.len() != xy_powers.len() {
            panic!("Decoded CRS grid length does not match archived xy_powers");
        }
    }
    if target_x_size * target_y_size == 0 {
        return G1serde::zero();
    }

    let poly_coeffs_vec_compact = {
        let mut poly_coeffs_vec = vec![ScalarField::zero(); x_size * y_size];
        let poly_coeffs = HostSlice::from_mut_slice(&mut poly_coeffs_vec);
        poly.copy_coeffs(0, poly_coeffs);
        resize(
            &poly_coeffs_vec,
            x_size,
            y_size,
            target_x_size,
            target_y_size,
            ScalarField::zero(),
        )
    };

    #[cfg(feature = "timing")]
    let crs_prepare_start = Instant::now();
    let rs_unpacked: Vec<G1Affine> = {
        let mut res = Vec::with_capacity(target_x_size * target_y_size);
        for i in 0..target_x_size {
            for j in 0..target_y_size {
                if i < rs_x_size && j < rs_y_size {
                    let idx = rs_y_size * i + j;
                    res.push(match decoded_xy_powers {
                        Some(decoded) => decoded[idx],
                        None => xy_powers[idx].to_g1_affine(),
                    });
                } else {
                    res.push(G1Affine::zero());
                }
            }
        }
        res
    };
    #[cfg(feature = "timing")]
    if let (Some(name), Some(_)) = (_timing_name, decoded_xy_powers) {
        record_timing(
            name,
            "encode_crs_gather",
            crs_prepare_start.elapsed(),
            vec![SizeInfo {
                label: "active",
                dims: vec![target_x_size, target_y_size],
            }],
        );
    }

    let mut msm_res = vec![G1Projective::zero(); 1];
    #[cfg(feature = "timing")]
    let msm_start = Instant::now();
    msm::msm(
        HostSlice::from_slice(&poly_coeffs_vec_compact),
        HostSlice::from_slice(&rs_unpacked),
        &MSMConfig::default(),
        HostSlice::from_mut_slice(&mut msm_res),
    )
    .unwrap();
    #[cfg(feature = "timing")]
    if let Some(name) = _timing_name {
        record_timing(
            name,
            "encode",
            msm_start.elapsed(),
            vec![SizeInfo {
                label: "msm",
                dims: vec![target_x_size, target_y_size],
            }],
        );
    }
    G1serde(G1Affine::from(msm_res[0]))
}

impl ArchivedSigma1Rkyv {
    pub fn decode_xy_powers(&self) -> Box<[G1Affine]> {
        self.xy_powers
            .iter()
            .map(ArchivedG1SerdeRkyv::to_g1_affine)
            .collect()
    }

    pub fn encode_poly(&self, poly: &mut DensePolynomialExt, params: &SetupParams) -> G1serde {
        encode_poly_from_xy_powers(poly, params, self.xy_powers.as_slice())
    }

    pub fn encode_poly_timed(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        timing_name: &'static str,
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            None,
            Some(timing_name),
        )
    }

    pub fn encode_poly_with_decoded_xy_powers(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        decoded_xy_powers: &[G1Affine],
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            Some(decoded_xy_powers),
            None,
        )
    }

    pub fn encode_poly_timed_with_decoded_xy_powers(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        decoded_xy_powers: &[G1Affine],
        timing_name: &'static str,
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            Some(decoded_xy_powers),
            Some(timing_name),
        )
    }

    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        encode_o_pub_fix_common(
            a_pub_function,
            setup_params,
            self.gamma_inv_o_inst.len(),
            |idx| self.gamma_inv_o_inst[idx].to_g1_affine(),
        )
    }

    pub fn encode_O_pub_free(
        &self,
        placement_variables: &[PlacementVariables],
        public_wire_layout: &PublicWireLayout,
    ) -> G1serde {
        encode_o_pub_free_common(placement_variables, public_wire_layout, |global_idx| {
            self.gamma_inv_o_inst[global_idx].to_g1_affine()
        })
    }

    pub fn encode_O_mid_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        let nVar = count_statement_nvar(
            setup_params.l,
            setup_params.l_D,
            placement_variables,
            subcircuit_infos,
        );
        encode_statement_common(
            setup_params.l,
            setup_params.l_D,
            nVar,
            placement_variables,
            subcircuit_infos,
            |global_idx, i| self.eta_inv_li_o_inter_alpha4_kj[global_idx][i].to_g1_affine(),
        )
    }

    pub fn encode_O_prv_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        let nVar = count_statement_nvar(
            setup_params.l_D,
            setup_params.m_D,
            placement_variables,
            subcircuit_infos,
        );
        encode_statement_common(
            setup_params.l_D,
            setup_params.m_D,
            nVar,
            placement_variables,
            subcircuit_infos,
            |global_idx, i| self.delta_inv_li_o_prv[global_idx][i].to_g1_affine(),
        )
    }

    pub fn delta(&self) -> G1serde {
        self.delta.to_g1serde()
    }

    pub fn eta(&self) -> G1serde {
        self.eta.to_g1serde()
    }

    pub fn delta_inv_alphak_xh_tx(&self, k: usize, h: usize) -> G1serde {
        self.delta_inv_alphak_xh_tx[k][h].to_g1serde()
    }

    pub fn delta_inv_alpha4_xj_tx(&self, j: usize) -> G1serde {
        self.delta_inv_alpha4_xj_tx[j].to_g1serde()
    }

    pub fn delta_inv_alphak_yi_ty(&self, k: usize, i: usize) -> G1serde {
        self.delta_inv_alphak_yi_ty[k][i].to_g1serde()
    }
}

impl ArchivedPartialSigma1Rkyv {
    pub fn encode_poly(&self, poly: &mut DensePolynomialExt, params: &SetupParams) -> G1serde {
        encode_poly_from_xy_powers(poly, params, self.xy_powers.as_slice())
    }

    pub fn encode_poly_timed(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        timing_name: &'static str,
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            None,
            Some(timing_name),
        )
    }

    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        encode_o_pub_fix_common(
            a_pub_function,
            setup_params,
            self.gamma_inv_o_inst.len(),
            |idx| self.gamma_inv_o_inst[idx].to_g1_affine(),
        )
    }
}

#[cfg(test)]
mod decoded_xy_powers_tests {
    use super::*;
    use crate::utils::check_device;
    use icicle_bls12_381::curve::{CurveCfg, ScalarCfg};
    use icicle_core::curve::Curve;
    use icicle_core::traits::GenerateRandom;

    #[test]
    fn cached_xy_powers_match_archived_commitments() {
        check_device();
        let params = SetupParams {
            l_free: 1,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 8,
            n: 4,
            s_D: 4,
            s_max: 4,
        };
        let points = CurveCfg::generate_random_affine_points(8 * 8);
        let archive_source = PartialSigma1Rkyv {
            xy_powers: points
                .iter()
                .map(|point| G1SerdeRkyv::from_g1serde(&G1serde(*point)))
                .collect(),
            gamma_inv_o_inst: Vec::new(),
        };
        let archive_bytes = rkyv::to_bytes::<_, 256>(&archive_source).unwrap();
        let archived = rkyv::check_archived_root::<PartialSigma1Rkyv>(&archive_bytes).unwrap();
        let decoded_xy_powers: Box<[G1Affine]> = archived
            .xy_powers
            .iter()
            .map(ArchivedG1SerdeRkyv::to_g1_affine)
            .collect();

        let mut sparse_coefficients = vec![ScalarField::zero(); 8 * 8];
        sparse_coefficients[0] = ScalarField::one();
        sparse_coefficients[2] = ScalarField::from_u32(3);
        sparse_coefficients[2 * 8 + 4] = ScalarField::from_u32(7);
        let polynomials = vec![
            DensePolynomialExt::zero(),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&[ScalarField::from_u32(11)]),
                1,
                1,
            ),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&ScalarCfg::generate_random(8)),
                8,
                1,
            ),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&ScalarCfg::generate_random(8)),
                1,
                8,
            ),
            DensePolynomialExt::from_coeffs(HostSlice::from_slice(&sparse_coefficients), 8, 8),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&ScalarCfg::generate_random(8 * 8)),
                8,
                8,
            ),
        ];

        for polynomial in polynomials {
            let mut archived_polynomial = polynomial.clone();
            let archived_commitment = encode_poly_from_xy_powers_with_timing(
                &mut archived_polynomial,
                &params,
                archived.xy_powers.as_slice(),
                None,
                None,
            );
            let mut cached_polynomial = polynomial;
            let cached_commitment = encode_poly_from_xy_powers_with_timing(
                &mut cached_polynomial,
                &params,
                archived.xy_powers.as_slice(),
                Some(&decoded_xy_powers),
                None,
            );

            assert_eq!(cached_commitment, archived_commitment);
            assert_eq!(cached_polynomial.x_size, archived_polynomial.x_size);
            assert_eq!(cached_polynomial.y_size, archived_polynomial.y_size);
            assert_eq!(cached_polynomial.x_degree, archived_polynomial.x_degree);
            assert_eq!(cached_polynomial.y_degree, archived_polynomial.y_degree);
        }
    }
}

#[cfg(test)]
mod final_crs_generation_tests {
    use super::{
        activate_staged_final_crs_directory_with_remove, create_staging_directory,
        write_final_crs_artifact_files, StagedFinalCrs,
    };
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("tokamak-crs-{name}-{nonce}-{}", process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn staged_generation(root: &Path, output: &Path) -> StagedFinalCrs {
        let generations_directory = root.join("generations");
        let staging_directory = create_staging_directory(&generations_directory).unwrap();
        fs::write(staging_directory.join("complete"), b"new CRS").unwrap();
        StagedFinalCrs {
            active_output: output.to_path_buf(),
            generations_directory,
            staging_directory: Some(staging_directory),
        }
    }

    #[test]
    fn artifact_write_failure_stops_at_the_failing_file() {
        let artifacts = [
            ("combined_sigma.rkyv", b"combined".as_slice()),
            ("sigma_preprocess.rkyv", b"preprocess".as_slice()),
            ("sigma_verify.json", b"verify".as_slice()),
        ];

        for (failing_index, (failing_name, _)) in artifacts.iter().enumerate() {
            let root = test_directory(&format!("artifact-write-{failing_index}"));
            let output = root.join("staging");
            fs::create_dir_all(&output).unwrap();
            let error = write_final_crs_artifact_files(&output, &artifacts, |path, bytes| {
                if path.file_name().unwrap() == *failing_name {
                    return Err(io::Error::new(
                        io::ErrorKind::Other,
                        "injected write failure",
                    ));
                }
                fs::write(path, bytes)
            })
            .unwrap_err();

            assert_eq!(error.kind(), io::ErrorKind::Other);
            for (index, (file_name, _)) in artifacts.iter().enumerate() {
                assert_eq!(output.join(file_name).exists(), index < failing_index);
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn provenance_write_failure_preserves_the_active_output() {
        let root = test_directory("provenance-write");
        let output = root.join("output");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("complete"), b"old CRS").unwrap();
        let stage = staged_generation(&root, &output);
        fs::remove_dir_all(stage.staging_directory().unwrap()).unwrap();

        assert!(stage.write_provenance(b"{}").is_err());
        assert_eq!(fs::read(output.join("complete")).unwrap(), b"old CRS");
        drop(stage);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn activation_migrates_legacy_output_and_immediately_deletes_prior_generation() {
        let root = test_directory("activation");
        let output = root.join("output");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("complete"), b"legacy CRS").unwrap();

        staged_generation(&root, &output).activate().unwrap();
        assert!(fs::symlink_metadata(&output)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(output.join("complete")).unwrap(), b"new CRS");
        let first_generation = fs::canonicalize(&output).unwrap();
        assert!(!root.join("generations").join("legacy").exists());

        staged_generation(&root, &output).activate().unwrap();
        assert_eq!(fs::read(output.join("complete")).unwrap(), b"new CRS");
        assert!(!first_generation.exists());
        let entries = fs::read_dir(root.join("generations")).unwrap().count();
        assert_eq!(entries, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_prior_generation_deletion_keeps_the_new_generation_active() {
        let root = test_directory("prior-delete");
        let output = root.join("output");
        staged_generation(&root, &output).activate().unwrap();
        let prior_generation = fs::canonicalize(&output).unwrap();

        let stage = staged_generation(&root, &output);
        let staging_directory = stage.staging_directory().unwrap().to_path_buf();
        let error = activate_staged_final_crs_directory_with_remove(
            &output,
            &root.join("generations"),
            &staging_directory,
            |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected deletion failure",
                ))
            },
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(output.join("complete")).unwrap(), b"new CRS");
        assert!(prior_generation.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn activation_rejects_an_unmanaged_active_symlink_without_replacing_it() {
        let root = test_directory("unmanaged-symlink");
        let output = root.join("output");
        let unmanaged = root.join("unmanaged");
        fs::create_dir_all(&unmanaged).unwrap();
        fs::write(unmanaged.join("complete"), b"unmanaged CRS").unwrap();
        std::os::unix::fs::symlink(&unmanaged, &output).unwrap();

        let stage = staged_generation(&root, &output);
        assert_eq!(
            stage.activate().unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(fs::read(output.join("complete")).unwrap(), b"unmanaged CRS");
        assert_eq!(fs::read_dir(root.join("generations")).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
