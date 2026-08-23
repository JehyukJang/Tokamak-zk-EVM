use crate::accumulator::Accumulator;
use crate::contributor::{get_device_info, ContributorInfo};
use crate::conversions::{icicle_g1_generator, icicle_g2_generator};
use crate::flows::MpcSetupError;
use crate::sigma::AaccExt;
use crate::testing_mode_enabled;
use crate::utils::StepTimer;
use chrono::Local;
use icicle_bls12_381::curve::{ScalarCfg, ScalarField};
use icicle_core::traits::{FieldImpl, GenerateRandom};
use libs::iotools::SetupParams;
use std::cmp::max;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::ops::Mul;
use std::path::PathBuf;
use std::time::Instant;

const HASH_BYTES: usize = 32;
const POWER_ALPHA_LENGTH: usize = 4;

#[derive(Debug, Clone)]
pub struct Phase1InitializeConfig {
    pub qap_path: PathBuf,
    pub setup_params_file: String,
    pub outfolder: String,
}

pub fn run(config: &Phase1InitializeConfig) -> Result<(), MpcSetupError> {
    let mut timer = StepTimer::new("phase1_initialize");

    let setup_params_path = config.qap_path.join(&config.setup_params_file);
    let setup_params =
        SetupParams::read_from_json(setup_params_path.clone()).map_err(|source| {
            MpcSetupError::Io {
                operation: "read setup parameters",
                path: setup_params_path,
                source,
            }
        })?;
    timer.log_step("load setup params");
    let x_degree = 2 * max(setup_params.n, setup_params.l_D - setup_params.l);
    println!("Initializing phase-1 accumulator...");
    if testing_mode_enabled() {
        println!("Device: {:?}", get_device_info());
        println!("Config: {:?}", config);
        println!("Power bounds: x_degree={} (phase 1 is x-only)", x_degree);
    }
    let scalar = initialize_scalar();
    timer.log_step("initialize scalar");
    let start = Instant::now();

    let g1 = icicle_g1_generator().mul(scalar);
    let g2 = icicle_g2_generator().mul(scalar);
    let genesis_acc = Accumulator::new(g1, g2, POWER_ALPHA_LENGTH, x_degree, false);
    timer.log_step("build genesis accumulator");

    let outfile = format!(
        "{}/phase1_acc_{}.json",
        config.outfolder, genesis_acc.contributor_index
    );
    genesis_acc
        .write_into_json(&outfile)
        .map_err(|source| MpcSetupError::Io {
            operation: "write phase-1 accumulator",
            path: PathBuf::from(&outfile),
            source,
        })?;
    genesis_acc
        .write_rkyv_sidecar_for_json_path(&outfile)
        .map_err(|source| MpcSetupError::Io {
            operation: "write phase-1 accumulator archive",
            path: PathBuf::from(&outfile),
            source,
        })?;
    timer.log_step("write accumulator");

    let fpath = format!(
        "{}/phase1_contributor_{}.txt",
        config.outfolder, genesis_acc.contributor_index
    );
    save_contributor_info(&genesis_acc, start.elapsed(), "", "", fpath.clone()).map_err(
        |source| MpcSetupError::Io {
            operation: "write phase-1 contributor information",
            path: PathBuf::from(fpath),
            source,
        },
    )?;
    timer.log_step("write contributor info");
    println!(
        "Phase-1 initialization completed in {:.2} seconds",
        start.elapsed().as_secs_f64()
    );
    timer.log_total();
    println!("Thanks for your contribution.");
    Ok(())
}

fn initialize_scalar() -> ScalarField {
    if crate::testing_mode_enabled() {
        ScalarField::from_u32(1)
    } else {
        ScalarCfg::generate_random(1)[0]
    }
}

fn save_contributor_info(
    acc: &Accumulator,
    duration: std::time::Duration,
    contributor_name: &str,
    location: &str,
    fpath: String,
) -> std::io::Result<()> {
    let current_date = Local::now().format("%Y-%m-%d").to_string();
    let contributor_info = ContributorInfo {
        contributor_no: acc.contributor_index as u32,
        date: current_date,
        name: contributor_name.to_string(),
        location: location.to_string(),
        devices: get_device_info().to_string(),
        prev_acc_hash: hex::encode([0u8; HASH_BYTES]),
        prev_proof_hash: hex::encode([0u8; HASH_BYTES]),
        current_acc_hash: hex::encode(acc.blake2b_hash()),
        current_proof_hash: hex::encode([0u8; HASH_BYTES]),
        time_taken_seconds: duration.as_secs_f64(),
    };

    let file = File::create(fpath)?;
    let mut writer = BufWriter::new(file);
    writer.write_all(contributor_info.to_string().as_bytes())
}
