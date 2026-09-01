pub(crate) use crate::conversions::{
    hash_to_g2, icicle_g1_generator, icicle_g2_generator, serialize_g1_affine,
};
use ark_ff::Zero;
use ark_serialize::Compress;
use blake2::{Blake2b, Digest};
use blake3::Hasher;
use clap::ValueEnum;
use icicle_bls12_381::curve::{ScalarCfg, ScalarField};
use icicle_core::traits::{FieldImpl, GenerateRandom};
use libs::group_structures::{pairing, G1serde, G2serde};
use std::ops::Mul;

#[derive(Debug, Clone, Default)]
pub enum RandomStrategy {
    UserInput,
    #[default]
    SystemRandom,
    Hybrid,
    Testing,
}

pub struct RandomGenerator {
    strategy: RandomStrategy,
    current_seed: [u8; 32],
    pub iteration_count: usize,
}

impl RandomGenerator {
    pub fn new(strategy: RandomStrategy, initial_seed: [u8; 32]) -> Self {
        Self {
            strategy,
            current_seed: initial_seed,
            iteration_count: 0,
        }
    }

    fn next_seed_scalar(&mut self) -> ScalarField {
        let scalar = ScalarField::from_u32(0) + ScalarField::from_bytes_le(&self.current_seed);
        let mut hasher = Hasher::new();
        hasher.update(&self.current_seed);
        self.current_seed
            .copy_from_slice(hasher.finalize().as_bytes());
        scalar
    }

    pub fn next_random(&mut self) -> ScalarField {
        match self.strategy {
            RandomStrategy::UserInput => self.next_seed_scalar(),
            RandomStrategy::SystemRandom => ScalarCfg::generate_random(1)[0],
            RandomStrategy::Hybrid => {
                let user_component = self.next_seed_scalar();
                ScalarCfg::generate_random(1)[0] + user_component
            }
            RandomStrategy::Testing => {
                self.iteration_count += 1;
                ScalarField::from_u32((self.iteration_count * 2 + 1) as u32)
            }
        }
    }
}

pub fn seed_bytes_from_input(input: &str) -> [u8; 32] {
    let mut hasher = Hasher::new();
    hasher.update(input.trim().as_bytes());
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(hasher.finalize().as_bytes());
    bytes
}

#[derive(Debug, Clone, ValueEnum)]
pub enum Mode {
    Random,
    Beacon,
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
            Mode::Random => match seed_input {
                Some(input) => (
                    RandomStrategy::Hybrid,
                    "Initializing random generator in hybrid random mode",
                    seed_bytes_from_input(input),
                ),
                None => (
                    RandomStrategy::SystemRandom,
                    "Initializing random generator in system random mode",
                    [0u8; 32],
                ),
            },
        }
    };
    println!("{message}");
    RandomGenerator::new(strategy, seed)
}

pub fn check_pok(a: &G1serde, g1: &G1serde, b: G2serde, transcript: &[u8]) -> bool {
    let challenge_base = ro(a, transcript);
    same_ratio(*g1, *a, challenge_base, b)
}

pub fn pok(g1: &G1serde, scalar: ScalarField, transcript: &[u8]) -> G2serde {
    let contribution = g1.mul(scalar);
    ro(&contribution, transcript).mul(scalar)
}

pub fn same_ratio(g1_0: G1serde, g1_1: G1serde, g2_0: G2serde, g2_1: G2serde) -> bool {
    let neg_g1_1 = G1serde::zero() - g1_1;
    pairing(&[g1_0, neg_g1_1], &[g2_1, g2_0]).is_zero()
}

fn ro(point: &G1serde, transcript: &[u8]) -> G2serde {
    let mut hash = Blake2b::default();
    hash.input(transcript);
    hash.input(serialize_g1_affine(&point.0, Compress::No));
    hash_to_g2(hash.result().as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_ff::One;

    #[test]
    fn proof_of_knowledge_and_ratio_checks_accept_matching_scalars() {
        let g1 = icicle_g1_generator();
        let g2 = icicle_g2_generator();
        let scalar = ScalarField::from_u32(7);
        let contribution = g1.mul(scalar);
        let proof = pok(&g1, scalar, b"test-domain");
        assert!(check_pok(&contribution, &g1, proof, b"test-domain"));
        assert!(same_ratio(g1, contribution, g2, g2.mul(scalar)));
    }

    #[test]
    fn pairing_product_cancels_opposite_points() {
        let g1 = icicle_g1_generator();
        let g2 = icicle_g2_generator();
        let minus_g2 = G2serde::zero() - g2;
        assert!(pairing(&[g1, g1], &[g2, minus_g2]).0.is_one());
    }

    #[test]
    fn deterministic_testing_generator_preserves_existing_share_sequence() {
        let mut random = RandomGenerator::new(RandomStrategy::Testing, [0u8; 32]);
        assert_eq!(random.next_random(), ScalarField::from_u32(3));
        assert_eq!(random.next_random(), ScalarField::from_u32(5));
    }
}
