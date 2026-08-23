use icicle_runtime::{self, Device};
use std::path::{Path, PathBuf};

use crate::bivariate_polynomial::init_ntt_domain_for_size;
use crate::errors::{ArtifactError, DeviceError};
use crate::iotools::SetupParams;

#[derive(Clone, Copy, Debug)]
pub struct SetupShape {
    pub l_free: usize,
    pub m_i: usize,
    pub n: usize,
    pub s_max: usize,
}

pub fn load_setup_params_from_qap_path(qap_path: &str) -> SetupParams {
    try_load_setup_params_from_qap_path(qap_path).unwrap_or_else(|error| panic!("{error}"))
}

pub fn try_load_setup_params_from_qap_path(qap_path: &str) -> Result<SetupParams, ArtifactError> {
    let setup_path = PathBuf::from(qap_path).join("setupParams.json");
    let bytes = std::fs::read(&setup_path).map_err(|source| ArtifactError::Read {
        artifact: "setup parameters",
        path: setup_path.clone(),
        source,
    })?;
    serde_json::from_slice(&bytes).map_err(|source| ArtifactError::Parse {
        artifact: "setup parameters",
        path: setup_path,
        source,
    })
}

pub fn setup_shape(params: &SetupParams) -> SetupShape {
    try_setup_shape(params, Path::new("setupParams.json")).unwrap_or_else(|error| panic!("{error}"))
}

pub fn try_setup_shape(params: &SetupParams, path: &Path) -> Result<SetupShape, ArtifactError> {
    let m_i = params
        .l_D
        .checked_sub(params.l)
        .ok_or_else(|| ArtifactError::Invalid {
            artifact: "setup parameters",
            path: path.to_path_buf(),
            reason: "l_D must be greater than or equal to l".to_string(),
        })?;
    Ok(SetupShape {
        l_free: params.l_free,
        m_i,
        n: params.n,
        s_max: params.s_max,
    })
}

pub fn validate_setup_shape(shape: &SetupShape) {
    try_validate_setup_shape(shape, Path::new("setupParams.json"))
        .unwrap_or_else(|error| panic!("{error}"));
}

pub fn try_validate_setup_shape(shape: &SetupShape, path: &Path) -> Result<(), ArtifactError> {
    if !shape.n.is_power_of_two() {
        return Err(invalid_setup_shape(path, "n must be a power of two"));
    }
    if !shape.s_max.is_power_of_two() {
        return Err(invalid_setup_shape(path, "s_max must be a power of two"));
    }
    if !shape.m_i.is_power_of_two() {
        return Err(invalid_setup_shape(path, "m_I must be a power of two"));
    }
    Ok(())
}

fn invalid_setup_shape(path: &Path, reason: &str) -> ArtifactError {
    ArtifactError::Invalid {
        artifact: "setup parameters",
        path: path.to_path_buf(),
        reason: reason.to_string(),
    }
}

pub fn validate_public_wire_size(l: usize) {
    try_validate_public_wire_size(l, Path::new("setupParams.json"))
        .unwrap_or_else(|error| panic!("{error}"));
}

pub fn try_validate_public_wire_size(l: usize, path: &Path) -> Result<(), ArtifactError> {
    if l != 0 && !l.is_power_of_two() {
        return Err(invalid_setup_shape(
            path,
            "l must be zero or a power of two",
        ));
    }
    Ok(())
}

pub fn prover_verifier_ntt_domain_size(shape: &SetupShape) -> usize {
    let max_mn = std::cmp::max(shape.m_i, shape.n);
    let ntt_domain_x = max_mn.checked_mul(4).expect("4 * max(m_i, n) overflow");
    let ntt_domain_y = shape.s_max.checked_mul(2).expect("2 * s_max overflow");
    ntt_domain_x
        .checked_mul(ntt_domain_y)
        .expect("2 * max(m_i, n) * 2 * s_max overflow")
}

pub fn trusted_setup_ntt_domain_size(shape: &SetupShape) -> usize {
    *[shape.n, shape.l_free, shape.m_i, shape.s_max]
        .iter()
        .max()
        .expect("max(n, l, m_i, s_max) requires non-empty inputs")
}

pub fn trusted_setup_testing_ntt_domain_size(shape: &SetupShape) -> usize {
    std::cmp::max(shape.n, shape.m_i)
        .checked_mul(shape.s_max)
        .expect("max(n, m_i) * s_max overflow")
}

pub fn init_ntt_domain(size: usize) {
    try_init_ntt_domain(size).unwrap_or_else(|error| panic!("{error}"));
}

pub fn try_init_ntt_domain(size: usize) -> Result<(), DeviceError> {
    init_ntt_domain_for_size(size).map_err(|error| DeviceError::Initialization {
        device: "ICICLE NTT domain",
        reason: error.to_string(),
    })
}

/// Returns true if CUDA or METAL GPU is available.
pub fn check_gpu() -> bool {
    let device_cuda = Device::new("CUDA", 0);
    // "METAL" is not working yet.
    let device_metal = Device::new("CUDA", 0);

    icicle_runtime::is_device_available(&device_cuda)
        || icicle_runtime::is_device_available(&device_metal)
}

/// Sets the best available device and returns the selected device name ("CUDA", "METAL", or "CPU").
pub fn check_device() -> &'static str {
    try_check_device().unwrap_or_else(|error| panic!("{error}"))
}

pub fn try_check_device() -> Result<&'static str, DeviceError> {
    icicle_runtime::load_backend_from_env_or_default().map_err(|error| {
        DeviceError::Initialization {
            device: "ICICLE backend",
            reason: error.to_string(),
        }
    })?;
    let device_cpu = Device::new("CPU", 0);
    let device_cuda = Device::new("CUDA", 0);
    let device_metal = Device::new("METAL", 0);

    if icicle_runtime::is_device_available(&device_cuda) {
        println!("CUDA is available");
        icicle_runtime::set_device(&device_cuda).map_err(|error| DeviceError::Initialization {
            device: "CUDA",
            reason: error.to_string(),
        })?;
        Ok("CUDA")
    } else if icicle_runtime::is_device_available(&device_metal) {
        println!("METAL is available");
        // icicle_runtime::set_device(&device_metal).expect("Failed to set METAL device");
        // "METAL"
        println!( "METAL is not working properly in the ICICLE version 3.8.0, so falling back to CPU only.");
        icicle_runtime::set_device(&device_cpu).map_err(|error| DeviceError::Initialization {
            device: "CPU",
            reason: error.to_string(),
        })?;
        Ok("CPU")
    } else {
        println!("GPU is not available, falling back to CPU only");
        icicle_runtime::set_device(&device_cpu).map_err(|error| DeviceError::Initialization {
            device: "CPU",
            reason: error.to_string(),
        })?;
        Ok("CPU")
    }
}
