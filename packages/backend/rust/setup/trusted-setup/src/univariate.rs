//! U18--U21 construction entry point for the migrated trusted setup.

use crate::TrustedSetupError;
use icicle_bls12_381::curve::{
    BaseField, CurveCfg, G1Affine, G2Affine, G2BaseField, G2CurveCfg, ScalarField,
};
use icicle_core::curve::Curve;
use icicle_core::traits::{Arithmetic, FieldImpl, GenerateRandom};
use libs::crs_artifacts::{
    read_univariate_tau_sequence_with_digest, stage_univariate_specialized_key_artifacts,
    stage_univariate_tau_sequence_artifact,
};
use libs::crs_provenance::parse_development_univariate_tau_provenance;
use libs::errors::ArtifactError;
use libs::field_structures::Tau;
use libs::frontend_artifacts::public_wire_layout::{read_global_wires, PublicWireLayout};
use libs::frontend_artifacts::{SetupParams, SubcircuitInfo};
use libs::r1cs::SubcircuitR1CS;
use libs::subcircuit_library::{
    selected_subcircuit_library_provenance, write_development_only_univariate_keys_provenance,
    write_development_only_univariate_tau_provenance,
};
use libs::univariate_crs::{
    specialize_univariate_keys, UnivariateCrsShape, UnivariateRoleTrapdoor, UnivariateTauCapacity,
    UnivariateTauSequence,
};
#[cfg(test)]
use libs::univariate_crs::{UnivariateCrsError, UnivariateTrapdoor};
use rayon::prelude::*;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

#[cfg(test)]
pub(crate) fn build_u18_foundation(
    setup_params: &SetupParams,
    trapdoor: &UnivariateTrapdoor,
    g1: G1Affine,
    g2: G2Affine,
) -> Result<libs::univariate_crs::UnivariateCrsFoundation, UnivariateCrsError> {
    let shape = UnivariateCrsShape::from_setup_params(setup_params)?;
    libs::univariate_crs::UnivariateCrsFoundation::generate(shape, trapdoor, g1, g2)
}

pub struct Phase1Config<'a> {
    pub capacity: UnivariateTauCapacity,
    pub output_path: &'a str,
    pub fixed_tau: bool,
}

pub struct Phase2Config<'a> {
    pub qap_path: &'a str,
    pub tau_sequence_path: &'a str,
    pub tau_provenance_path: &'a str,
    pub output_path: &'a str,
    pub fixed_role_scalars: bool,
}

/// Standalone Phase 1: generates only the library-independent U22c terminal
/// sequences and commits them atomically.
pub fn run_phase_1(config: &Phase1Config<'_>) -> Result<(), TrustedSetupError> {
    let started = Instant::now();
    let (g1, g2, tau, xi, psi) = sample_tau_sequence_inputs(config.fixed_tau);
    let sequence = UnivariateTauSequence::generate(config.capacity, tau, xi, psi, g1, g2)?;
    let output_path = PathBuf::from(config.output_path);
    let (stage, digest) =
        stage_univariate_tau_sequence_artifact(&output_path, &sequence).map_err(|source| {
            TrustedSetupError::WriteOutput {
                path: output_path.clone(),
                source,
            }
        })?;
    write_development_only_univariate_tau_provenance(
        stage
            .staging_directory()
            .map_err(|source| TrustedSetupError::WriteOutput {
                path: output_path.clone(),
                source,
            })?,
        config.capacity,
        &digest,
    )
    .map_err(|source| TrustedSetupError::WriteOutput {
        path: output_path.clone(),
        source,
    })?;
    stage
        .activate()
        .map_err(|source| TrustedSetupError::WriteOutput {
            path: output_path,
            source,
        })?;
    println!(
        "Generated development-only tau sequence in {:.6} seconds",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

/// Standalone Phase 2: specializes an already persisted terminal sequence for
/// one selected subcircuit library and never regenerates Phase 1.
pub fn run_phase_2(config: &Phase2Config<'_>) -> Result<(), TrustedSetupError> {
    let started = Instant::now();
    let tau_path = PathBuf::from(config.tau_sequence_path);
    let provenance_path = PathBuf::from(config.tau_provenance_path);
    let provenance_bytes = fs::read(&provenance_path).map_err(|source| ArtifactError::Read {
        artifact: "tau-sequence provenance",
        path: provenance_path.clone(),
        source,
    })?;
    let provenance =
        parse_development_univariate_tau_provenance(&provenance_bytes).map_err(|reason| {
            ArtifactError::Invalid {
                artifact: "tau-sequence provenance",
                path: provenance_path.clone(),
                reason,
            }
        })?;
    let (tau_sequence, tau_digest) =
        read_univariate_tau_sequence_with_digest(&tau_path).map_err(|source| {
            libs::errors::CrsError::Read {
                path: tau_path.clone(),
                source,
            }
        })?;
    if hex::encode(tau_digest) != provenance.tau_sequence_rkyv_sha256
        || provenance.terminal_capacity.l0 != tau_sequence.capacity.l0
        || provenance.terminal_capacity.l_xi != tau_sequence.capacity.l_xi
        || provenance.terminal_capacity.l_psi != tau_sequence.capacity.l_psi
        || provenance.terminal_capacity.l2 != tau_sequence.capacity.l2
    {
        return Err(ArtifactError::Invalid {
            artifact: "tau-sequence provenance",
            path: provenance_path,
            reason: "does not describe the selected tau_sequence.rkyv".to_string(),
        }
        .into());
    }

    let input_started = Instant::now();
    let qap_path = PathBuf::from(config.qap_path);
    let setup_params_path = qap_path.join("setupParams.json");
    let setup_params =
        SetupParams::read_from_json(setup_params_path.clone()).map_err(|source| {
            ArtifactError::Read {
                artifact: "setup parameters",
                path: setup_params_path,
                source,
            }
        })?;
    let shape = UnivariateCrsShape::from_setup_params(&setup_params)?;

    let subcircuit_infos_path = qap_path.join("subcircuitInfo.json");
    let global_wire_list_path = qap_path.join("globalWireList.json");
    let (subcircuit_infos, global_wires) = rayon::join(
        || {
            SubcircuitInfo::read_box_from_json(subcircuit_infos_path.clone()).map_err(|source| {
                ArtifactError::Read {
                    artifact: "subcircuit information",
                    path: subcircuit_infos_path,
                    source,
                }
            })
        },
        || {
            read_global_wires(&global_wire_list_path).map_err(|source| ArtifactError::Read {
                artifact: "global wire list",
                path: global_wire_list_path.clone(),
                source,
            })
        },
    );
    let subcircuit_infos = subcircuit_infos?;
    let global_wires = global_wires?;
    let public_wire_layout =
        PublicWireLayout::derive(&setup_params, &global_wires, &subcircuit_infos).map_err(
            |error| ArtifactError::Invalid {
                artifact: "public wire layout",
                path: global_wire_list_path,
                reason: error.to_string(),
            },
        )?;

    let r1cs = subcircuit_infos
        .par_iter()
        .enumerate()
        .map(|(index, subcircuit_info)| {
            if subcircuit_info.id != index {
                return Err(ArtifactError::Invalid {
                    artifact: "subcircuit information",
                    path: qap_path.join("subcircuitInfo.json"),
                    reason: format!(
                        "catalog entry {index} declares subcircuit ID {}",
                        subcircuit_info.id
                    ),
                });
            }
            let path = qap_path.join(format!("r1cs/subcircuit{index}.r1cs"));
            SubcircuitR1CS::from_r1cs_sparse_only(path.clone(), &setup_params, subcircuit_info)
                .map_err(|source| ArtifactError::Read {
                    artifact: "subcircuit R1CS",
                    path,
                    source,
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let subcircuits = r1cs
        .iter()
        .zip(subcircuit_infos.iter())
        .map(|(r1cs, subcircuit_info)| r1cs.as_univariate_subcircuit(subcircuit_info))
        .collect::<Vec<_>>();
    println!(
        "Loaded and validated univariate setup inputs in {:.6} seconds",
        input_started.elapsed().as_secs_f64(),
    );

    tau_sequence.admits_shape(&shape)?;
    let role_trapdoor = if config.fixed_role_scalars {
        let fixed = Tau::gen_fixed();
        UnivariateRoleTrapdoor::new(fixed.gamma, fixed.eta, fixed.delta)?
    } else {
        UnivariateRoleTrapdoor::sample()
    };
    let generation_started = Instant::now();
    let (prover_keys, verifier_keys) = specialize_univariate_keys(
        &setup_params,
        &public_wire_layout,
        &subcircuits,
        &tau_sequence,
        &role_trapdoor,
    )?;
    println!(
        "Generated in-memory univariate CRS in {:.6} seconds",
        generation_started.elapsed().as_secs_f64(),
    );
    let output_path = PathBuf::from(config.output_path);
    let artifact_started = Instant::now();
    let (stage, digests) = stage_univariate_specialized_key_artifacts(
        &output_path,
        &prover_keys,
        &verifier_keys,
        tau_digest,
    )
    .map_err(|source| TrustedSetupError::WriteOutput {
        path: output_path.clone(),
        source,
    })?;
    let library_provenance =
        selected_subcircuit_library_provenance(&qap_path).map_err(|source| {
            TrustedSetupError::WriteOutput {
                path: output_path.clone(),
                source,
            }
        })?;
    write_development_only_univariate_keys_provenance(
        stage
            .staging_directory()
            .map_err(|source| TrustedSetupError::WriteOutput {
                path: output_path.clone(),
                source,
            })?,
        &hex::encode(tau_digest),
        library_provenance,
        &digests,
    )
    .map_err(|source| TrustedSetupError::WriteOutput {
        path: output_path.clone(),
        source,
    })?;
    stage
        .activate()
        .map_err(|source| TrustedSetupError::WriteOutput {
            path: output_path,
            source,
        })?;
    println!(
        "Serialized and activated univariate CRS artifacts in {:.6} seconds",
        artifact_started.elapsed().as_secs_f64(),
    );
    println!(
        "Generated development-only library-specialized keys in {:.6} seconds",
        started.elapsed().as_secs_f64()
    );
    Ok(())
}

fn sample_tau_sequence_inputs(
    fixed_tau: bool,
) -> (G1Affine, G2Affine, ScalarField, ScalarField, ScalarField) {
    if fixed_tau {
        println!("Using hardcoded generators and development trapdoor");
        let g1 = G1Affine::from_limbs(
            BaseField::from_hex("0x0b001b4cc05fa01578be7d4e821d6ff58f2a05c584fba3cb31a37942dece65eadec9a878add2282f7c2513abb8d4ab05").into(),
            BaseField::from_hex("0x15e237775397ed22eef43dd36cdca277c9cf6fa7e4ffff0a5bb4b20a82392caacf0f63fb6cdb02bccf2f5af14970d6b9").into(),
        );
        let g2 = G2Affine::from_limbs(
            G2BaseField::from_hex("0x1116094a7c01d4fd8abcfea69c658c92c037765bee00556b8d4063c33540b316ac68a2d913d3adc3b43c7d7cc7505cfc17206c8ae661f247979b3f1daa7fb6d5f7ce9c17b5ed1d7e8b421a2508b3f09a603e6a5fab3fcde7364fd178d656ac36").into(),
            G2BaseField::from_hex("0x15bf297a4b9842fb1a3a6f2dbf6b94de06997b11b2f72436c22efbb48d2f74b0de7239ea182a2ee50c23ae3d0be6fdee09459611409874fe4b04b1a7e42cb84eb4ae01728dc55dbd1343fda8d0fe94a299fc757acc1d2602a49a005b4ff90190").into(),
        );
        let tau = Tau::gen_fixed();
        // This route is development-only. Reuse the fixed test trapdoor to
        // derive deterministic nonzero xi and psi values without treating the
        // resulting CRS as ceremony output.
        return (g1, g2, tau.x, tau.alpha, tau.alpha.pow(2));
    }
    (
        CurveCfg::generate_random_affine_points(1)[0],
        G2CurveCfg::generate_random_affine_points(1)[0],
        nonzero_scalar(),
        nonzero_scalar(),
        nonzero_scalar(),
    )
}

fn nonzero_scalar() -> ScalarField {
    loop {
        let value = icicle_bls12_381::curve::ScalarCfg::generate_random(1)[0];
        if value != ScalarField::zero() {
            return value;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::build_u18_foundation;
    use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg};
    use icicle_core::curve::Curve;
    use libs::frontend_artifacts::SetupParams;
    use libs::univariate_crs::{UnivariateCrsShape, UnivariateTrapdoor};

    fn small_setup_params() -> SetupParams {
        SetupParams {
            l_free: 0,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 4,
            n: 2,
            m: 2,
            t: 4,
            s_D: 2,
            s_max: 2,
        }
    }

    #[test]
    fn trusted_setup_private_path_constructs_u18_only() {
        let params = small_setup_params();
        let shape = UnivariateCrsShape::from_setup_params(&params)
            .expect("small setup parameters must define a univariate CRS shape");
        let trapdoor = UnivariateTrapdoor::sample(&shape)
            .expect("a valid univariate trapdoor must be sampleable");
        let foundation = build_u18_foundation(
            &params,
            &trapdoor,
            CurveCfg::generate_random_affine_points(1)[0],
            G2CurveCfg::generate_random_affine_points(1)[0],
        )
        .expect("trusted setup must construct the private U18 foundation");

        assert_eq!(foundation.s0_g1.len(), shape.declared_capacity[0] + 1);
        assert_eq!(foundation.sxi_g1.len(), shape.declared_capacity[1] + 1);
        assert_eq!(foundation.spsi_g1.len(), shape.declared_capacity[2] + 1);
    }
}
