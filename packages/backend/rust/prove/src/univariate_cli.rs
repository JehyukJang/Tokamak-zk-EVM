//! Native artifact ingress for the univariate reference prover.

use crate::univariate::{
    engine::{Cpu, Engine, Icicle},
    prepare::prepare,
    prove as prove_protocol, ProverRandomizers, ProvingInput,
};
use crate::univariate_crs::ProverCrs;
use crate::{ProveError, ProveInputPaths};
use backend_interface::ProofBytes;
use libs::errors::{ArtifactError, CrsError};
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::SetupParams;
use libs::frontend_artifacts::{
    read_placement_selector, Instance, Permutation, PlacementVariables, SubcircuitInfo,
};
use libs::r1cs::SubcircuitR1CS;
use libs::univariate_relation::UnivariateSubcircuit;
use libs::utils::try_load_setup_params_from_qap_path;
use std::fs;
use std::path::PathBuf;

/// Loads the existing synthesizer artifacts into U8/U12/U27 without relying
/// on the legacy bivariate prover's compact-placement convention.
#[derive(clap::ValueEnum, Clone, Copy, Debug, Default)]
pub enum ProverDevice {
    #[default]
    Cpu,
    Cuda,
}

pub fn prove(paths: &ProveInputPaths<'_>, device: ProverDevice) -> Result<(), ProveError> {
    prove_with_validated_crs(paths, device, None)
}

pub fn prove_with_validated_crs(
    paths: &ProveInputPaths<'_>,
    device: ProverDevice,
    validated: Option<libs::subcircuit_library::ValidatedUnivariateCrsBytes>,
) -> Result<(), ProveError> {
    #[cfg(feature = "timing")]
    let loading = crate::timing::SpanGuard::new("univariate.library", "input", vec![]);
    let setup = try_load_setup_params_from_qap_path(paths.qap_path)?;
    let subcircuit_info_path = PathBuf::from(paths.qap_path).join("subcircuitInfo.json");
    let infos =
        SubcircuitInfo::read_box_from_json(subcircuit_info_path.clone()).map_err(|source| {
            ArtifactError::Read {
                artifact: "subcircuit information",
                path: subcircuit_info_path,
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
    let r1cs = infos
        .iter()
        .enumerate()
        .map(|(index, info)| {
            if info.id != index {
                return Err(ArtifactError::Invalid {
                    artifact: "subcircuit information",
                    path: PathBuf::from(paths.qap_path).join("subcircuitInfo.json"),
                    reason: format!("catalog entry {index} declares subcircuit ID {}", info.id),
                });
            }
            let path = PathBuf::from(paths.qap_path).join(format!("r1cs/subcircuit{index}.r1cs"));
            SubcircuitR1CS::from_r1cs_sparse_only(path.clone(), &setup, info).map_err(|source| {
                ArtifactError::Read {
                    artifact: "subcircuit R1CS",
                    path,
                    source,
                }
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let subcircuits = r1cs
        .iter()
        .zip(infos.iter())
        .map(|(r1cs, info)| r1cs.as_univariate_subcircuit(info))
        .collect::<Vec<_>>();
    let tau_path = PathBuf::from(paths.tau_sequence_path);
    let keys_path = PathBuf::from(paths.keys_path);
    #[cfg(feature = "timing")]
    drop(loading);
    #[cfg(feature = "timing")]
    let loading = crate::timing::SpanGuard::new("univariate.crs", "input", vec![]);
    let crs = match validated {
        Some(bytes) => ProverCrs::from_owned_bytes(bytes, &setup, &subcircuits, &public_layout),
        // Explicit development bypass and library callers retain their file ingress.
        None => ProverCrs::read(&tau_path, &keys_path, &setup, &subcircuits, &public_layout),
    }
    .map_err(|source| CrsError::Read {
        path: keys_path,
        source,
    })?;

    let selector_path = PathBuf::from(paths.synthesizer_path).join("selector.json");
    #[cfg(feature = "timing")]
    drop(loading);
    #[cfg(feature = "timing")]
    let loading = crate::timing::SpanGuard::new("univariate.fixture", "input", vec![]);
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
    let placement_path = PathBuf::from(paths.synthesizer_path).join("placementVariables.json");
    let placements =
        PlacementVariables::read_box_from_json(placement_path.clone()).map_err(|source| {
            ArtifactError::Read {
                artifact: "placement variables",
                path: placement_path,
                source,
            }
        })?;
    let instance_path = PathBuf::from(paths.synthesizer_path).join("instance.json");
    let instance =
        Instance::read_from_json(instance_path.clone()).map_err(|source| ArtifactError::Read {
            artifact: "public instance",
            path: instance_path,
            source,
        })?;

    #[cfg(feature = "timing")]
    drop(loading);
    match device {
        ProverDevice::Cpu => finish::<Cpu>(
            paths,
            &crs,
            &setup,
            &public_layout,
            &selector,
            &permutation,
            &placements,
            &instance,
            &subcircuits,
        ),
        ProverDevice::Cuda => finish::<Icicle>(
            paths,
            &crs,
            &setup,
            &public_layout,
            &selector,
            &permutation,
            &placements,
            &instance,
            &subcircuits,
        ),
    }
}
fn finish<E: Engine>(
    paths: &ProveInputPaths<'_>,
    crs: &ProverCrs,
    setup: &SetupParams,
    public_layout: &PublicWireLayout,
    selector: &[Option<usize>],
    permutation: &[Permutation],
    placements: &[PlacementVariables],
    instance: &Instance,
    subcircuits: &[UnivariateSubcircuit<'_>],
) -> Result<(), ProveError> {
    let prepared = crate::time_block!("univariate.maps", "prepare", {
        prepare::<E>(
            crs,
            setup,
            selector,
            permutation,
            placements,
            instance,
            subcircuits,
        )?
    });
    let randomizers = ProverRandomizers::sample();
    let (proof, _) = prove_protocol::<E>(ProvingInput {
        crs,
        setup,
        public_layout,
        selector,
        prepared: &prepared,
        randomizers: &randomizers,
    })?;
    let output_dir = PathBuf::from(paths.output_path);
    crate::time_block!("univariate.output", "output", {
        fs::create_dir_all(&output_dir).map_err(|source| ProveError::WriteOutput {
            path: output_dir.clone(),
            source,
        })?;
        let output_path = output_dir.join(ProofBytes::FILE_NAME);
        let bytes = proof.encode().map_err(|e| ProveError::WriteOutput {
            path: output_path.clone(),
            source: std::io::Error::other(e),
        })?;
        fs::write(&output_path, bytes).map_err(|source| ProveError::WriteOutput {
            path: output_path,
            source,
        })?;
    });
    Ok(())
}
