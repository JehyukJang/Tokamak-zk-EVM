#![allow(non_snake_case)]
use libs::cli::CliDiagnostic;
use libs::errors::{ArtifactError, CrsError, DeviceError};
use libs::group_structures::G1serde;
use libs::iotools::ArchivedSigmaPreprocessRkyv;
use libs::iotools::*;
use libs::utils::{
    init_ntt_domain, prover_verifier_ntt_domain_size, setup_shape, validate_setup_shape,
};
use libs::{impl_read_from_json, impl_write_into_json, split_push};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

pub struct PreprocessInputPaths<'a> {
    pub qap_path: &'a str,
    pub synthesizer_path: &'a str,
    pub setup_path: &'a str,
    pub output_path: &'a str,
}

#[derive(Debug, Error)]
pub enum PreprocessError {
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    Crs(#[from] CrsError),
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error("failed to write preprocess output at {}: {source}", path.display())]
    WriteOutput {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl CliDiagnostic for PreprocessError {
    fn hint(&self) -> &'static str {
        match self {
            Self::Artifact(_) => {
                "Regenerate the frontend artifacts and provide the matching synthesizer directory."
            }
            Self::Crs(_) => {
                "Use a compatible release CRS, or use the explicit local development bypass only for local testing."
            }
            Self::Device(_) => "Check the ICICLE backend installation and the selected device.",
            Self::WriteOutput { .. } => {
                "Create or grant write access to the requested output directory, then retry."
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Preprocess {
    pub s0: G1serde,
    pub s1: G1serde,
    pub O_pub_fix: G1serde,
}

impl Preprocess {
    pub fn gen(
        sigma: &ArchivedSigmaPreprocessRkyv,
        permutation_raw: &[Permutation],
        instance: &Instance,
        setup_params: &SetupParams,
    ) -> Self {
        let shape = setup_shape(setup_params);
        validate_setup_shape(&shape);
        let m_i = shape.m_i;
        let s_max = shape.s_max;
        let ntt_domain_size = prover_verifier_ntt_domain_size(&shape);
        init_ntt_domain(ntt_domain_size);
        // Generating permutation polynomials
        println!("Converting the permutation matrices into polynomials s^0 and s^1...");
        let (mut s0XY, mut s1XY) = Permutation::to_poly(permutation_raw, m_i, s_max);
        let s0 = sigma.sigma_1.encode_poly(&mut s0XY, &setup_params);
        let s1 = sigma.sigma_1.encode_poly(&mut s1XY, &setup_params);
        let O_pub_fix = sigma
            .sigma_1
            .encode_O_pub_fix(&instance.a_pub_function, setup_params);

        return Preprocess { s0, s1, O_pub_fix };
    }

    pub fn convert_format_for_solidity_verifier(&self) -> FormattedPreprocess {
        // Formatting the preprocess for the Solidity verifier
        // Part1 is a tuple of hex strings of the first 16 bytes of each preprocess component
        let mut preprocess_entries_part1 = Vec::<String>::new();
        // Part2 is a tuple of hex strings of the last 32 bytes of each preprocess component
        let mut preprocess_entries_part2 = Vec::<String>::new();

        // Process
        split_push!(
            preprocess_entries_part1,
            preprocess_entries_part2,
            &self.s0,
            &self.s1,
            &self.O_pub_fix,
        );
        return FormattedPreprocess {
            preprocess_entries_part1,
            preprocess_entries_part2,
        };
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
        let p1 = &self.preprocess_entries_part1;
        let p2 = &self.preprocess_entries_part2;

        const G1_CNT: usize = 3; // The number of G1 points
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

        let s0 = try_next_point(0, p1, p2)?;
        let s1 = try_next_point(2, p1, p2)?;
        let O_pub_fix = try_next_point(4, p1, p2)?;

        Ok(Preprocess {
            s0,
            s1,
            O_pub_fix,
            // O_function_inst,
            // O_block_inst,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::FormattedPreprocess;

    #[test]
    fn malformed_formatted_preprocess_returns_an_error() {
        let formatted = FormattedPreprocess {
            preprocess_entries_part1: vec!["0x".to_string(); 6],
            preprocess_entries_part2: vec!["0x".to_string(); 6],
        };

        assert!(formatted.try_recover_proof_from_format().is_err());
    }
}
