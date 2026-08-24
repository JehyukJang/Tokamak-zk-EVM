use crate::contributor::{get_device_info, ContributorInfo};
use crate::flows::MpcSetupError;
use crate::sigma::{AaccExt, SigmaV2, HASH_BYTES_LEN};
use crate::utils::{
    hash_sigma, initialize_random_generator_with_seed_input, pok, Mode, Phase2Proof,
    RandomGenerator, StepTimer,
};
use chrono::Local;
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::{Arithmetic, FieldImpl};
use libs::group_structures::G1serde;
use rayon::prelude::*;
use std::fs::File;
use std::io;
use std::io::{BufWriter, Write};
use std::ops::Mul;
use std::path::PathBuf;
use std::time::Instant;

const CONTRIBUTOR_FILE_FORMAT: &str = "phase2_contributor_{}.txt";

#[derive(Debug, Clone)]
pub struct Phase2NextContributorConfig {
    pub outfolder: String,
    pub beacon_mode: bool,
    pub contributor_index: usize,
    pub random_seed_input: Option<String>,
}
pub fn run(config: &Phase2NextContributorConfig) -> Result<(), MpcSetupError> {
    let mut timer = StepTimer::new("phase2_next_contributor");
    let start = Instant::now();
    let mode = ceremony_mode(config.beacon_mode);
    let mut rng =
        initialize_random_generator_with_seed_input(&mode, config.random_seed_input.as_deref());
    timer.log_step("collect contributor metadata and initialize randomness");

    let previous_index =
        config
            .contributor_index
            .checked_sub(1)
            .ok_or_else(|| MpcSetupError::State {
                phase: "phase-2 next contributor",
                reason: "contributor index must be greater than zero".to_string(),
            })?;
    let latest_acc = load_phase2_accumulator(&config.outfolder, previous_index)?;
    let latest_y = latest_acc
        .public_phase2_y()
        .map_err(|reason| MpcSetupError::State {
            phase: "phase-2 next contributor",
            reason: format!("phase-2 accumulator must disclose y: {reason}"),
        })?;
    let latest_s = latest_acc
        .sigma
        .sigma_1
        .eta_inv_li_o_inter_alpha4_kj
        .first()
        .map(|row| row.len())
        .filter(|len| *len > 0)
        .or_else(|| {
            latest_acc
                .sigma
                .sigma_1
                .delta_inv_li_o_prv
                .first()
                .map(|row| row.len())
                .filter(|len| *len > 0)
        })
        .ok_or_else(|| MpcSetupError::State {
            phase: "phase-2 next contributor",
            reason: "phase-2 accumulator shape must reveal s_max".to_string(),
        })?;
    if latest_y.pow(latest_s) == icicle_bls12_381::curve::ScalarField::one()
        || latest_acc.sigma.sigma_1.y != latest_acc.sigma.G * latest_y
        || latest_acc.sigma.sigma_2.y != latest_acc.sigma.H * latest_y
    {
        return Err(MpcSetupError::State {
            phase: "phase-2 next contributor",
            reason: "phase-2 accumulator has inconsistent disclosed y state".to_string(),
        });
    }
    timer.log_step("load latest accumulator and validate disclosed y");

    println!("loading current challenge and proof...");
    println!("latest contributor index: {}", latest_acc.contributor_index);
    println!(
        "verified disclosed phase-2 y {}",
        latest_acc
            .public_y_hex
            .as_deref()
            .ok_or_else(|| MpcSetupError::State {
                phase: "phase-2 next contributor",
                reason: "validated phase-2 y must be disclosed".to_string(),
            })?
    );

    let mut previous_hashes = vec![];
    previous_hashes.push(latest_acc.blake2b_hash());
    if latest_acc.contributor_index > 1 {
        verify_latest_contribution(&config.outfolder, &latest_acc)?;

        let proof_file_str = &format!(
            "{}/phase2_proof_{}.json",
            config.outfolder,
            latest_acc.contributor_index - 1
        );
        let prev_proof =
            Phase2Proof::read_from_json(proof_file_str).map_err(|source| MpcSetupError::Io {
                operation: "read previous phase-2 proof",
                path: PathBuf::from(proof_file_str),
                source,
            })?;
        previous_hashes.push(prev_proof.blake2b_hash());
    } else {
        println!("previous contributor is genesis");
        previous_hashes.push([0u8; HASH_BYTES_LEN]);
    }
    timer.log_step("verify previous contribution");

    println!("computing new challenge and proof...");
    let (new_acc, new_proof) = compute_new_sigma(&mut rng, &latest_acc);
    timer.log_step("compute new accumulator and proof");

    verify_and_save_results(&config.outfolder, &latest_acc, &new_acc, &new_proof)?;
    timer.log_step("verify new proof and save results");
    save_contributor_info(&previous_hashes, &start, &config, &new_acc, &new_proof).map_err(
        |source| MpcSetupError::Io {
            operation: "write phase-2 contributor information",
            path: PathBuf::from(format!(
                "{}/phase2_contributor_{}.txt",
                config.outfolder, new_acc.contributor_index
            )),
            source,
        },
    )?;
    timer.log_step("write contributor info");
    timer.log_total();
    println!("Time elapsed: {:?}", start.elapsed().as_secs_f64());
    println!("thanks for your contribution...");
    Ok(())
}

fn ceremony_mode(beacon_mode: bool) -> Mode {
    if beacon_mode {
        Mode::Beacon
    } else {
        Mode::Random
    }
}
fn save_contributor_info(
    previous_hashes: &Vec<[u8; HASH_BYTES_LEN]>,
    start_time: &Instant,
    config: &Phase2NextContributorConfig,
    acc: &SigmaV2,
    proof: &Phase2Proof,
) -> io::Result<()> {
    let info = create_contributor_info(previous_hashes, start_time, acc, proof);
    let file_path = format!(
        "{}/{}",
        config.outfolder,
        CONTRIBUTOR_FILE_FORMAT.replace("{}", &acc.contributor_index.to_string())
    );

    let file = File::create(file_path)?;
    let mut writer = BufWriter::new(file);
    writer.write_all(info.to_string().as_bytes())?;

    Ok(())
}

fn create_contributor_info(
    previous_hashes: &Vec<[u8; HASH_BYTES_LEN]>,
    start_time: &Instant,
    acc: &SigmaV2,
    proof: &Phase2Proof,
) -> ContributorInfo {
    println!(
        "Total time elapsed: {:?}",
        start_time.elapsed().as_secs_f64()
    );
    ContributorInfo {
        contributor_no: acc.contributor_index as u32,
        date: Local::now().format("%Y-%m-%d").to_string(),
        name: String::new(),
        location: String::new(),
        devices: get_device_info().to_string(),
        prev_acc_hash: hex::encode(previous_hashes[0]),
        prev_proof_hash: hex::encode(previous_hashes[1]),
        current_acc_hash: hex::encode(acc.blake2b_hash()),
        current_proof_hash: hex::encode(proof.blake2b_hash()),
        time_taken_seconds: start_time.elapsed().as_secs_f64(),
    }
}

fn verify_latest_contribution(
    outfolder: &str,
    latest_sigma: &SigmaV2,
) -> Result<(), MpcSetupError> {
    let previous_index = latest_sigma
        .contributor_index
        .checked_sub(1)
        .ok_or_else(|| MpcSetupError::State {
            phase: "phase-2 next contributor",
            reason: "latest contributor index must be greater than zero".to_string(),
        })?;
    let prev_sigma = load_phase2_accumulator(outfolder, previous_index)?;

    let proof_file_str = &format!(
        "{}/phase2_proof_{}.json",
        outfolder, latest_sigma.contributor_index
    );
    let latest_proof =
        Phase2Proof::read_from_json(proof_file_str).map_err(|source| MpcSetupError::Io {
            operation: "read latest phase-2 proof",
            path: PathBuf::from(proof_file_str),
            source,
        })?;

    println!("verification of latest proof is started...");
    latest_proof
        .verify(&prev_sigma, &latest_sigma)
        .map_err(|error| MpcSetupError::State {
            phase: "phase-2 next contributor",
            reason: format!("latest phase-2 proof verification failed: {error}"),
        })?;
    println!("verification of latest proof is succeeded...");
    Ok(())
}

fn load_phase2_accumulator(
    outfolder: &str,
    contributor_index: usize,
) -> Result<SigmaV2, MpcSetupError> {
    let path = format!("{}/phase2_acc_{}.rkyv", outfolder, contributor_index);
    SigmaV2::read_phase2_acc(&path).map_err(|source| MpcSetupError::Io {
        operation: "read phase-2 accumulator",
        path: PathBuf::from(path),
        source,
    })
}

fn verify_and_save_results(
    outfolder: &str,
    latest_sigma: &SigmaV2,
    new_sigma: &SigmaV2,
    new_proof: &Phase2Proof,
) -> Result<(), MpcSetupError> {
    new_proof
        .verify(latest_sigma, new_sigma)
        .map_err(|error| MpcSetupError::State {
            phase: "phase-2 next contributor",
            reason: format!("new phase-2 proof verification failed: {error}"),
        })?;

    let accumulator_path = format!(
        "{}/phase2_acc_{}.rkyv",
        outfolder, new_sigma.contributor_index
    );
    new_sigma
        .write_phase2_acc(&accumulator_path)
        .map_err(|source| MpcSetupError::Io {
            operation: "write new phase-2 accumulator",
            path: PathBuf::from(accumulator_path),
            source,
        })?;

    let proof_path = format!(
        "{}/phase2_proof_{}.json",
        outfolder, new_sigma.contributor_index
    );
    Phase2Proof::write_into_json(new_proof, &proof_path).map_err(|source| MpcSetupError::Io {
        operation: "write new phase-2 proof",
        path: PathBuf::from(proof_path),
        source,
    })?;
    Ok(())
}

fn scale_g1_slice(points: &[G1serde], scalar: ScalarField) -> Box<[G1serde]> {
    points
        .par_iter()
        .map(|point| point.mul(scalar))
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

fn scale_g1_matrix(rows: &[Box<[G1serde]>], scalar: ScalarField) -> Box<[Box<[G1serde]>]> {
    rows.par_iter()
        .map(|row| {
            row.iter()
                .map(|point| point.mul(scalar))
                .collect::<Vec<_>>()
                .into_boxed_slice()
        })
        .collect::<Vec<_>>()
        .into_boxed_slice()
}

fn compute_new_sigma(rng: &mut RandomGenerator, sigma_old: &SigmaV2) -> (SigmaV2, Phase2Proof) {
    let delta = rng.next_random();
    let gamma = rng.next_random();
    let eta = rng.next_random();

    let delta_inv = delta.inv();
    let gamma_inv = gamma.inv();
    let eta_inv = eta.inv();

    let v = hash_sigma(&sigma_old);
    let phase2Proof = Phase2Proof {
        contributor_index: sigma_old.contributor_index + 1,
        v: v.to_vec(),
        delta_t_g1: sigma_old.sigma.G.mul(delta),
        gamma_t_g1: sigma_old.sigma.G.mul(gamma),
        eta_t_g1: sigma_old.sigma.G.mul(eta),
        pok_delta: pok(&sigma_old.sigma.G, delta, &v),
        pok_gamma: pok(&sigma_old.sigma.G, gamma, &v),
        pok_eta: pok(&sigma_old.sigma.G, eta, &v),
        delta_t_g2: sigma_old.sigma.H.mul(delta),
        gamma_t_g2: sigma_old.sigma.H.mul(gamma),
        eta_t_g2: sigma_old.sigma.H.mul(eta),
    };

    let (gamma_inv_o_inst, tail_terms) = rayon::join(
        || scale_g1_slice(&sigma_old.sigma.sigma_1.gamma_inv_o_inst, gamma_inv),
        || {
            let (eta_inv_li_o_inter_alpha4_kj, delta_group) = rayon::join(
                || {
                    scale_g1_matrix(
                        &sigma_old.sigma.sigma_1.eta_inv_li_o_inter_alpha4_kj,
                        eta_inv,
                    )
                },
                || {
                    let (delta_inv_li_o_prv, delta_shape_terms) = rayon::join(
                        || scale_g1_matrix(&sigma_old.sigma.sigma_1.delta_inv_li_o_prv, delta_inv),
                        || {
                            let (delta_inv_alphak_xh_tx, delta_tail_terms) = rayon::join(
                                || {
                                    scale_g1_matrix(
                                        &sigma_old.sigma.sigma_1.delta_inv_alphak_xh_tx,
                                        delta_inv,
                                    )
                                },
                                || {
                                    rayon::join(
                                        || {
                                            scale_g1_matrix(
                                                &sigma_old.sigma.sigma_1.delta_inv_alphak_yi_ty,
                                                delta_inv,
                                            )
                                        },
                                        || {
                                            scale_g1_slice(
                                                &sigma_old.sigma.sigma_1.delta_inv_alpha4_xj_tx,
                                                delta_inv,
                                            )
                                        },
                                    )
                                },
                            );
                            (
                                delta_inv_alphak_xh_tx,
                                delta_tail_terms.0,
                                delta_tail_terms.1,
                            )
                        },
                    );
                    (
                        delta_inv_li_o_prv,
                        delta_shape_terms.0,
                        delta_shape_terms.1,
                        delta_shape_terms.2,
                    )
                },
            );
            (
                eta_inv_li_o_inter_alpha4_kj,
                delta_group.0,
                delta_group.1,
                delta_group.2,
                delta_group.3,
            )
        },
    );
    let (
        eta_inv_li_o_inter_alpha4_kj,
        delta_inv_li_o_prv,
        delta_inv_alphak_xh_tx,
        delta_inv_alphak_yi_ty,
        delta_inv_alpha4_xj_tx,
    ) = tail_terms;

    let sigma_new = SigmaV2 {
        contributor_index: sigma_old.contributor_index + 1,
        sigma: libs::group_structures::Sigma {
            G: sigma_old.sigma.G,
            H: sigma_old.sigma.H,
            sigma_1: libs::group_structures::Sigma1 {
                xy_powers: sigma_old.sigma.sigma_1.xy_powers.clone(),
                x: sigma_old.sigma.sigma_1.x,
                y: sigma_old.sigma.sigma_1.y,
                delta: sigma_old.sigma.sigma_1.delta.mul(delta),
                eta: sigma_old.sigma.sigma_1.eta.mul(eta),
                gamma_inv_o_inst,
                eta_inv_li_o_inter_alpha4_kj,
                delta_inv_li_o_prv,
                delta_inv_alphak_xh_tx,
                delta_inv_alpha4_xj_tx,
                delta_inv_alphak_yi_ty,
            },
            sigma_2: libs::group_structures::Sigma2 {
                alpha: sigma_old.sigma.sigma_2.alpha,
                alpha2: sigma_old.sigma.sigma_2.alpha2,
                alpha3: sigma_old.sigma.sigma_2.alpha3,
                alpha4: sigma_old.sigma.sigma_2.alpha4,
                gamma: sigma_old.sigma.sigma_2.gamma.mul(gamma),
                delta: sigma_old.sigma.sigma_2.delta.mul(delta),
                eta: sigma_old.sigma.sigma_2.eta.mul(eta),
                x: sigma_old.sigma.sigma_2.x,
                y: sigma_old.sigma.sigma_2.y,
            },
            lagrange_KL: sigma_old.sigma.lagrange_KL,
        },
        gamma: sigma_old.gamma.mul(gamma),
        public_y_hex: sigma_old.public_y_hex.clone(),
        phase1_source_provenance: sigma_old.phase1_source_provenance.clone(),
    };

    (sigma_new, phase2Proof)
}

#[cfg(test)]
mod tests {
    use super::{run, Phase2NextContributorConfig};

    #[test]
    fn zero_contributor_index_returns_an_error() {
        let config = Phase2NextContributorConfig {
            outfolder: "/unused".to_string(),
            beacon_mode: false,
            contributor_index: 0,
            random_seed_input: None,
        };

        assert!(run(&config).is_err());
    }
}
