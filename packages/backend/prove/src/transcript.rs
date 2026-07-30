use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use libs::group_structures::G1serde;
use tiny_keccak::Keccak;

use crate::{Proof0, Proof1, Proof2, Proof3};

#[derive(Clone)]
struct RollingKeccakTranscript {
    state_part_0: [u8; 32],
    state_part_1: [u8; 32],
    challenge_counter: u32,
}

impl RollingKeccakTranscript {
    const DST_0_TAG: u8 = 0;
    const DST_1_TAG: u8 = 1;
    const CHALLENGE_DST_TAG: u8 = 2;

    fn new() -> Self {
        Self {
            state_part_0: [0u8; 32],
            state_part_1: [0u8; 32],
            challenge_counter: 0,
        }
    }

    fn update(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if bytes.len() > 32 {
            return Err("Input must be 32 bytes or less");
        }

        let old_state_0 = self.state_part_0;
        let old_state_1 = self.state_part_1;

        // This memory layout must match the Solidity transcript exactly.
        let mut hash_input = [0u8; 100];
        hash_input[3] = Self::DST_0_TAG;
        hash_input[4..36].copy_from_slice(&old_state_0);
        hash_input[36..68].copy_from_slice(&old_state_1);
        let start_idx = 100 - bytes.len();
        hash_input[start_idx..].copy_from_slice(bytes);

        let mut hasher = Keccak::new_keccak256();
        hasher.update(&hash_input);
        hasher.finalize(&mut self.state_part_0);

        hash_input[3] = Self::DST_1_TAG;
        let mut hasher = Keccak::new_keccak256();
        hasher.update(&hash_input);
        hasher.finalize(&mut self.state_part_1);

        Ok(())
    }

    fn get_challenge_raw(&mut self) -> [u8; 32] {
        let mut hash_input = [0u8; 72];
        hash_input[3] = Self::CHALLENGE_DST_TAG;
        hash_input[4..36].copy_from_slice(&self.state_part_0);
        hash_input[36..68].copy_from_slice(&self.state_part_1);
        // Solidity uses shl(224, numberOfChallenge).
        hash_input[68] = (self.challenge_counter >> 24) as u8;
        hash_input[69] = (self.challenge_counter >> 16) as u8;
        hash_input[70] = (self.challenge_counter >> 8) as u8;
        hash_input[71] = self.challenge_counter as u8;
        self.challenge_counter += 1;

        let mut value = [0u8; 32];
        let mut hasher = Keccak::new_keccak256();
        hasher.update(&hash_input);
        hasher.finalize(&mut value);
        value
    }

    fn get_challenge(&mut self) -> ScalarField {
        let mut result = self.get_challenge_raw();
        // Match Solidity's FR_MASK before converting the big-endian digest.
        result[0] &= 0x1f;
        result.reverse();
        let scalar = ScalarField::from_bytes_le(&result);

        if scalar == ScalarField::zero() {
            ScalarField::one()
        } else {
            scalar
        }
    }

    fn field_to_bytes<T: FieldImpl>(&self, element: &T) -> [u8; 32] {
        let mut le_bytes = element.to_bytes_le();
        if le_bytes.len() > 32 {
            let len = le_bytes.len();
            le_bytes = le_bytes[(len - 32)..].to_vec();
        }
        le_bytes.reverse();

        let mut result = [0u8; 32];
        let start_idx = 32 - le_bytes.len();
        result[start_idx..].copy_from_slice(&le_bytes);
        result
    }

    fn commit_field_as_bytes<T: FieldImpl>(&mut self, element: &T) -> Result<(), &'static str> {
        let bytes = self.field_to_bytes(element);
        self.update(&bytes)
    }

    fn commit_bls12_381_field_element<T: FieldImpl>(
        &mut self,
        element: &T,
    ) -> Result<(), &'static str> {
        let mut le_bytes = element.to_bytes_le();
        while le_bytes.len() < 48 {
            le_bytes.push(0);
        }
        le_bytes.reverse();

        let part1 = &le_bytes[0..16];
        let part2 = &le_bytes[16..48];
        let mut part1_padded = [0u8; 32];
        part1_padded[16..].copy_from_slice(part1);

        self.update(&part1_padded)?;
        self.update(part2)?;
        Ok(())
    }

    fn commit_g1_point(&mut self, point: &G1serde) -> Result<(), &'static str> {
        self.commit_bls12_381_field_element(&point.0.x)?;
        self.commit_bls12_381_field_element(&point.0.y)?;
        Ok(())
    }

    fn get_challenges(&mut self, count: usize) -> Vec<ScalarField> {
        (0..count).map(|_| self.get_challenge()).collect()
    }
}

#[derive(Clone)]
pub struct TranscriptManager {
    transcript: RollingKeccakTranscript,
}

impl TranscriptManager {
    pub fn new() -> Self {
        Self {
            transcript: RollingKeccakTranscript::new(),
        }
    }

    fn commit_point(&mut self, label: &str, point: &G1serde) {
        self.transcript
            .commit_g1_point(point)
            .unwrap_or_else(|error| panic!("Failed to commit {label}: {error}"));
    }

    fn commit_scalar(&mut self, label: &str, scalar: &ScalarField) {
        self.transcript
            .commit_field_as_bytes(scalar)
            .unwrap_or_else(|error| panic!("Failed to commit {label}: {error}"));
    }

    pub fn add_proof0(&mut self, proof: &Proof0) {
        // This order is part of the verifier transcript contract.
        self.commit_point("U", &proof.U);
        self.commit_point("V", &proof.V);
        self.commit_point("W", &proof.W);
        self.commit_point("Q_AX", &proof.Q_AX);
        self.commit_point("Q_AY", &proof.Q_AY);
        self.commit_point("B", &proof.B);
    }

    pub fn get_thetas(&mut self) -> Vec<ScalarField> {
        self.transcript.get_challenges(3)
    }

    pub fn add_proof1(&mut self, proof: &Proof1) {
        self.commit_point("R", &proof.R);
    }

    pub fn get_kappa0(&mut self) -> ScalarField {
        self.transcript.get_challenge()
    }

    pub fn add_proof2(&mut self, proof: &Proof2) {
        self.commit_point("Q_CX", &proof.Q_CX);
        self.commit_point("Q_CY", &proof.Q_CY);
    }

    pub fn get_chi_zeta(&mut self) -> (ScalarField, ScalarField) {
        (
            self.transcript.get_challenge(),
            self.transcript.get_challenge(),
        )
    }

    pub fn add_proof3(&mut self, proof: &Proof3) {
        self.commit_scalar("V_eval", &proof.V_eval.0);
        self.commit_scalar("R_eval", &proof.R_eval.0);
        self.commit_scalar("R_omegaX_eval", &proof.R_omegaX_eval.0);
        self.commit_scalar("R_omegaX_omegaY_eval", &proof.R_omegaX_omegaY_eval.0);
    }

    pub fn get_kappa1(&mut self) -> ScalarField {
        self.transcript.get_challenge()
    }
}

#[cfg(test)]
mod tests {
    use icicle_core::traits::FieldImpl;
    use libs::field_structures::FieldSerde;

    use super::*;

    #[test]
    fn challenges_match_protocol_snapshot() {
        let mut manager = TranscriptManager::new();
        let proof0 = Proof0 {
            U: G1serde::zero(),
            V: G1serde::zero(),
            W: G1serde::zero(),
            Q_AX: G1serde::zero(),
            Q_AY: G1serde::zero(),
            B: G1serde::zero(),
        };
        let proof1 = Proof1 { R: G1serde::zero() };
        let proof2 = Proof2 {
            Q_CX: G1serde::zero(),
            Q_CY: G1serde::zero(),
        };
        let proof3 = Proof3 {
            V_eval: FieldSerde(ScalarField::from_u32(1)),
            R_eval: FieldSerde(ScalarField::from_u32(2)),
            R_omegaX_eval: FieldSerde(ScalarField::from_u32(3)),
            R_omegaX_omegaY_eval: FieldSerde(ScalarField::from_u32(4)),
        };

        manager.add_proof0(&proof0);
        let thetas = manager.get_thetas();
        manager.add_proof1(&proof1);
        let kappa0 = manager.get_kappa0();
        manager.add_proof2(&proof2);
        let (chi, zeta) = manager.get_chi_zeta();
        manager.add_proof3(&proof3);
        let kappa1 = manager.get_kappa1();

        let expected = [
            "6597b56f56f8683716ba48f291e2ec6172ba3fb6337acb5de1cdf7503ce0ad05",
            "9a241fed3463d64320c26c95d1ebe68342e893c4f500eff57c7f19da15011e1e",
            "188421c22db479751e54c30c8d32d142021fed66c88df1ccb11da0f5a46c8707",
            "587311a65e0795a7173f4491eadef54134cefba4feba7da3a8eba1ccab54860f",
            "f7d87268d19f9d303205f78c8c8a59b9ebb02701acbb8da03b0271818a964506",
            "83ee96f5106bacc1d73e8fa351a446fabd86017968a3ab7ae969c23a56da1709",
            "8115ebdd773161aad0a8b111e0843c934ce91307c1a6707bf7cc6a3e3ab9d31a",
        ];

        for (value, expected) in thetas
            .iter()
            .chain([&kappa0, &chi, &zeta, &kappa1])
            .zip(expected)
        {
            let actual = value
                .to_bytes_le()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            assert_eq!(actual, expected);
        }
    }
}
