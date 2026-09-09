//! Native verifier ingress for the univariate proof family.

use crate::{verify_univariate_proof, VerifyError, VerifyInputPaths};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::FieldImpl;
use libs::crs_artifacts::{
    read_univariate_tau_sequence_with_digest, read_univariate_verifier_keys,
    TAU_SEQUENCE_RKYV_FILE_NAME, VERIFIER_KEYS_RKYV_FILE_NAME,
};
use libs::errors::{ArtifactError, CrsError};
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::{read_placement_selector, Instance, Permutation, SubcircuitInfo};
use libs::group_structures::G1serde;
use libs::univariate_preprocess::UnivariatePreprocess;
use libs::univariate_proof::UnivariateProof;
use libs::univariate_relation::{connection_permutation_polynomial, placement_selector_polynomial};
use libs::utils::try_load_setup_params_from_qap_path;
use std::path::PathBuf;

/// Admits the fixed `(CRS, library, selector, permutation, preprocess)`
/// configuration, then verifies one F5 proof whose adaptive statement is the
/// supplied public-input vector.
pub fn verify(paths: &VerifyInputPaths<'_>) -> Result<bool, VerifyError> {
    let setup = try_load_setup_params_from_qap_path(paths.qap_path)?;
    let info_path = PathBuf::from(paths.qap_path).join("subcircuitInfo.json");
    let infos = SubcircuitInfo::read_box_from_json(info_path.clone()).map_err(|source| {
        ArtifactError::Read {
            artifact: "subcircuit information",
            path: info_path,
            source,
        }
    })?;
    let global_wire_path = PathBuf::from(paths.qap_path).join("globalWireList.json");
    let global_wires =
        read_global_wires(&global_wire_path).map_err(|source| ArtifactError::Read {
            artifact: "global wire list",
            path: global_wire_path.clone(),
            source,
        })?;
    let public_layout =
        PublicWireLayout::derive(&setup, &global_wires, &infos).map_err(|error| {
            ArtifactError::Invalid {
                artifact: "public wire layout",
                path: global_wire_path,
                reason: error.to_string(),
            }
        })?;
    let crs_directory = PathBuf::from(paths.setup_path);
    let tau_path = crs_directory.join(TAU_SEQUENCE_RKYV_FILE_NAME);
    let (tau_sequence, tau_digest) = read_univariate_tau_sequence_with_digest(&tau_path, &setup)
        .map_err(|source| CrsError::Read {
            path: tau_path,
            source,
        })?;
    let crs_path = crs_directory.join(VERIFIER_KEYS_RKYV_FILE_NAME);
    let crs = read_univariate_verifier_keys(&crs_directory, &setup, &public_layout, tau_digest)
        .map_err(|source| CrsError::Read {
            path: crs_path,
            source,
        })?;
    if tau_sequence.shape != crs.shape {
        return Err(VerifyError::InvalidFormat {
            artifact: "univariate CRS",
            path: PathBuf::from(paths.setup_path),
            reason: "tau sequence and verifier keys have different shapes".to_string(),
        });
    }
    let selector_path = PathBuf::from(paths.synthesizer_path).join("selector.json");
    let selector =
        read_placement_selector(&selector_path, setup.s_max, setup.s_D).map_err(|source| {
            ArtifactError::Read {
                artifact: "placement selector",
                path: selector_path,
                source,
            }
        })?;
    let permutation_path = PathBuf::from(paths.synthesizer_path).join("permutation.json");
    let permutation =
        Permutation::read_box_from_json(permutation_path.clone()).map_err(|source| {
            ArtifactError::Read {
                artifact: "permutation",
                path: permutation_path,
                source,
            }
        })?;
    let expected_preprocess = UnivariatePreprocess::new(
        tau_sequence.commit_strided_polynomial(&placement_selector_polynomial(
            &tau_sequence.shape,
            &setup,
            &selector,
        )?)?,
        tau_sequence.commit_dense_polynomial(
            &connection_permutation_polynomial(&tau_sequence.shape, &setup, &permutation)?
                .coefficients,
        )?,
    );
    let preprocess_path = PathBuf::from(paths.preprocess_path).join("preprocess.json");
    let preprocess: UnivariatePreprocess =
        serde_json::from_reader(std::fs::File::open(&preprocess_path).map_err(|source| {
            ArtifactError::Read {
                artifact: "univariate preprocess",
                path: preprocess_path.clone(),
                source,
            }
        })?)
        .map_err(|source| ArtifactError::Parse {
            artifact: "univariate preprocess",
            path: preprocess_path.clone(),
            source,
        })?;
    if preprocess != expected_preprocess {
        return Err(VerifyError::InvalidFormat {
            artifact: "univariate preprocess",
            path: preprocess_path,
            reason: "does not match the admitted selector and permutation".to_string(),
        });
    }
    let instance_path = PathBuf::from(paths.synthesizer_path).join("instance.json");
    let instance =
        Instance::read_from_json(instance_path.clone()).map_err(|source| ArtifactError::Read {
            artifact: "public instance",
            path: instance_path,
            source,
        })?;
    let public_inputs = collect_public_inputs(&instance, &setup)?;
    let public_binding = build_public_binding(&crs, &public_layout, &public_inputs)?;
    let proof_path = PathBuf::from(paths.proof_path).join("univariate_proof.json");
    let proof: UnivariateProof =
        serde_json::from_reader(std::fs::File::open(&proof_path).map_err(|source| {
            ArtifactError::Read {
                artifact: "univariate proof",
                path: proof_path.clone(),
                source,
            }
        })?)
        .map_err(|source| ArtifactError::Parse {
            artifact: "univariate proof",
            path: proof_path,
            source,
        })?;
    Ok(verify_univariate_proof(
        &crs,
        &preprocess,
        public_binding,
        &public_inputs,
        &proof,
    ))
}

fn collect_public_inputs(
    instance: &Instance,
    setup: &libs::frontend_artifacts::SetupParams,
) -> Result<Vec<ScalarField>, VerifyError> {
    let values = instance
        .a_pub_user
        .iter()
        .chain(instance.a_pub_block.iter())
        .chain(instance.a_pub_function.iter())
        .map(|value| ScalarField::from_hex(value.as_ref()))
        .collect::<Vec<_>>();
    if values.len() != setup.l {
        return Err(VerifyError::InvalidFormat {
            artifact: "public instance",
            path: PathBuf::from("instance.json"),
            reason: format!("has {} values, expected {}", values.len(), setup.l),
        });
    }
    Ok(values)
}

fn build_public_binding(
    crs: &libs::univariate_crs::UnivariateVerifierKeys,
    layout: &PublicWireLayout,
    public_inputs: &[ScalarField],
) -> Result<G1serde, VerifyError> {
    if layout.len() != public_inputs.len() {
        return Err(VerifyError::InvalidFormat {
            artifact: "public instance",
            path: PathBuf::from("instance.json"),
            reason: "does not match the fixed public-wire layout".to_string(),
        });
    }
    let index = crs.query_index();
    let mut binding = G1serde::zero();
    for (global_wire_index, value) in public_inputs.iter().copied().enumerate() {
        let Some(key) = layout.public_query_key_for_public_wire(global_wire_index) else {
            continue;
        };
        let query = index
            .public_index(key)
            .and_then(|query_index| crs.gamma_inv_public_queries.get(query_index))
            .ok_or_else(|| VerifyError::InvalidFormat {
                artifact: "univariate CRS",
                path: PathBuf::from(VERIFIER_KEYS_RKYV_FILE_NAME),
                reason: format!(
                    "is missing public query ({}, {})",
                    key.buffer_subcircuit_id, key.local_public_wire_index
                ),
            })?;
        binding = binding + query.point * value;
    }
    Ok(binding)
}
