//! Canonical Keccak-256 Fiat--Shamir transcript for the univariate protocol.
//!
//! This module intentionally does not share the legacy rolling transcript:
//! U51--U53 require a complete, length-prefixed statement context and six
//! domain-separated challenge rounds.

use crate::group_structures::G1serde;
use ark_bls12_381::Fr;
use ark_ff::{BigInteger, PrimeField};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::{Arithmetic, FieldImpl};
use tiny_keccak::Keccak;

const TRANSCRIPT_DOMAIN: &[u8] = b"tokamak-zk-evm-univariate-fs-v1";

/// Builds an injective type-tagged, length-prefixed encoding for U51--U53.
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

/// State for the U53 challenge schedule after canonical U51 context encoding.
#[derive(Clone, Debug)]
pub struct UnivariateTranscript {
    context: Vec<u8>,
    history: Vec<u8>,
}

impl UnivariateTranscript {
    pub fn new(context: Vec<u8>) -> Self {
        Self {
            context,
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
        self.sample(round, output_index, |_| true)
    }

    /// Derives U53's `zeta`, excluding zero and both protocol domains.
    pub fn zeta(&mut self, arithmetic_size: usize, connection_size: usize) -> ScalarField {
        self.sample(4, 0, |value| {
            *value != ScalarField::zero()
                && value.pow(arithmetic_size) != ScalarField::one()
                && value.pow(connection_size) != ScalarField::one()
        })
    }

    /// Derives U53's nonzero `mu`.
    pub fn nonzero_challenge(&mut self, round: u8, output_index: u8) -> ScalarField {
        self.sample(round, output_index, |value| *value != ScalarField::zero())
    }

    fn sample<F>(&mut self, round: u8, output_index: u8, accepts: F) -> ScalarField
    where
        F: Fn(&ScalarField) -> bool,
    {
        for counter in 0u32.. {
            let input = CanonicalTranscriptEncoder::new()
                .bytes("protocol", TRANSCRIPT_DOMAIN)
                .u32("round", u32::from(round))
                .u32("output-index", u32::from(output_index))
                .bytes("context", &self.context)
                .bytes("history", &self.history)
                .u32("rejection-counter", counter)
                .finish();
            let Some(value) = digest_to_scalar(keccak256(&input)) else {
                continue;
            };
            if !accepts(&value) {
                continue;
            }
            self.history.extend_from_slice(
                &CanonicalTranscriptEncoder::new()
                    .u32("challenge-round", u32::from(round))
                    .u32("challenge-output-index", u32::from(output_index))
                    .scalar("challenge", &value)
                    .finish(),
            );
            return value;
        }
        unreachable!("u32 rejection counter exhausted")
    }
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
    use super::{CanonicalTranscriptEncoder, UnivariateTranscript};
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::FieldImpl;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        schema_id: String,
        context: Context,
        message_blocks: Vec<MessageBlock>,
        challenges: Challenges,
    }

    #[derive(Deserialize)]
    struct Context {
        library: String,
        instance: u32,
    }

    #[derive(Deserialize)]
    struct MessageBlock {
        index: u8,
        value: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Challenges {
        beta: String,
        gamma_c: String,
        theta: String,
    }

    #[test]
    fn transcript_is_deterministic_and_context_bound() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../common/contracts/fixtures/univariate-fiat-shamir.v1.json"
        ))
        .expect("Fiat--Shamir fixture must be valid JSON");
        assert_eq!(fixture.schema_id, "tokamak-zk-evm-univariate-fs-v1");
        let context = CanonicalTranscriptEncoder::new()
            .bytes("library", fixture.context.library.as_bytes())
            .scalar("instance", &ScalarField::from_u32(fixture.context.instance))
            .finish();
        let mut left = UnivariateTranscript::new(context.clone());
        left.append_message_block(
            fixture.message_blocks[0].index,
            fixture.message_blocks[0].value.as_bytes(),
        );
        let beta = left.challenge(1, 0);
        let gamma = left.challenge(1, 1);
        left.append_message_block(
            fixture.message_blocks[1].index,
            fixture.message_blocks[1].value.as_bytes(),
        );
        let theta = left.challenge(2, 0);
        assert_eq!(format!("0x{}", hex::encode(beta.to_bytes_le().into_iter().rev().collect::<Vec<_>>())), fixture.challenges.beta);
        assert_eq!(format!("0x{}", hex::encode(gamma.to_bytes_le().into_iter().rev().collect::<Vec<_>>())), fixture.challenges.gamma_c);
        assert_eq!(format!("0x{}", hex::encode(theta.to_bytes_le().into_iter().rev().collect::<Vec<_>>())), fixture.challenges.theta);

        let mut same = UnivariateTranscript::new(context);
        same.append_message_block(1, b"a1");
        assert_eq!(beta, same.challenge(1, 0));
        assert_eq!(gamma, same.challenge(1, 1));
        same.append_message_block(2, b"a2");
        assert_eq!(theta, same.challenge(2, 0));

        let mut changed = UnivariateTranscript::new(
            CanonicalTranscriptEncoder::new().bytes("library", b"other-library").finish(),
        );
        changed.append_message_block(1, b"a1");
        assert_ne!(beta, changed.challenge(1, 0));
    }
}
