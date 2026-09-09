//! Online-only native verifier ingress for the univariate proof family.

use crate::{verify_univariate_proof, OnlineVerifyInputPaths, VerifyError};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use libs::errors::ArtifactError;
use libs::frontend_artifacts::Instance;
use libs::univariate_preprocess::AdmittedUnivariateVerifierConfig;
use libs::univariate_proof::UnivariateProof;
use std::fs::File;
use std::path::PathBuf;

/// Verifies one proof against a configuration previously admitted by native
/// preprocess. This path deliberately has no access to the circuit library,
/// selector, permutation, or CRS archives.
pub fn verify(paths: &OnlineVerifyInputPaths<'_>) -> Result<bool, VerifyError> {
    let config_path = PathBuf::from(paths.verifier_config_path);
    let config: AdmittedUnivariateVerifierConfig =
        read_json(&config_path, "admitted verifier configuration")?;

    let instance_path = PathBuf::from(paths.instance_path);
    let instance =
        Instance::read_from_json(instance_path.clone()).map_err(|source| ArtifactError::Read {
            artifact: "public instance",
            path: instance_path,
            source,
        })?;
    let public_inputs = collect_public_inputs(&instance);
    config
        .validate_for_online_verification(public_inputs.len())
        .map_err(|reason| VerifyError::InvalidFormat {
            artifact: "admitted verifier configuration",
            path: config_path,
            reason,
        })?;

    let proof_path = PathBuf::from(paths.proof_path);
    let proof: UnivariateProof = read_json(&proof_path, "univariate proof")?;
    Ok(verify_univariate_proof(&config, &public_inputs, &proof))
}

fn collect_public_inputs(instance: &Instance) -> Vec<ScalarField> {
    instance
        .a_pub_user
        .iter()
        .chain(instance.a_pub_block.iter())
        .chain(instance.a_pub_function.iter())
        .map(|value| ScalarField::from_hex(value.as_ref()))
        .collect()
}

fn read_json<T: serde::de::DeserializeOwned>(
    path: &PathBuf,
    artifact: &'static str,
) -> Result<T, VerifyError> {
    let file = File::open(path).map_err(|source| ArtifactError::Read {
        artifact,
        path: path.clone(),
        source,
    })?;
    serde_json::from_reader(file).map_err(|source| {
        ArtifactError::Parse {
            artifact,
            path: path.clone(),
            source,
        }
        .into()
    })
}
