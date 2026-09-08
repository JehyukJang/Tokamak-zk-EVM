//! Canonical Keccak-256 Fiat--Shamir transcript for the univariate protocol.
//!
//! F1 fixes the verifier configuration before every random-oracle query. The
//! proof-time transcript therefore contains only the public-input vector,
//! prover messages, and preceding challenges described by F2--F4.

use crate::group_structures::G1serde;
use crate::univariate_proof::UnivariateProof;
use ark_bls12_381::Fr;
use ark_ff::{BigInteger, PrimeField};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::{Arithmetic, FieldImpl};
use tiny_keccak::Keccak;

pub const UNIVARIATE_FIAT_SHAMIR_SCHEMA_ID: &str = "tokamak-zk-evm-univariate-fs";
const TRANSCRIPT_DOMAIN: &[u8] = UNIVARIATE_FIAT_SHAMIR_SCHEMA_ID.as_bytes();

/// The six F3 challenges in their protocol order.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UnivariateChallenges {
    pub upsilon: ScalarField,
    pub beta: ScalarField,
    pub gamma_c: ScalarField,
    pub theta: ScalarField,
    pub zeta: ScalarField,
    pub varpi: ScalarField,
    pub mu: ScalarField,
}

/// Builds an injective type-tagged, length-prefixed encoding for F2--F4.
#[derive(Clone, Debug, Default)]
pub struct CanonicalTranscriptEncoder {
    bytes: Vec<u8>,
}

impl CanonicalTranscriptEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn bytes(mut self, label: &str, value: &[u8]) -> Self {
        self.push(label, value);
        self
    }

    pub fn u32(mut self, label: &str, value: u32) -> Self {
        self.push(label, &value.to_be_bytes());
        self
    }

    pub fn scalar(mut self, label: &str, value: &ScalarField) -> Self {
        self.push(label, &scalar_bytes(value));
        self
    }

    pub fn g1(mut self, label: &str, value: &G1serde) -> Self {
        self.push(label, &g1_bytes(value));
        self
    }

    pub fn finish(self) -> Vec<u8> {
        self.bytes
    }

    fn push(&mut self, label: &str, value: &[u8]) {
        let label = label.as_bytes();
        let label_len = u32::try_from(label.len()).expect("transcript label length exceeds u32");
        let value_len = u64::try_from(value.len()).expect("transcript value length exceeds u64");
        self.bytes.extend_from_slice(&label_len.to_be_bytes());
        self.bytes.extend_from_slice(label);
        self.bytes.extend_from_slice(&value_len.to_be_bytes());
        self.bytes.extend_from_slice(value);
    }
}

/// State for the F4 challenge schedule after canonical public-input encoding.
#[derive(Clone, Debug)]
pub struct UnivariateTranscript {
    statement: Vec<u8>,
    history: Vec<u8>,
}

impl UnivariateTranscript {
    /// Creates F4 state for one validated fixed verifier configuration and its
    /// adaptive public-input statement. The configuration itself is excluded
    /// by F1 and must have been admitted by the caller before this method.
    pub fn from_public_inputs(public_inputs: &[ScalarField]) -> Self {
        Self {
            statement: encode_public_inputs(public_inputs),
            history: Vec::new(),
        }
    }

    /// Appends one U52 message block before the matching U53 challenge round.
    pub fn append_message_block(&mut self, block: u8, encoded_message: &[u8]) {
        self.history.extend_from_slice(
            &CanonicalTranscriptEncoder::new()
                .u32("message-block", u32::from(block))
                .bytes("message", encoded_message)
                .finish(),
        );
    }

    /// Derives one ordinary field challenge and records it for later rounds.
    pub fn challenge(&mut self, round: u8, output_index: u8) -> ScalarField {
        let value = self.sample_value(round, output_index, |_| true);
        self.record_challenge(round, output_index, &value);
        value
    }

    /// Samples F3's paired `(beta, gamma_C)` output from one F4 state. Neither
    /// coordinate may influence the other coordinate's oracle input.
    pub fn challenge_pair(&mut self, round: u8) -> (ScalarField, ScalarField) {
        let first = self.sample_value(round, 0, |_| true);
        let second = self.sample_value(round, 1, |_| true);
        self.record_challenge(round, 0, &first);
        self.record_challenge(round, 1, &second);
        (first, second)
    }

    /// Derives U53's `zeta`, excluding zero and both protocol domains.
    pub fn zeta(&mut self, arithmetic_size: usize, connection_size: usize) -> ScalarField {
        let value = self.sample_value(4, 0, |value| {
            *value != ScalarField::zero()
                && value.pow(arithmetic_size) != ScalarField::one()
                && value.pow(connection_size) != ScalarField::one()
        });
        self.record_challenge(4, 0, &value);
        value
    }

    /// Derives U53's nonzero `mu`.
    pub fn nonzero_challenge(&mut self, round: u8, output_index: u8) -> ScalarField {
        let value = self.sample_value(round, output_index, |value| *value != ScalarField::zero());
        self.record_challenge(round, output_index, &value);
        value
    }

    /// Runs F2--F4 after callers append each prover message block exactly
    /// once. The message encodings are caller-owned typed encodings.
    pub fn derive_challenges(
        &mut self,
        a1: &[u8],
        a2: &[u8],
        a3: &[u8],
        a4: &[u8],
        a5: &[u8],
        a6: &[u8],
        arithmetic_size: usize,
        connection_size: usize,
    ) -> UnivariateChallenges {
        self.append_message_block(1, a1);
        let upsilon = self.challenge(1, 0);
        self.append_message_block(2, a2);
        let (beta, gamma_c) = self.challenge_pair(2);
        self.append_message_block(3, a3);
        let theta = self.challenge(3, 0);
        self.append_message_block(4, a4);
        let zeta = self.zeta(arithmetic_size, connection_size);
        self.append_message_block(5, a5);
        let varpi = self.challenge(5, 0);
        self.append_message_block(6, a6);
        let mu = self.nonzero_challenge(6, 0);
        UnivariateChallenges {
            upsilon,
            beta,
            gamma_c,
            theta,
            zeta,
            varpi,
            mu,
        }
    }

    fn sample_value<F>(&self, round: u8, output_index: u8, accepts: F) -> ScalarField
    where
        F: Fn(&ScalarField) -> bool,
    {
        for counter in 0u32.. {
            let input = CanonicalTranscriptEncoder::new()
                .bytes("protocol", TRANSCRIPT_DOMAIN)
                .u32("round", u32::from(round))
                .u32("output-index", u32::from(output_index))
                .bytes("statement", &self.statement)
                .bytes("history", &self.history)
                .u32("rejection-counter", counter)
                .finish();
            let Some(value) = digest_to_scalar(keccak256(&input)) else {
                continue;
            };
            if !accepts(&value) {
                continue;
            }
            return value;
        }
        unreachable!("u32 rejection counter exhausted")
    }

    fn record_challenge(&mut self, round: u8, output_index: u8, value: &ScalarField) {
        self.history.extend_from_slice(
            &CanonicalTranscriptEncoder::new()
                .u32("challenge-round", u32::from(round))
                .u32("challenge-output-index", u32::from(output_index))
                .scalar("challenge", value)
                .finish(),
        );
    }
}

/// Canonically encodes F1's adaptive statement `a` without any fixed verifier
/// configuration field.
pub fn encode_public_inputs(public_inputs: &[ScalarField]) -> Vec<u8> {
    let mut encoder = CanonicalTranscriptEncoder::new().u32(
        "public-input-count",
        u32::try_from(public_inputs.len()).expect("public-input count exceeds u32"),
    );
    for (index, value) in public_inputs.iter().enumerate() {
        encoder = encoder.scalar(&format!("public-input.{index}"), value);
    }
    encoder.finish()
}

/// Encodes one F2--F4 affine-point message block.  Both prover construction
/// and verifier replay use this function so the proof wire object is the only
/// source of the message sequence.
pub fn encode_g1_message_block(label: &str, points: &[G1serde]) -> Vec<u8> {
    let mut encoder = CanonicalTranscriptEncoder::new().u32(
        "count",
        u32::try_from(points.len()).expect("point-message count exceeds u32"),
    );
    for (index, point) in points.iter().enumerate() {
        encoder = encoder.g1(&format!("{label}.{index}"), point);
    }
    encoder.finish()
}

/// Encodes F4's nine field evaluations in their protocol order.
pub fn encode_evaluation_message_block(proof: &UnivariateProof) -> Vec<u8> {
    CanonicalTranscriptEncoder::new()
        .scalar("sA", &proof.s_a.0)
        .scalar("sC", &proof.s_c.0)
        .scalar("u", &proof.u.0)
        .scalar("v", &proof.v.0)
        .scalar("w", &proof.w.0)
        .scalar("b", &proof.b.0)
        .scalar("qZeta", &proof.q_zeta.0)
        .scalar("r", &proof.r.0)
        .scalar("rPlus", &proof.r_plus.0)
        .finish()
}

/// Replays F2--F4 from F5's canonical proof messages.  The fixed verifier
/// configuration is deliberately not an argument: F1 admits it before this
/// proof-time transcript is constructed.
pub fn derive_proof_challenges(
    public_inputs: &[ScalarField],
    proof: &UnivariateProof,
    arithmetic_size: usize,
    connection_size: usize,
) -> UnivariateChallenges {
    UnivariateTranscript::from_public_inputs(public_inputs).derive_challenges(
        &encode_g1_message_block(
            "F2.a1",
            &[
                proof.c_u,
                proof.c_v,
                proof.c_w,
                proof.c_b,
                proof.o_if,
                proof.o_int,
            ],
        ),
        &encode_g1_message_block("F2.a2", &[proof.c_d]),
        &encode_g1_message_block("F2.a3", &[proof.c_r]),
        &encode_g1_message_block("F2.a4", &[proof.c_q]),
        &encode_evaluation_message_block(proof),
        &encode_g1_message_block("F2.a6", &[proof.pi_zeta, proof.pi_plus]),
        arithmetic_size,
        connection_size,
    )
}

fn keccak256(input: &[u8]) -> [u8; 32] {
    let mut output = [0u8; 32];
    let mut hasher = Keccak::new_keccak256();
    hasher.update(input);
    hasher.finalize(&mut output);
    output
}

fn digest_to_scalar(digest: [u8; 32]) -> Option<ScalarField> {
    let ark = Fr::from_be_bytes_mod_order(&digest);
    let bigint = ark.into_bigint();
    let mut canonical = bigint.to_bytes_be();
    if canonical.len() > digest.len() {
        return None;
    }
    if canonical.len() < digest.len() {
        let mut padded = vec![0u8; digest.len() - canonical.len()];
        padded.append(&mut canonical);
        canonical = padded;
    }
    if canonical.as_slice() != digest {
        return None;
    }
    Some(ScalarField::from_bytes_le(&bigint.to_bytes_le()))
}

fn scalar_bytes(value: &ScalarField) -> [u8; 32] {
    let mut bytes = value.to_bytes_le();
    bytes.resize(32, 0);
    bytes.reverse();
    bytes.try_into().expect("BLS scalar must fit in 32 bytes")
}

fn g1_bytes(value: &G1serde) -> [u8; 96] {
    let mut output = [0u8; 96];
    for (index, coordinate) in [&value.0.x, &value.0.y].into_iter().enumerate() {
        let mut bytes = coordinate.to_bytes_le();
        bytes.resize(48, 0);
        bytes.reverse();
        output[index * 48..(index + 1) * 48].copy_from_slice(&bytes);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::UnivariateTranscript;
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    #[test]
    fn transcript_is_deterministic_and_binds_only_the_public_statement() {
        let public_inputs = [ScalarField::from_u32(7), ScalarField::from_u32(11)];
        let mut left = UnivariateTranscript::from_public_inputs(&public_inputs);
        left.append_message_block(1, b"a1");
        let upsilon = left.challenge(1, 0);
        let (beta, gamma) = left.challenge_pair(2);
        left.append_message_block(2, b"a2");
        let theta = left.challenge(3, 0);

        let mut same = UnivariateTranscript::from_public_inputs(&public_inputs);
        same.append_message_block(1, b"a1");
        assert_eq!(upsilon, same.challenge(1, 0));
        assert_eq!((beta, gamma), same.challenge_pair(2));
        same.append_message_block(2, b"a2");
        assert_eq!(theta, same.challenge(3, 0));

        let mut changed = UnivariateTranscript::from_public_inputs(&[ScalarField::from_u32(8)]);
        changed.append_message_block(1, b"a1");
        assert_ne!(upsilon, changed.challenge(1, 0));
    }
}
