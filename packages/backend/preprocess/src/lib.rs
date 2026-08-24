#![allow(non_snake_case)]
use libs::cli::CliDiagnostic;
use libs::crs_artifacts::ArchivedSigmaPreprocessRkyv;
use libs::errors::{ArtifactError, CrsError, DeviceError};
use libs::frontend_artifacts::{Instance, Permutation, SetupParams};
use libs::proof_protocol::Preprocess;
use libs::utils::{
    init_ntt_domain, prover_verifier_ntt_domain_size, setup_shape, validate_setup_shape,
};
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
                "Use a CRS whose compatible backend version matches the selected subcircuit library, or use the explicit local development bypass only for local testing."
            }
            Self::Device(_) => "Check the ICICLE backend installation and the selected device.",
            Self::WriteOutput { .. } => {
                "Create or grant write access to the requested output directory, then retry."
            }
        }
    }
}

pub fn generate_preprocess(
    sigma: &ArchivedSigmaPreprocessRkyv,
    permutation_raw: &[Permutation],
    instance: &Instance,
    setup_params: &SetupParams,
) -> Preprocess {
    let shape = setup_shape(setup_params);
    validate_setup_shape(&shape);
    let m_i = shape.m_i;
    let s_max = shape.s_max;
    let ntt_domain_size = prover_verifier_ntt_domain_size(&shape);
    init_ntt_domain(ntt_domain_size);
    println!("Converting the permutation matrices into polynomials s^0 and s^1...");
    let (mut s0XY, mut s1XY) = Permutation::to_poly(permutation_raw, m_i, s_max);
    let s0 = sigma.sigma_1.encode_poly(&mut s0XY, setup_params);
    let s1 = sigma.sigma_1.encode_poly(&mut s1XY, setup_params);
    let O_pub_fix = sigma
        .sigma_1
        .encode_O_pub_fix(&instance.a_pub_function, setup_params);
    Preprocess { s0, s1, O_pub_fix }
}
