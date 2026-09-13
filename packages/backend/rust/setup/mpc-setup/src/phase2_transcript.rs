//! Append-only public contribution records. Initialization is derived locally,
//! never deserialized from the coordinator. No source-verification receipt is
//! accepted here: callers must construct the engine from authenticated inputs.

use crate::circuit_input::Mode;
use crate::contribution_proof::{ContributionBinding, ShareProof, ShareRole};
use crate::phase2_engine::{Engine, State, VerifiedState};
use ark_bls12_381::{Bls12_381, Fr, G1Affine, G2Affine};
use ark_ec::{pairing::Pairing, AffineRepr};
use ark_ff::{UniformRand, Zero};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use rand::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use zeroize::Zeroizing;

pub(crate) struct Identity {
    pub mode: Mode,
    pub version: String,
    pub library_digest: [u8; 32],
    pub tau_digest: [u8; 32],
}

pub(crate) struct Transcript<'a> {
    bytes: Vec<u8>,
    state: VerifiedState<'a>,
    identity: &'a Identity,
    contributions: usize,
    digest: [u8; 32],
}

impl<'a> Transcript<'a> {
    pub(crate) fn state(&self) -> &VerifiedState<'a> {
        &self.state
    }

    pub(crate) fn contributions(&self) -> usize {
        self.contributions
    }

    pub fn file_digest(&self) -> String {
        format!("{:x}", Sha256::digest(&self.bytes))
    }
    pub fn initialize(engine: &'a Engine, identity: &'a Identity) -> Result<Self, String> {
        let mut bytes = b"TOKAMAK_MPC_PHASE2\0".to_vec();
        let mut context = Sha256::new();
        // Even byte-identical circuit inputs cannot promote a development
        // ceremony into a publish ceremony. The record chain inherits this binding.
        context.update((identity.mode.name().len() as u64).to_be_bytes());
        context.update(identity.mode.name().as_bytes());
        context.update((identity.version.len() as u64).to_be_bytes());
        context.update(identity.version.as_bytes());
        context.update(identity.library_digest);
        context.update(identity.tau_digest);
        context.update(encode_state(engine.initial())?);
        bytes.extend_from_slice(&context.finalize());
        Ok(Self {
            digest: Sha256::digest(&bytes).into(),
            bytes,
            state: engine.initial_state(),
            identity,
            contributions: 0,
        })
    }

    pub fn read(
        bytes: Vec<u8>,
        engine: &'a Engine,
        identity: &'a Identity,
    ) -> Result<Self, String> {
        let mut result = Self::initialize(engine, identity)?;
        if !bytes.starts_with(&result.bytes) {
            return Err(
                "transcript is not bound to the locally authenticated initialization".into(),
            );
        }
        let mut input = &bytes[result.bytes.len()..];
        while !input.is_empty() {
            result.verify_record(&mut input)?;
        }
        result.bytes = bytes;
        Ok(result)
    }

    /// Check one record against the already-qualified prefix. Both external
    /// reads and local appends validate the same serialized record bytes here.
    fn verify_record(&mut self, input: &mut &[u8]) -> Result<(), String> {
        let record_start = *input;
        let state = decode_state(input, self.state.get())?;
        let state_length = record_start.len() - input.len();
        let binding = ContributionBinding {
            library_version: &self.identity.version,
            library_digest: self.identity.library_digest,
            tau_digest: self.identity.tau_digest,
            // Includes the prior receipt, so replaying even an identity
            // update (share=1) cannot duplicate a contribution.
            previous_record_digest: self.digest,
            next_state_digest: Sha256::digest(&record_start[..state_length]).into(),
        };
        let delta = decode_proof(input)?;
        if !delta.verify(&binding, ShareRole::Delta)
            || Bls12_381::pairing(self.state.get().delta_g1, delta.share_g2)
                != Bls12_381::pairing(state.delta_g1, G2Affine::generator())
        {
            return Err("invalid delta contribution or predecessor binding".into());
        }
        for j in 0..self.state.get().weights.len() {
            let proof = decode_proof(input)?;
            if !proof.verify(&binding, ShareRole::WireWeight(j as u64))
                || Bls12_381::pairing(proof.share_g1, self.state.get().weights[j])
                    != Bls12_381::pairing(G1Affine::generator(), state.weights[j])
            {
                return Err(format!(
                    "invalid wire contribution or predecessor binding at {j}"
                ));
            }
        }
        let state = self.state.verify_successor(state)?;
        let record = &record_start[..record_start.len() - input.len()];
        let mut hash = Sha256::new();
        hash.update(self.digest);
        hash.update(record);
        self.digest = hash.finalize().into();
        self.contributions += 1;
        self.state = state;
        Ok(())
    }

    pub fn contribute(mut self, rng: &mut (impl RngCore + CryptoRng)) -> Result<Self, String> {
        let nonzero = |rng: &mut _| loop {
            let share = Fr::rand(rng);
            if !share.is_zero() {
                break share;
            }
        };
        let u = Zeroizing::new(nonzero(rng));
        let v = Zeroizing::new(
            (0..self.state.get().weights.len())
                .map(|_| nonzero(rng))
                .collect::<Vec<_>>(),
        );
        let state = self.state.contribute(*u, &v)?;
        let mut record = encode_state(&state)?;
        let binding = ContributionBinding {
            library_version: &self.identity.version,
            library_digest: self.identity.library_digest,
            tau_digest: self.identity.tau_digest,
            previous_record_digest: self.digest,
            next_state_digest: Sha256::digest(&record).into(),
        };
        encode_proof(
            &ShareProof::create(*u, &binding, ShareRole::Delta, rng)?,
            &mut record,
        )?;
        for (j, share) in v.iter().enumerate() {
            encode_proof(
                &ShareProof::create(*share, &binding, ShareRole::WireWeight(j as u64), rng)?,
                &mut record,
            )?;
        }
        // Verify exactly the public bytes that will be handed to the next
        // participant before exposing output. Private shares are not encoded.
        drop(u);
        drop(v);
        let mut input = record.as_slice();
        self.verify_record(&mut input)?;
        if !input.is_empty() {
            return Err("unexpected trailing bytes in generated contribution".into());
        }
        self.bytes.extend_from_slice(&record);
        Ok(self)
    }

    pub fn write_new(&self, path: &Path) -> Result<(), String> {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        staged.write_all(&self.bytes).map_err(|e| e.to_string())?;
        staged.as_file().sync_all().map_err(|e| e.to_string())?;
        staged.persist_noclobber(path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn encode_state(state: &State) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    for points in [
        &state.packed,
        &state.correction,
        &state.fixed,
        &state.fixed_correction,
        &state.weighted,
        &state.shifted,
    ] {
        for point in points {
            put(point, &mut bytes)?;
        }
    }
    for point in state.masks {
        put(&point, &mut bytes)?;
    }
    put(&state.delta_g1, &mut bytes)?;
    put(&state.delta_g2, &mut bytes)?;
    for point in &state.weights {
        put(point, &mut bytes)?;
    }
    Ok(bytes)
}

fn decode_state(input: &mut &[u8], shape: &State) -> Result<State, String> {
    // Counts come only from the independently selected library, never from an
    // allocation length supplied in the transcript. Reject truncation first.
    let g1_count = shape.packed.len()
        + shape.correction.len()
        + shape.fixed.len()
        + shape.fixed_correction.len()
        + shape.weighted.len()
        + shape.shifted.len()
        + 10;
    let size = g1_count
        .checked_mul(96)
        .and_then(|n| n.checked_add((shape.weights.len() + 1) * 192))
        .ok_or("transcript state size overflow")?;
    if input.len() < size {
        return Err("truncated ceremony state".into());
    }
    fn points<T: CanonicalDeserialize>(input: &mut &[u8], n: usize) -> Result<Vec<T>, String> {
        (0..n).map(|_| get(input)).collect()
    }
    Ok(State {
        packed: points(input, shape.packed.len())?,
        correction: points(input, shape.correction.len())?,
        fixed: points(input, shape.fixed.len())?,
        fixed_correction: points(input, shape.fixed_correction.len())?,
        weighted: points(input, shape.weighted.len())?,
        shifted: points(input, shape.shifted.len())?,
        masks: points(input, 9)?.try_into().unwrap(),
        delta_g1: get(input)?,
        delta_g2: get(input)?,
        weights: points(input, shape.weights.len())?,
    })
}
fn encode_proof(proof: &ShareProof, out: &mut Vec<u8>) -> Result<(), String> {
    put(&proof.share_g1, out)?;
    put(&proof.share_g2, out)?;
    put(&proof.s, out)?;
    put(&proof.s_share, out)?;
    put(&proof.r_share, out)
}
fn decode_proof(input: &mut &[u8]) -> Result<ShareProof, String> {
    Ok(ShareProof {
        share_g1: get(input)?,
        share_g2: get(input)?,
        s: get(input)?,
        s_share: get(input)?,
        r_share: get(input)?,
    })
}
fn put<T: CanonicalSerialize>(point: &T, out: &mut Vec<u8>) -> Result<(), String> {
    // Affine coordinates avoid square-root decompression at the next reader.
    // Intermediate records do not change the final common CRS encoding.
    point.serialize_uncompressed(out).map_err(|e| e.to_string())
}
fn get<T: CanonicalDeserialize>(input: &mut &[u8]) -> Result<T, String> {
    T::deserialize_uncompressed(input).map_err(|e| format!("invalid ceremony point encoding: {e}"))
}
