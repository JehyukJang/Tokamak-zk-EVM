// Public proof fields retain the protocol notation used by serialized proof JSON.
#![allow(non_snake_case)]

use crate::field_structures::FieldSerde;
use crate::group_structures::G1serde;
use crate::serialization::{scalar_to_hex, split_g1, try_next_point};
use crate::{impl_read_from_json, impl_write_into_json, split_push};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tiny_keccak::Keccak;

#[derive(Debug, Serialize, Deserialize)]
pub struct Proof {
    pub binding: Binding,
    pub proof0: Proof0,
    pub proof1: Proof1,
    pub proof2: Proof2,
    pub proof3: Proof3,
    pub proof4: Proof4,
}

impl Proof {
    pub fn convert_format_for_solidity_verifier(&self) -> FormattedProof {
        let mut proof_entries_part1 = Vec::new();
        let mut proof_entries_part2 = Vec::new();
        split_push!(
            proof_entries_part1,
            proof_entries_part2,
            &self.proof0.U,
            &self.proof0.V,
            &self.proof0.W,
            &self.binding.O_mid,
            &self.binding.O_prv,
            &self.proof0.Q_AX,
            &self.proof0.Q_AY,
            &self.proof2.Q_CX,
            &self.proof2.Q_CY,
            &self.proof4.Pi_X,
            &self.proof4.Pi_Y,
            &self.proof0.B,
            &self.proof1.R,
            &self.proof4.M_Y,
            &self.proof4.M_X,
            &self.proof4.N_Y,
            &self.proof4.N_X,
            &self.binding.O_pub_free,
            &self.binding.A_free,
        );
        proof_entries_part2.push(scalar_to_hex(&self.proof3.R_eval.0));
        proof_entries_part2.push(scalar_to_hex(&self.proof3.R_omegaX_eval.0));
        proof_entries_part2.push(scalar_to_hex(&self.proof3.R_omegaX_omegaY_eval.0));
        proof_entries_part2.push(scalar_to_hex(&self.proof3.V_eval.0));
        FormattedProof {
            proof_entries_part1,
            proof_entries_part2,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FormattedProof {
    pub proof_entries_part1: Vec<String>,
    pub proof_entries_part2: Vec<String>,
}

impl_read_from_json!(FormattedProof);
impl_write_into_json!(FormattedProof);

impl FormattedProof {
    pub fn recover_proof_from_format(&self) -> Proof {
        self.try_recover_proof_from_format()
            .unwrap_or_else(|error| panic!("{error}"))
    }

    pub fn try_recover_proof_from_format(&self) -> Result<Proof, String> {
        const G1_CNT: usize = 19;
        const SCALAR_CNT: usize = 4;
        let p1 = &self.proof_entries_part1;
        let p2 = &self.proof_entries_part2;
        if p1.len() != G1_CNT * 2 {
            return Err(format!(
                "expected {} G1 prefix entries, found {}",
                G1_CNT * 2,
                p1.len()
            ));
        }
        if p2.len() != G1_CNT * 2 + SCALAR_CNT {
            return Err(format!(
                "expected {} G1 suffix and scalar entries, found {}",
                G1_CNT * 2 + SCALAR_CNT,
                p2.len()
            ));
        }

        let U = try_next_point(0, p1, p2)?;
        let V = try_next_point(2, p1, p2)?;
        let W = try_next_point(4, p1, p2)?;
        let O_mid = try_next_point(6, p1, p2)?;
        let O_prv = try_next_point(8, p1, p2)?;
        let Q_AX = try_next_point(10, p1, p2)?;
        let Q_AY = try_next_point(12, p1, p2)?;
        let Q_CX = try_next_point(14, p1, p2)?;
        let Q_CY = try_next_point(16, p1, p2)?;
        let Pi_X = try_next_point(18, p1, p2)?;
        let Pi_Y = try_next_point(20, p1, p2)?;
        let B = try_next_point(22, p1, p2)?;
        let R = try_next_point(24, p1, p2)?;
        let M_Y = try_next_point(26, p1, p2)?;
        let M_X = try_next_point(28, p1, p2)?;
        let N_Y = try_next_point(30, p1, p2)?;
        let N_X = try_next_point(32, p1, p2)?;
        let O_pub_free = try_next_point(34, p1, p2)?;
        let A_free = try_next_point(36, p1, p2)?;
        let scalar_slice = &p2[G1_CNT * 2..];
        for (index, scalar) in scalar_slice.iter().enumerate() {
            let bytes = hex::decode(scalar.trim_start_matches("0x"))
                .map_err(|error| format!("invalid scalar at entry {index}: {error}"))?;
            if bytes.len() != 32 {
                return Err(format!(
                    "invalid scalar at entry {index}: expected 32 bytes, found {}",
                    bytes.len()
                ));
            }
        }
        Ok(Proof {
            binding: Binding {
                A_free,
                O_pub_free,
                O_mid,
                O_prv,
            },
            proof0: Proof0 {
                U,
                V,
                W,
                Q_AX,
                Q_AY,
                B,
            },
            proof1: Proof1 { R },
            proof2: Proof2 { Q_CX, Q_CY },
            proof3: Proof3 {
                R_eval: FieldSerde(ScalarField::from_hex(&scalar_slice[0])),
                R_omegaX_eval: FieldSerde(ScalarField::from_hex(&scalar_slice[1])),
                R_omegaX_omegaY_eval: FieldSerde(ScalarField::from_hex(&scalar_slice[2])),
                V_eval: FieldSerde(ScalarField::from_hex(&scalar_slice[3])),
            },
            proof4: Proof4 {
                Pi_X,
                Pi_Y,
                M_X,
                M_Y,
                N_X,
                N_Y,
            },
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Binding {
    pub A_free: G1serde,
    pub O_pub_free: G1serde,
    pub O_mid: G1serde,
    pub O_prv: G1serde,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Proof0 {
    pub U: G1serde,
    pub V: G1serde,
    pub W: G1serde,
    pub Q_AX: G1serde,
    pub Q_AY: G1serde,
    pub B: G1serde,
}

impl Proof0 {
    pub fn verify0_with_manager(&self, manager: &mut TranscriptManager) -> Vec<ScalarField> {
        manager.add_proof0(self);
        manager.get_thetas()
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Proof1 {
    pub R: G1serde,
}

impl Proof1 {
    pub fn verify1_with_manager(&self, manager: &mut TranscriptManager) -> ScalarField {
        manager.add_proof1(self);
        manager.get_kappa0()
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Proof2 {
    pub Q_CX: G1serde,
    pub Q_CY: G1serde,
}

impl Proof2 {
    pub fn verify2_with_manager(
        &self,
        manager: &mut TranscriptManager,
    ) -> (ScalarField, ScalarField) {
        manager.add_proof2(self);
        manager.get_chi_zeta()
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Proof3 {
    pub V_eval: FieldSerde,
    pub R_eval: FieldSerde,
    pub R_omegaX_eval: FieldSerde,
    pub R_omegaX_omegaY_eval: FieldSerde,
}

impl Proof3 {
    pub fn verify3_with_manager(&self, manager: &mut TranscriptManager) -> ScalarField {
        manager.add_proof3(self);
        manager.get_kappa1()
    }
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Proof4 {
    pub Pi_X: G1serde,
    pub Pi_Y: G1serde,
    pub M_X: G1serde,
    pub M_Y: G1serde,
    pub N_X: G1serde,
    pub N_Y: G1serde,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Proof4Test {
    pub Pi_AX: G1serde,
    pub Pi_AY: G1serde,
    pub Pi_CX: G1serde,
    pub Pi_CY: G1serde,
    pub Pi_B: G1serde,
    pub M_X: G1serde,
    pub M_Y: G1serde,
    pub N_X: G1serde,
    pub N_Y: G1serde,
}

impl_read_from_json!(Proof4Test);
impl_write_into_json!(Proof4Test);

#[derive(Debug, Serialize, Deserialize)]
pub struct Preprocess {
    pub s0: G1serde,
    pub s1: G1serde,
    pub O_pub_fix: G1serde,
}

impl Preprocess {
    pub fn convert_format_for_solidity_verifier(&self) -> FormattedPreprocess {
        let mut preprocess_entries_part1 = Vec::new();
        let mut preprocess_entries_part2 = Vec::new();
        split_push!(
            preprocess_entries_part1,
            preprocess_entries_part2,
            &self.s0,
            &self.s1,
            &self.O_pub_fix,
        );
        FormattedPreprocess {
            preprocess_entries_part1,
            preprocess_entries_part2,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FormattedPreprocess {
    pub preprocess_entries_part1: Vec<String>,
    pub preprocess_entries_part2: Vec<String>,
}

impl_read_from_json!(FormattedPreprocess);
impl_write_into_json!(FormattedPreprocess);

impl FormattedPreprocess {
    pub fn recover_proof_from_format(&self) -> Preprocess {
        self.try_recover_proof_from_format()
            .unwrap_or_else(|error| panic!("{error}"))
    }

    pub fn try_recover_proof_from_format(&self) -> Result<Preprocess, String> {
        const G1_CNT: usize = 3;
        let p1 = &self.preprocess_entries_part1;
        let p2 = &self.preprocess_entries_part2;
        if p1.len() != G1_CNT * 2 {
            return Err(format!(
                "expected {} G1 prefix entries, found {}",
                G1_CNT * 2,
                p1.len()
            ));
        }
        if p2.len() != G1_CNT * 2 {
            return Err(format!(
                "expected {} G1 suffix entries, found {}",
                G1_CNT * 2,
                p2.len()
            ));
        }
        Ok(Preprocess {
            s0: try_next_point(0, p1, p2)?,
            s1: try_next_point(2, p1, p2)?,
            O_pub_fix: try_next_point(4, p1, p2)?,
        })
    }
}

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
            state_part_0: [0; 32],
            state_part_1: [0; 32],
            challenge_counter: 0,
        }
    }

    fn update(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if bytes.len() > 32 {
            return Err("Input must be 32 bytes or less");
        }
        let mut hash_input = [0; 100];
        hash_input[3] = Self::DST_0_TAG;
        hash_input[4..36].copy_from_slice(&self.state_part_0);
        hash_input[36..68].copy_from_slice(&self.state_part_1);
        hash_input[100 - bytes.len()..].copy_from_slice(bytes);
        let mut hasher = Keccak::new_keccak256();
        hasher.update(&hash_input);
        hasher.finalize(&mut self.state_part_0);
        hash_input[3] = Self::DST_1_TAG;
        let mut hasher = Keccak::new_keccak256();
        hasher.update(&hash_input);
        hasher.finalize(&mut self.state_part_1);
        Ok(())
    }

    fn get_challenge(&mut self) -> ScalarField {
        let mut hash_input = [0; 72];
        hash_input[3] = Self::CHALLENGE_DST_TAG;
        hash_input[4..36].copy_from_slice(&self.state_part_0);
        hash_input[36..68].copy_from_slice(&self.state_part_1);
        hash_input[68..72].copy_from_slice(&self.challenge_counter.to_be_bytes());
        self.challenge_counter += 1;
        let mut result = [0; 32];
        let mut hasher = Keccak::new_keccak256();
        hasher.update(&hash_input);
        hasher.finalize(&mut result);
        result[0] &= 0x1f;
        result.reverse();
        let scalar = ScalarField::from_bytes_le(&result);
        if scalar == ScalarField::zero() {
            ScalarField::one()
        } else {
            scalar
        }
    }

    fn commit_field_as_bytes<T: FieldImpl>(&mut self, element: &T) -> Result<(), &'static str> {
        let mut bytes = element.to_bytes_le();
        if bytes.len() > 32 {
            let len = bytes.len();
            bytes = bytes[len - 32..].to_vec();
        }
        bytes.reverse();
        let mut encoded = [0; 32];
        encoded[32 - bytes.len()..].copy_from_slice(&bytes);
        self.update(&encoded)
    }

    fn commit_g1_point(&mut self, point: &G1serde) -> Result<(), &'static str> {
        for coordinate in [&point.0.x, &point.0.y] {
            let mut bytes = coordinate.to_bytes_le();
            while bytes.len() < 48 {
                bytes.push(0);
            }
            bytes.reverse();
            let mut part1 = [0; 32];
            part1[16..].copy_from_slice(&bytes[..16]);
            self.update(&part1)?;
            self.update(&bytes[16..48])?;
        }
        Ok(())
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
        self.commit_point("U", &proof.U);
        self.commit_point("V", &proof.V);
        self.commit_point("W", &proof.W);
        self.commit_point("Q_AX", &proof.Q_AX);
        self.commit_point("Q_AY", &proof.Q_AY);
        self.commit_point("B", &proof.B);
    }

    pub fn get_thetas(&mut self) -> Vec<ScalarField> {
        (0..3).map(|_| self.transcript.get_challenge()).collect()
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
    use super::*;

    #[test]
    fn malformed_formatted_proof_returns_an_error() {
        assert!(FormattedProof {
            proof_entries_part1: vec!["0x".to_string(); 38],
            proof_entries_part2: vec!["0x".to_string(); 42],
        }
        .try_recover_proof_from_format()
        .is_err());
    }

    #[test]
    fn malformed_formatted_preprocess_returns_an_error() {
        assert!(FormattedPreprocess {
            preprocess_entries_part1: vec!["0x".to_string(); 6],
            preprocess_entries_part2: vec!["0x".to_string(); 6],
        }
        .try_recover_proof_from_format()
        .is_err());
    }

    #[test]
    fn formatted_proof_and_preprocess_layouts_round_trip_exactly() {
        fn scalar_hex(value: u8) -> String {
            format!("0x{:064x}", value)
        }

        let proof = FormattedProof {
            proof_entries_part1: vec!["0x00000000000000000000000000000000".to_string(); 38],
            proof_entries_part2: (1..=42).map(scalar_hex).collect(),
        };
        let recovered_proof = proof
            .try_recover_proof_from_format()
            .expect("fixture proof must recover");
        let reformatted_proof = recovered_proof.convert_format_for_solidity_verifier();
        assert_eq!(
            reformatted_proof.proof_entries_part1,
            proof.proof_entries_part1
        );
        assert_eq!(
            reformatted_proof.proof_entries_part2,
            proof.proof_entries_part2
        );

        let preprocess = FormattedPreprocess {
            preprocess_entries_part1: vec!["0x00000000000000000000000000000000".to_string(); 6],
            preprocess_entries_part2: (1..=6).map(scalar_hex).collect(),
        };
        let recovered_preprocess = preprocess
            .try_recover_proof_from_format()
            .expect("fixture preprocess must recover");
        let reformatted_preprocess = recovered_preprocess.convert_format_for_solidity_verifier();
        assert_eq!(
            reformatted_preprocess.preprocess_entries_part1,
            preprocess.preprocess_entries_part1
        );
        assert_eq!(
            reformatted_preprocess.preprocess_entries_part2,
            preprocess.preprocess_entries_part2
        );
    }

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
        let actual = thetas
            .iter()
            .chain([&kappa0, &chi, &zeta, &kappa1])
            .map(|value| {
                value
                    .to_bytes_le()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
    }
}
