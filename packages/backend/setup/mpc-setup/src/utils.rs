use crate::conversions::{
    deserialize_g1serde, deserialize_g2serde, serialize_g1serde, serialize_g2serde,
};
pub(crate) use crate::conversions::{
    hash_to_g2, icicle_g1_generator, icicle_g2_generator, serialize_g1_affine,
};
use crate::sigma::{SigmaV2, HASH_BYTES_LEN};
#[cfg(test)]
use ark_ff::One;
use ark_ff::Zero;
use ark_serialize::Compress;
use blake2::{Blake2b, Digest};
use blake3::Hasher;
use clap::ValueEnum;
use icicle_bls12_381::curve::{ScalarCfg, ScalarField};
use icicle_core::traits::{Arithmetic, FieldImpl, GenerateRandom};
#[cfg(test)]
use libs::field_structures::Tau;
use libs::group_structures::{pairing, G1serde, G2serde};
#[cfg(test)]
use libs::group_structures::{Sigma, Sigma1, Sigma2};
use rayon::prelude::*;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::from_reader;
use serde_json::to_writer_pretty;
use std::env;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::ops::Mul;
use std::time::Instant;
use std::{fs, io};
use thiserror::Error;

pub struct StepTimer {
    label: String,
    total_start: Instant,
    step_start: Instant,
}

impl StepTimer {
    pub fn new(label: impl Into<String>) -> Self {
        let now = Instant::now();
        Self {
            label: label.into(),
            total_start: now,
            step_start: now,
        }
    }

    pub fn log_step(&mut self, step: &str) {
        let elapsed = self.step_start.elapsed().as_secs_f64();
        println!(
            "[{}] {} completed in {:.6} seconds",
            self.label, step, elapsed
        );
        self.step_start = Instant::now();
    }

    pub fn log_total(&self) {
        println!(
            "[{}] total elapsed time: {:.6} seconds",
            self.label,
            self.total_start.elapsed().as_secs_f64()
        );
    }
}

fn inferred_phase2_s_max(sigma: &SigmaV2) -> Option<usize> {
    sigma
        .sigma
        .sigma_1
        .eta_inv_li_o_inter_alpha4_kj
        .first()
        .map(|row| row.len())
        .filter(|len| *len > 0)
        .or_else(|| {
            sigma
                .sigma
                .sigma_1
                .delta_inv_li_o_prv
                .first()
                .map(|row| row.len())
                .filter(|len| *len > 0)
        })
}

pub fn select_cuda_or_cpu() -> Result<bool, libs::errors::DeviceError> {
    Ok(libs::utils::try_check_device()? == "CUDA")
}
#[macro_export]
macro_rules! impl_read_from_json {
    ($t:ty) => {
        impl $t {
            pub fn read_from_json(path: &str) -> io::Result<Self> {
                let abs_path = env::current_dir()?.join(path);
                let file = File::open(abs_path)?;
                let reader = BufReader::new(file);
                let res: Self = from_reader(reader)?;
                Ok(res)
            }
        }
    };
}

#[macro_export]
macro_rules! impl_write_into_json {
    ($t:ty) => {
        impl $t {
            pub fn write_into_json(&self, path: &str) -> io::Result<()> {
                let abs_path = env::current_dir()?.join(path);
                if let Some(parent) = abs_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let file = File::create(&abs_path)?;
                let writer = BufWriter::new(file);
                to_writer_pretty(writer, self)?;
                Ok(())
            }
        }
    };
}

#[derive(Clone, Debug, PartialEq)]
pub struct SerialSerde {
    pub g1: Vec<G1serde>, //[xG1, x^2G1, x^3G1, ..., x^s_maxG1]
    pub g2: G2serde,      //xG2
}
impl SerialSerde {
    pub fn serialize_with_compress(&self, compress: Compress) -> (Vec<String>, String) {
        let g1 = self
            .g1
            .iter()
            .map(|g| serialize_g1serde(g, compress))
            .collect();
        let g2 = serialize_g2serde(&self.g2, compress);
        (g1, g2)
    }

    pub fn deserialize_with_compress(
        g1_vec: Vec<String>,
        g2_str: String,
        compress: Compress,
    ) -> Self {
        SerialSerde {
            g1: g1_vec
                .iter()
                .map(|s| deserialize_g1serde(s, compress))
                .collect(),
            g2: deserialize_g2serde(&g2_str, compress),
        }
    }
}
impl SerialSerde {
    //xr, xr^2, xr^3...xr^n where n is the length of xr vector
    pub(crate) fn mul(&self, xr_powers: &Vec<ScalarField>) -> SerialSerde {
        let g1 = &self.g1;
        let g2 = &self.g2;
        let serde = SerialSerde {
            g1: g1
                .par_iter()
                .zip(xr_powers.par_iter())
                .map(|(g1, xr)| g1.mul(*xr))
                .collect(),
            g2: g2.mul(xr_powers[0]),
        };
        serde
    }
    pub(crate) fn get_g1(&self, index: usize) -> G1serde {
        self.g1[index]
    }
    pub(crate) fn get_g2(&self) -> G2serde {
        self.g2
    }
    pub fn len_g1(&self) -> usize {
        self.g1.len()
    }

    pub fn new(g1: G1serde, g2: G2serde, s_max: usize) -> SerialSerde {
        SerialSerde {
            g1: vec![g1; s_max],
            g2,
        }
    }
}

#[derive(Clone, Debug, Copy, PartialEq)]
pub struct PairSerde {
    pub g1: G1serde, //xG1
    pub g2: G2serde, //xG2
}
impl PairSerde {
    pub fn serialize_with_compress(&self, compress: Compress) -> (String, String) {
        (
            serialize_g1serde(&self.g1, compress),
            serialize_g2serde(&self.g2, compress),
        )
    }

    pub fn deserialize_with_compress(g1: &str, g2: &str, compress: Compress) -> Self {
        PairSerde {
            g1: deserialize_g1serde(g1, compress),
            g2: deserialize_g2serde(g2, compress),
        }
    }
}
impl PairSerde {
    pub(crate) fn mul(&self, p0: ScalarField) -> PairSerde {
        let g1 = &self.g1;
        let g2 = &self.g2;
        let serde = PairSerde {
            g1: g1.mul(p0),
            g2: g2.mul(p0),
        };
        serde
    }
    pub fn new(g1: G1serde, g2: G2serde) -> PairSerde {
        PairSerde { g1, g2 }
    }
}
fn serialize_as_hex<S>(bytes: &[u8; 64], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serializer.serialize_str(&hex::encode(bytes))
}
fn deserialize_hex<'de, D>(deserializer: D) -> Result<[u8; 64], D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    let bytes = hex::decode(s).map_err(serde::de::Error::custom)?;
    let array: [u8; 64] = bytes
        .try_into()
        .map_err(|_| serde::de::Error::custom("Expected a 64-byte hex string"))?;
    Ok(array)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proof2 {
    pub x_r_g1: G1serde, //latest x_r contribution
    pub pok_x: G2serde,
    #[serde(
        serialize_with = "serialize_as_hex",
        deserialize_with = "deserialize_hex"
    )]
    pub v: [u8; 64],
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Phase1Proof {
    pub contributor_index: usize,
    pub proof2_alpha: Proof2,
    pub proof2_x: Proof2,
    pub proof2_y: Proof2,
}
impl Phase1Proof {
    /// Save the Proof5 to a JSON file
    pub fn save_to_json(&self, path: &str) -> std::io::Result<()> {
        let file = File::create(path)?;
        let mut writer = BufWriter::new(file);
        let json_str = serde_json::to_string_pretty(&self).expect("JSON serialization failed");
        writer.write_all(json_str.as_bytes())?;
        Ok(())
    }

    /// Load the Accumulator from a JSON file and recalculate the hash
    pub fn load_from_json(path: &str) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let mut reader = BufReader::new(file);
        let mut json_str = String::new();
        reader.read_to_string(&mut json_str)?;
        let proof: Phase1Proof = serde_json::from_str(&json_str)
            .expect(format!("JSON deserialization failed: path {}", path).as_str());
        Ok(proof)
    }
    pub fn blake2b_hash(&self) -> [u8; 64] {
        // Serialize without the hash field
        let serialized = bincode::serialize(&self).expect("Serialization failed for Accumulator");

        let hash = Blake2b::digest(&serialized);

        let mut result = [0u8; 64];
        result.copy_from_slice(&hash[..64]);
        result
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Phase2Proof {
    pub contributor_index: usize,
    pub v: Vec<u8>,
    pub delta_t_g1: G1serde,
    pub gamma_t_g1: G1serde,
    pub eta_t_g1: G1serde,
    pub pok_delta: G2serde,
    pub pok_gamma: G2serde,
    pub pok_eta: G2serde,
    pub delta_t_g2: G2serde,
    pub gamma_t_g2: G2serde,
    pub eta_t_g2: G2serde,
}
impl_read_from_json!(Phase2Proof);
impl_write_into_json!(Phase2Proof);

#[derive(Debug, Error, PartialEq, Eq)]
pub enum Phase2VerificationError {
    #[error("{accumulator} phase-2 accumulator is missing or has invalid disclosed y: {reason}")]
    InvalidDisclosedY {
        accumulator: &'static str,
        reason: String,
    },
    #[error("{accumulator} phase-2 accumulator does not expose a valid s_max shape")]
    MissingShape { accumulator: &'static str },
    #[error(
        "previous and current phase-2 accumulator s_max values differ: {previous} != {current}"
    )]
    SMaxMismatch { previous: usize, current: usize },
    #[error("{accumulator} phase-2 accumulator has invalid disclosed y")]
    InvalidYOrder { accumulator: &'static str },
    #[error("phase-2 accumulator invariant failed: {invariant}")]
    Invariant { invariant: &'static str },
    #[error("phase-2 proof challenge does not match the previous accumulator")]
    ChallengeMismatch,
    #[error("phase-2 proof-of-knowledge check failed for {component}")]
    ProofOfKnowledge { component: &'static str },
    #[error("phase-2 consistency check failed for {component}")]
    Consistency { component: &'static str },
    #[error("phase-2 {component} length differs between accumulators: {previous} != {current}")]
    LengthMismatch {
        component: &'static str,
        previous: usize,
        current: usize,
    },
    #[error("phase-2 {component} row count differs between accumulators: {previous} != {current}")]
    RowCountMismatch {
        component: &'static str,
        previous: usize,
        current: usize,
    },
    #[error("phase-2 {component} row {row} length differs between accumulators: {previous} != {current}")]
    RowLengthMismatch {
        component: &'static str,
        row: usize,
        previous: usize,
        current: usize,
    },
}

impl Phase2Proof {
    pub fn blake2b_hash(&self) -> [u8; HASH_BYTES_LEN] {
        // Serialize without the hash field
        let serialized = bincode::serialize(&self).expect("Serialization failed for Accumulator");

        let hash = Blake2b::digest(&serialized);

        let mut result = [0u8; HASH_BYTES_LEN];
        result.copy_from_slice(&hash[..HASH_BYTES_LEN]);
        result
    }
    pub fn verify(
        &self,
        sigma_old: &SigmaV2,
        sigma_cur: &SigmaV2,
    ) -> Result<(), Phase2VerificationError> {
        let old_y = phase2_y(sigma_old, "previous")?;
        let cur_y = phase2_y(sigma_cur, "current")?;
        let old_s = phase2_s_max(sigma_old, "previous")?;
        let cur_s = phase2_s_max(sigma_cur, "current")?;
        if old_s != cur_s {
            return Err(Phase2VerificationError::SMaxMismatch {
                previous: old_s,
                current: cur_s,
            });
        }
        if old_y.pow(old_s) == ScalarField::one() {
            return Err(Phase2VerificationError::InvalidYOrder {
                accumulator: "previous",
            });
        }
        if cur_y.pow(cur_s) == ScalarField::one() {
            return Err(Phase2VerificationError::InvalidYOrder {
                accumulator: "current",
            });
        }
        require_equal(old_y, cur_y, "disclosed y differs between accumulators")?;
        require_equal(
            &sigma_old.public_y_hex,
            &sigma_cur.public_y_hex,
            "public y encoding differs between accumulators",
        )?;
        require_equal(
            sigma_old.sigma.sigma_1.y,
            sigma_old.sigma.G * old_y,
            "previous G1 y commitment does not match disclosed y",
        )?;
        require_equal(
            sigma_cur.sigma.sigma_1.y,
            sigma_cur.sigma.G * cur_y,
            "current G1 y commitment does not match disclosed y",
        )?;
        require_equal(
            sigma_old.sigma.sigma_2.y,
            sigma_old.sigma.H * old_y,
            "previous G2 y commitment does not match disclosed y",
        )?;
        require_equal(
            sigma_cur.sigma.sigma_2.y,
            sigma_cur.sigma.H * cur_y,
            "current G2 y commitment does not match disclosed y",
        )?;

        let v = hash_sigma(sigma_old);
        if self.v.as_slice() != v.as_slice() {
            return Err(Phase2VerificationError::ChallengeMismatch);
        }
        require_equal(
            sigma_old.sigma.G,
            sigma_cur.sigma.G,
            "G differs between accumulators",
        )?;
        require_equal(
            sigma_old.sigma.H,
            sigma_cur.sigma.H,
            "H differs between accumulators",
        )?;
        validate_phase2_structure(sigma_old, sigma_cur)?;

        require_pok(
            check_pok(&self.delta_t_g1, &sigma_cur.sigma.G, self.pok_delta, &v),
            "delta",
        )?;
        require_pok(
            check_pok(&self.gamma_t_g1, &sigma_cur.sigma.G, self.pok_gamma, &v),
            "gamma",
        )?;
        require_pok(
            check_pok(&self.eta_t_g1, &sigma_cur.sigma.G, self.pok_eta, &v),
            "eta",
        )?;

        let ro_t_gamma = ro(&self.gamma_t_g1, &v);
        let ro_t_eta = ro(&self.eta_t_g1, &v);
        let ro_t_delta = ro(&self.delta_t_g1, &v);

        require_consistent(
            consistent(
                &[sigma_old.gamma, sigma_cur.gamma],
                &[],
                &[ro_t_gamma, self.pok_gamma],
            ),
            "gamma proof",
        )?;
        require_consistent(
            consistent(
                &[sigma_old.sigma.sigma_1.eta, sigma_cur.sigma.sigma_1.eta],
                &[],
                &[ro_t_eta, self.pok_eta],
            ),
            "eta proof",
        )?;
        require_consistent(
            consistent(
                &[sigma_old.sigma.sigma_1.delta, sigma_cur.sigma.sigma_1.delta],
                &[],
                &[ro_t_delta, self.pok_delta],
            ),
            "delta proof",
        )?;
        require_consistent(
            consistent(
                &[sigma_old.gamma, sigma_cur.gamma],
                &[],
                &[sigma_old.sigma.sigma_2.gamma, sigma_cur.sigma.sigma_2.gamma],
            ),
            "gamma G2 commitment",
        )?;
        require_consistent(
            consistent(
                &[sigma_old.sigma.sigma_1.eta, sigma_cur.sigma.sigma_1.eta],
                &[],
                &[sigma_old.sigma.sigma_2.eta, sigma_cur.sigma.sigma_2.eta],
            ),
            "eta G2 commitment",
        )?;
        require_consistent(
            consistent(
                &[sigma_old.sigma.sigma_1.delta, sigma_cur.sigma.sigma_1.delta],
                &[],
                &[sigma_old.sigma.sigma_2.delta, sigma_cur.sigma.sigma_2.delta],
            ),
            "delta G2 commitment",
        )?;

        verify_scaled_slice(
            "gamma_inv_o_inst",
            &sigma_old.sigma.sigma_1.gamma_inv_o_inst,
            &sigma_cur.sigma.sigma_1.gamma_inv_o_inst,
            sigma_cur.sigma.H,
            self.gamma_t_g2,
        )?;
        verify_scaled_slice(
            "delta_inv_alpha4_xj_tx",
            &sigma_old.sigma.sigma_1.delta_inv_alpha4_xj_tx,
            &sigma_cur.sigma.sigma_1.delta_inv_alpha4_xj_tx,
            sigma_cur.sigma.H,
            self.delta_t_g2,
        )?;
        verify_scaled_matrix(
            "delta_inv_alphak_xh_tx",
            &sigma_old.sigma.sigma_1.delta_inv_alphak_xh_tx,
            &sigma_cur.sigma.sigma_1.delta_inv_alphak_xh_tx,
            sigma_cur.sigma.H,
            self.delta_t_g2,
        )?;
        verify_scaled_matrix(
            "delta_inv_alphak_yi_ty",
            &sigma_old.sigma.sigma_1.delta_inv_alphak_yi_ty,
            &sigma_cur.sigma.sigma_1.delta_inv_alphak_yi_ty,
            sigma_cur.sigma.H,
            self.delta_t_g2,
        )?;
        verify_scaled_matrix(
            "eta_inv_li_o_inter_alpha4_kj",
            &sigma_old.sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj,
            &sigma_cur.sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj,
            sigma_cur.sigma.H,
            self.eta_t_g2,
        )?;
        verify_scaled_matrix(
            "delta_inv_li_o_prv",
            &sigma_old.sigma.sigma_1.delta_inv_li_o_prv,
            &sigma_cur.sigma.sigma_1.delta_inv_li_o_prv,
            sigma_cur.sigma.H,
            self.delta_t_g2,
        )?;
        Ok(())
    }
}

fn phase2_y(
    sigma: &SigmaV2,
    accumulator: &'static str,
) -> Result<ScalarField, Phase2VerificationError> {
    sigma
        .public_phase2_y()
        .map_err(|reason| Phase2VerificationError::InvalidDisclosedY {
            accumulator,
            reason,
        })
}

fn phase2_s_max(
    sigma: &SigmaV2,
    accumulator: &'static str,
) -> Result<usize, Phase2VerificationError> {
    inferred_phase2_s_max(sigma).ok_or(Phase2VerificationError::MissingShape { accumulator })
}

fn require_equal<T: PartialEq>(
    previous: T,
    current: T,
    invariant: &'static str,
) -> Result<(), Phase2VerificationError> {
    if previous == current {
        Ok(())
    } else {
        Err(Phase2VerificationError::Invariant { invariant })
    }
}

fn require_pok(valid: bool, component: &'static str) -> Result<(), Phase2VerificationError> {
    if valid {
        Ok(())
    } else {
        Err(Phase2VerificationError::ProofOfKnowledge { component })
    }
}

fn require_consistent(valid: bool, component: &'static str) -> Result<(), Phase2VerificationError> {
    if valid {
        Ok(())
    } else {
        Err(Phase2VerificationError::Consistency { component })
    }
}

fn validate_phase2_structure(
    previous: &SigmaV2,
    current: &SigmaV2,
) -> Result<(), Phase2VerificationError> {
    validate_scaled_slice_shape(
        "gamma_inv_o_inst",
        &previous.sigma.sigma_1.gamma_inv_o_inst,
        &current.sigma.sigma_1.gamma_inv_o_inst,
    )?;
    validate_scaled_slice_shape(
        "delta_inv_alpha4_xj_tx",
        &previous.sigma.sigma_1.delta_inv_alpha4_xj_tx,
        &current.sigma.sigma_1.delta_inv_alpha4_xj_tx,
    )?;
    validate_scaled_matrix_shape(
        "delta_inv_alphak_xh_tx",
        &previous.sigma.sigma_1.delta_inv_alphak_xh_tx,
        &current.sigma.sigma_1.delta_inv_alphak_xh_tx,
    )?;
    validate_scaled_matrix_shape(
        "delta_inv_alphak_yi_ty",
        &previous.sigma.sigma_1.delta_inv_alphak_yi_ty,
        &current.sigma.sigma_1.delta_inv_alphak_yi_ty,
    )?;
    validate_scaled_matrix_shape(
        "eta_inv_li_o_inter_alpha4_kj",
        &previous.sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj,
        &current.sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj,
    )?;
    validate_scaled_matrix_shape(
        "delta_inv_li_o_prv",
        &previous.sigma.sigma_1.delta_inv_li_o_prv,
        &current.sigma.sigma_1.delta_inv_li_o_prv,
    )
}

fn validate_scaled_slice_shape(
    component: &'static str,
    previous: &[G1serde],
    current: &[G1serde],
) -> Result<(), Phase2VerificationError> {
    if previous.len() == current.len() {
        Ok(())
    } else {
        Err(Phase2VerificationError::LengthMismatch {
            component,
            previous: previous.len(),
            current: current.len(),
        })
    }
}

fn validate_scaled_matrix_shape(
    component: &'static str,
    previous: &[Box<[G1serde]>],
    current: &[Box<[G1serde]>],
) -> Result<(), Phase2VerificationError> {
    if previous.len() != current.len() {
        return Err(Phase2VerificationError::RowCountMismatch {
            component,
            previous: previous.len(),
            current: current.len(),
        });
    }
    for (row, (previous, current)) in previous.iter().zip(current.iter()).enumerate() {
        if previous.len() != current.len() {
            return Err(Phase2VerificationError::RowLengthMismatch {
                component,
                row,
                previous: previous.len(),
                current: current.len(),
            });
        }
    }
    Ok(())
}

fn verify_scaled_slice(
    component: &'static str,
    previous: &[G1serde],
    current: &[G1serde],
    h: G2serde,
    contribution: G2serde,
) -> Result<(), Phase2VerificationError> {
    validate_scaled_slice_shape(component, previous, current)?;
    require_consistent(
        current
            .par_iter()
            .zip(previous.par_iter())
            .all(|(current, previous)| consistent(&[*current, *previous], &[], &[h, contribution])),
        component,
    )
}

fn verify_scaled_matrix(
    component: &'static str,
    previous: &[Box<[G1serde]>],
    current: &[Box<[G1serde]>],
    h: G2serde,
    contribution: G2serde,
) -> Result<(), Phase2VerificationError> {
    validate_scaled_matrix_shape(component, previous, current)?;
    require_consistent(
        current
            .par_iter()
            .zip(previous.par_iter())
            .all(|(current_row, previous_row)| {
                current_row
                    .iter()
                    .zip(previous_row.iter())
                    .all(|(current, previous)| {
                        consistent(&[*current, *previous], &[], &[h, contribution])
                    })
            }),
        component,
    )
}

//type 2: verify2
pub fn verify2(
    g1: &G1serde,
    g2: &G2serde,
    prev_x: &SerialSerde,
    cur_x: &SerialSerde,
    proof2: &Proof2,
) -> bool {
    if !check_pok(&proof2.x_r_g1, g1, proof2.pok_x, proof2.v.as_ref()) {
        return false;
    }

    let r_alpha = ro(&proof2.x_r_g1, proof2.v.as_ref());

    if !consistent(
        &[prev_x.get_g1(0), cur_x.get_g1(0)],
        &[prev_x.get_g2(), cur_x.get_g2()],
        &[r_alpha, proof2.pok_x],
    ) {
        return false;
    }

    // Parallelize loop consistency checks
    (1..cur_x.len_g1()).into_par_iter().all(|i| {
        consistent(
            &[cur_x.get_g1(i - 1), cur_x.get_g1(i)],
            &[],
            &[*g2, cur_x.get_g2()],
        )
    })
}
pub fn verify2i(
    g1: &G1serde,
    g2: &G2serde,
    prev_x: &Vec<PairSerde>,
    cur_x: &Vec<PairSerde>,
    proof2: &Proof2,
) -> bool {
    if !check_pok(&proof2.x_r_g1, g1, proof2.pok_x, proof2.v.as_ref()) {
        return false;
    }

    let r_alpha = ro(&proof2.x_r_g1, proof2.v.as_ref());

    if !consistent(
        &[prev_x[0].g1, cur_x[0].g1],
        &[prev_x[0].g2, cur_x[0].g2],
        &[r_alpha, proof2.pok_x],
    ) {
        return false;
    }

    // Parallelize the consistency checks across elements
    (1..cur_x.len())
        .into_par_iter()
        .all(|i| consistent(&[cur_x[i - 1].g1, cur_x[i].g1], &[], &[*g2, cur_x[0].g2]))
}

pub fn verify_alpha_x_x_only(
    g2: &G2serde,
    cur_alphax: &[G1serde],
    cur_alpha: &[PairSerde],
    cur_x: &SerialSerde,
) -> bool {
    let len_x = cur_x.len_g1();
    cur_alpha.par_iter().enumerate().all(|(alpha_idx, alpha)| {
        if len_x == 0 {
            return true;
        }
        let row_offset = alpha_idx * len_x;
        if !consistent(
            &[alpha.g1, cur_alphax[row_offset]],
            &[],
            &[*g2, cur_x.get_g2()],
        ) {
            return false;
        }
        (1..len_x).into_par_iter().all(|x_idx| {
            consistent(
                &[
                    cur_alphax[row_offset + x_idx - 1],
                    cur_alphax[row_offset + x_idx],
                ],
                &[],
                &[*g2, cur_x.get_g2()],
            )
        })
    })
}

fn compute2_temp(
    rng: &mut RandomGenerator,
    g1: &G1serde,
    prev_x: &SerialSerde,
    v: &[u8; 64],
) -> (SerialSerde, Proof2, Vec<ScalarField>) {
    let x_r = rng.next_random();
    let pok_x = pok(g1, x_r, v);
    let x_rG1 = g1.mul(x_r);
    let len_x = prev_x.len_g1();

    // Precompute the powers of x_r efficiently
    let x_powers = compute_powers(x_r, len_x);
    let cur_x = prev_x.mul(&x_powers);
    (
        cur_x,
        Proof2 {
            x_r_g1: x_rG1,
            pok_x,
            v: *v,
        },
        x_powers,
    )
}
fn compute2_tempi(
    rng: &mut RandomGenerator,
    g1: &G1serde,
    prev_x: &Vec<PairSerde>,
    v: &[u8; 64],
) -> (Vec<PairSerde>, Proof2, Vec<ScalarField>) {
    let x_r = rng.next_random();
    let pok_x = pok(g1, x_r, v);
    let x_rG1 = g1.mul(x_r);
    let len_x = prev_x.len();

    // Precompute the powers of x_r efficiently
    let x_powers = compute_powers(x_r, len_x);
    let cur_x: Vec<PairSerde> = prev_x
        .par_iter()
        .zip(x_powers.par_iter())
        .map(|(x, scalar)| x.mul(*scalar))
        .collect();

    (
        cur_x,
        Proof2 {
            x_r_g1: x_rG1,
            pok_x,
            v: *v,
        },
        x_powers,
    )
}
/// Represents different strategies for random number generation
#[derive(Debug, Clone)]
pub enum RandomStrategy {
    /// Uses only user-provided input
    UserInput,
    /// Uses only system random generator
    SystemRandom,
    /// Combines both user input and system random
    Hybrid,
    /// Used for testing with deterministic values
    Testing,
}

impl Default for RandomStrategy {
    fn default() -> Self {
        RandomStrategy::SystemRandom
    }
}

pub struct RandomGenerator {
    strategy: RandomStrategy,
    current_seed: [u8; 32],
    pub iteration_count: usize,
}

impl RandomGenerator {
    /// Creates a new random generator with the specified strategy and seed
    ///
    /// # Arguments
    /// * `strategy` - The random generation strategy to use
    /// * `initial_seed` - Initial seed value as 32 bytes
    pub fn new(strategy: RandomStrategy, initial_seed: [u8; 32]) -> Self {
        Self {
            strategy,
            current_seed: initial_seed,
            iteration_count: 0,
        }
    }

    /// Generates the next scalar value based on the current seed
    pub fn next_scalar(&mut self) -> Result<ScalarField, Box<dyn std::error::Error>> {
        let scalar = ScalarField::from_u32(0) + ScalarField::from_bytes_le(&self.current_seed);
        let mut hasher = Hasher::new();
        hasher.update(&self.current_seed);
        let hash = hasher.finalize();
        self.current_seed.copy_from_slice(hash.as_bytes());
        Ok(scalar)
    }

    /// Generates the next random value according to the chosen strategy
    pub fn next_random(&mut self) -> ScalarField {
        let out = match self.strategy {
            RandomStrategy::UserInput => self.next_scalar().unwrap(),
            RandomStrategy::SystemRandom => ScalarCfg::generate_random(1)[0],
            RandomStrategy::Hybrid => {
                let user_component = self.next_scalar().unwrap();
                ScalarCfg::generate_random(1)[0] + user_component
            }
            RandomStrategy::Testing => {
                self.iteration_count += 1;
                ScalarField::from_u32((self.iteration_count * 2 + 1) as u32)
            }
        };
        out
    }
}
pub fn seed_bytes_from_input(input: &str) -> [u8; 32] {
    let mut hasher = Hasher::new();
    hasher.update(input.trim().as_bytes());
    let hash = hasher.finalize();

    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(hash.as_bytes());
    bytes
}

#[derive(Debug, Clone, ValueEnum)]
pub enum Mode {
    Random,
    Beacon, //deterministic from a given seed
}
pub fn initialize_random_generator_with_seed_input(
    mode: &Mode,
    seed_input: Option<&str>,
) -> RandomGenerator {
    let (strategy, message, seed) = if crate::testing_mode_enabled() {
        (
            RandomStrategy::Testing,
            "Initializing random generator in testing mode",
            [0u8; 32],
        )
    } else {
        match mode {
            Mode::Beacon => {
                let input = seed_input.expect("beacon mode requires --seed-input");
                (
                    RandomStrategy::UserInput,
                    "Initializing random generator in deterministic mode",
                    seed_bytes_from_input(input),
                )
            }
            Mode::Random => {
                if let Some(input) = seed_input {
                    (
                        RandomStrategy::Hybrid,
                        "Initializing random generator in hybrid random mode",
                        seed_bytes_from_input(input),
                    )
                } else {
                    (
                        RandomStrategy::SystemRandom,
                        "Initializing random generator in system random mode",
                        [0u8; 32],
                    )
                }
            }
        }
    };

    println!("{}", message);
    RandomGenerator::new(strategy, seed)
}

pub fn hash_sigma(sigma: &SigmaV2) -> [u8; 32] {
    // Serialize without the hash field
    let serialized = bincode::serialize(sigma).expect("Serialization failed for Accumulator");

    // Calculate Blake2b hash (32-byte output)
    let hash = Blake2b::digest(&serialized);

    // Convert GenericArray into [u8; 32]
    let mut result = [0u8; 32];
    result.copy_from_slice(&hash[..32]);
    result
}

#[cfg(test)]
fn phase2_verification_fixture() -> (SigmaV2, Phase2Proof) {
    let g1 = icicle_g1_generator();
    let g2 = icicle_g2_generator();
    let y = ScalarField::from_u32(2);
    let point = g1;
    let row = || vec![point].into_boxed_slice();
    let sigma = SigmaV2 {
        contributor_index: 1,
        sigma: Sigma {
            G: g1,
            H: g2,
            sigma_1: Sigma1 {
                xy_powers: vec![point].into_boxed_slice(),
                x: point,
                y: g1.mul(y),
                delta: point,
                eta: point,
                gamma_inv_o_inst: vec![point].into_boxed_slice(),
                eta_inv_li_o_inter_alpha4_kj: vec![row()].into_boxed_slice(),
                delta_inv_li_o_prv: vec![row()].into_boxed_slice(),
                delta_inv_alphak_xh_tx: vec![row()].into_boxed_slice(),
                delta_inv_alpha4_xj_tx: vec![point].into_boxed_slice(),
                delta_inv_alphak_yi_ty: vec![row()].into_boxed_slice(),
            },
            sigma_2: Sigma2 {
                alpha: g2,
                alpha2: g2,
                alpha3: g2,
                alpha4: g2,
                gamma: g2,
                delta: g2,
                eta: g2,
                x: g2,
                y: g2.mul(y),
            },
            lagrange_KL: point,
        },
        gamma: point,
        public_y_hex: Some("0x02".to_string()),
        phase1_source_provenance: None,
    };
    let challenge = hash_sigma(&sigma);
    let one = ScalarField::from_u32(1);
    let proof = Phase2Proof {
        contributor_index: 2,
        v: challenge.to_vec(),
        delta_t_g1: g1.mul(one),
        gamma_t_g1: g1.mul(one),
        eta_t_g1: g1.mul(one),
        pok_delta: pok(&g1, one, &challenge),
        pok_gamma: pok(&g1, one, &challenge),
        pok_eta: pok(&g1, one, &challenge),
        delta_t_g2: g2.mul(one),
        gamma_t_g2: g2.mul(one),
        eta_t_g2: g2.mul(one),
    };
    (sigma, proof)
}

#[test]
fn phase2_verification_accepts_a_well_formed_contribution() {
    let (sigma, proof) = phase2_verification_fixture();

    assert_eq!(proof.verify(&sigma, &sigma), Ok(()));
}

#[test]
fn phase2_verification_rejects_a_tampered_challenge() {
    let (sigma, mut proof) = phase2_verification_fixture();
    proof.v[0] ^= 1;

    assert_eq!(
        proof.verify(&sigma, &sigma),
        Err(Phase2VerificationError::ChallengeMismatch)
    );
}

#[test]
fn phase2_verification_rejects_shape_mismatch_without_panicking() {
    let (sigma, proof) = phase2_verification_fixture();
    let mut current = sigma.clone();
    current.sigma.sigma_1.gamma_inv_o_inst = Vec::new().into_boxed_slice();

    let result = std::panic::catch_unwind(|| proof.verify(&sigma, &current));
    assert!(result.is_ok());
    assert_eq!(
        result.unwrap(),
        Err(Phase2VerificationError::LengthMismatch {
            component: "gamma_inv_o_inst",
            previous: 1,
            current: 0,
        })
    );
}

#[test]
fn phase2_verification_rejects_missing_disclosed_y_without_panicking() {
    let (mut sigma, proof) = phase2_verification_fixture();
    sigma.public_y_hex = None;

    let result = std::panic::catch_unwind(|| proof.verify(&sigma, &sigma));
    assert!(result.is_ok());
    assert!(matches!(
        result.unwrap(),
        Err(Phase2VerificationError::InvalidDisclosedY {
            accumulator: "previous",
            ..
        })
    ));
}

#[test]
fn test_bilinear_map() {
    //initialize
    let g1 = icicle_g1_generator();
    let g2 = icicle_g2_generator();

    let minusG2 = G2serde::zero() - g2;

    let pairing1 = pairing(&[g1, g1], &[g2, minusG2]);
    assert_eq!(pairing1.0.is_one(), true)
}

pub fn compute_phase1_x_only(
    rng: &mut RandomGenerator,
    g1: &G1serde,
    prev_alphax: &[G1serde],
    prev_alpha: &[PairSerde],
    prev_x: &SerialSerde,
    v: &[u8; 64],
) -> (Vec<G1serde>, Vec<PairSerde>, SerialSerde, Phase1Proof) {
    let prev_alpha_vec = prev_alpha.to_vec();
    let (cur_alpha, proof2_alpha, alpha_powers) = compute2_tempi(rng, g1, &prev_alpha_vec, v);
    let (cur_x, proof2_x, x_powers) = compute2_temp(rng, g1, prev_x, v);

    let alphax_powers = vector_product(&alpha_powers, &x_powers);
    let cur_alphax: Vec<G1serde> = prev_alphax
        .par_iter()
        .zip(alphax_powers.par_iter())
        .map(|(point, scalar)| point.mul(*scalar))
        .collect();

    (
        cur_alphax,
        cur_alpha,
        cur_x,
        Phase1Proof {
            contributor_index: 0,
            proof2_alpha,
            proof2_x: proof2_x.clone(),
            // The x-only phase-1 ceremony no longer updates y, but the field is
            // kept to avoid a file-format fork during the transition.
            proof2_y: proof2_x,
        },
    )
}

pub fn verify_phase1_x_only(
    g1: &G1serde,
    g2: &G2serde,
    prev_alpha: &[PairSerde],
    prev_x: &SerialSerde,
    cur_alphax: &[G1serde],
    cur_alpha: &[PairSerde],
    cur_x: &SerialSerde,
    proof: &Phase1Proof,
) -> bool {
    let prev_alpha_vec = prev_alpha.to_vec();
    let cur_alpha_vec = cur_alpha.to_vec();

    if !verify2i(g1, g2, &prev_alpha_vec, &cur_alpha_vec, &proof.proof2_alpha) {
        return false;
    }
    if !verify2(g1, g2, prev_x, cur_x, &proof.proof2_x) {
        return false;
    }
    verify_alpha_x_x_only(g2, cur_alphax, &cur_alpha_vec, cur_x)
}

//ab_g1 = [A1 B1], ab_g2 = [A2, B2], c = [C1, C2]
pub fn consistent(ab_g1: &[G1serde], ab_g2: &[G2serde], c: &[G2serde]) -> bool {
    let a1 = ab_g1[0];
    let b1 = ab_g1[1];
    let c1 = c[0];
    let c2 = c[1];

    if ab_g2.is_empty() {
        same_ratio(a1, b1, c1, c2)
    } else {
        let a2 = ab_g2[0];
        let b2 = ab_g2[1];
        same_ratio(a1, b1, a2, b2) && same_ratio(a1, b1, c1, c2)
    }
}

pub fn check_pok(a: &G1serde, g1: &G1serde, b: G2serde, v: &[u8]) -> bool {
    let y = ro(&G1serde(a.0), v);
    same_ratio(*g1, *a, y, b)
}

pub fn pok(g1: &G1serde, alpha: ScalarField, v: &[u8]) -> G2serde {
    let alphaG1 = g1.mul(alpha);
    let y = ro(&alphaG1, v);
    y.mul(alpha)
}

pub fn same_ratio(g1_0: G1serde, g1_1: G1serde, g2_0: G2serde, g2_1: G2serde) -> bool {
    let neg_g1_1 = G1serde::zero() - g1_1;
    pairing(&[g1_0, neg_g1_1], &[g2_1, g2_0]).is_zero()
}

pub fn ro(a: &G1serde, v: &[u8]) -> G2serde {
    let mut h = Blake2b::default();
    h.input(v);
    h.input(serialize_g1_affine(&a.0, Compress::No));
    hash_to_g2(h.result().as_ref())
}

fn vector_product(a: &[ScalarField], b: &[ScalarField]) -> Vec<ScalarField> {
    let mut result: Vec<ScalarField> = Vec::with_capacity(a.len() * b.len());
    for &lhs in a {
        for &rhs in b {
            result.push(lhs.mul(rhs));
        }
    }
    result
}
fn compute_powers(x_r: ScalarField, len_x: usize) -> Vec<ScalarField> {
    let mut x_powers: Vec<ScalarField> = Vec::with_capacity(len_x);
    let mut current_power = ScalarField::one();
    for _ in 0..len_x {
        current_power = current_power.mul(x_r);
        x_powers.push(current_power);
    }
    x_powers
}

#[test]
fn test_consistent_case1() {
    let rng = &mut RandomGenerator::new(RandomStrategy::SystemRandom, [0u8; 32]);
    // a1*c2 == b1*c1
    let g1_gen = icicle_g1_generator();
    let g2_gen = icicle_g2_generator();
    let a1 = rng.next_random();
    let b1 = rng.next_random();
    let c1 = rng.next_random();
    let c2 = b1 * c1 * a1.inv();

    let a1G = g1_gen.mul(a1);
    let b1G = g1_gen.mul(b1);

    let c1G = g2_gen.mul(c1);
    let c2G = g2_gen.mul(c2);

    assert_eq!(consistent(&[a1G, b1G], &[], &[c1G, c2G]), true)
}

#[test]
fn test_consistent_case3() {
    let rng = &mut RandomGenerator::new(RandomStrategy::SystemRandom, [0u8; 32]);
    let g1_gen = icicle_g1_generator();
    let g2_gen = icicle_g2_generator();

    let a = rng.next_random();

    let two = ScalarField::one() + ScalarField::one();
    let three = two + ScalarField::one();
    let six = three + three;

    let a1 = a.mul(two); //2a
    let b1 = a.pow(2).mul(six); //6*a^2

    let c1 = a.mul(three); //3a

    let a1G = g1_gen.mul(a1);
    let b1G = g1_gen.mul(b1);

    let c1G = g2_gen; //G2
    let c2G = g2_gen.mul(c1); //3a * G2

    assert_eq!(consistent(&[a1G, b1G], &[], &[c1G, c2G]), true)
}

#[test]
fn test_invs() {
    let g2 = &icicle_g2_generator();
    let sc = ScalarField::from_u32(3);
    let scInv = sc.inv();

    println!("{}", sc);
    println!("{}", scInv);

    let x = g2.mul(sc);
    //multiplicative inverse
    let xInvG2 = g2.mul(scInv);
    //addition inverse
    let minusX = G2serde::zero() - x;

    assert_eq!(xInvG2.mul(sc), *g2);
    assert_eq!(x + minusX, G2serde::zero());
}

#[test]
fn test_consistent_case4() {
    let rng = &mut RandomGenerator::new(RandomStrategy::SystemRandom, [0u8; 32]);
    let g1_gen = icicle_g1_generator();
    let g2_gen = icicle_g2_generator();

    let two = ScalarField::from_u32(2);

    //same_ratio(A1, B1, A2, B2) && same_ratio(A1, B1, G2serde(g2), C2)
    // a1*b2 == b1*a2
    // a1 * c2 == b1 * 1
    let a1 = rng.next_random();
    let a2 = rng.next_random();

    let b1 = a1 * two;
    let b2 = a2 * two;

    let c1 = a1;
    let c2 = c1 * two;

    let a1G = g1_gen.mul(a1);
    let b1G = g1_gen.mul(b1);

    let a2G = g2_gen.mul(a2);
    let b2G = g2_gen.mul(b2);

    let c1G = g2_gen.mul(c1);
    let c2G = g2_gen.mul(c2);

    assert_eq!(consistent(&[a1G, b1G], &[a2G, b2G], &[c1G, c2G]), true)
}

#[test]
fn test_same_ratio() {
    let g1_gen = icicle_g1_generator();
    let g2_gen = icicle_g2_generator();

    let tau = Tau::gen();

    let x2G1 = g1_gen.mul(tau.x.pow(2));
    let xyG1 = g1_gen.mul(tau.x).mul(tau.y);

    let y2G2 = g2_gen.mul(tau.y.pow(2));
    let xyG2 = g2_gen.mul(tau.y).mul(tau.x);

    let result = same_ratio(x2G1, xyG1, xyG2, y2G2);
    assert_eq!(result, true)
}
#[test]
fn test_pok() {
    let g1 = icicle_g1_generator();

    let tau = Tau::gen();
    let v = [72u8; 64];
    let A = g1.mul(tau.alpha);
    let cpok = pok(&g1, tau.alpha, &v);

    let result = check_pok(&A, &g1, cpok, &v);
    assert_eq!(result, true)
}

#[test]
fn test_ro() {
    let g1_gen = icicle_g1_generator();
    let v = [99u8; 64];
    let out1 = ro(&g1_gen, &v);
    let out2 = ro(&g1_gen, &v);
    assert_eq!(out1.0, out2.0)
}
