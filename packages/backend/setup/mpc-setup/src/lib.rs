use icicle_bls12_381::curve::{G1Affine, G1Projective, ScalarField};
use icicle_core::msm;
use icicle_core::msm::MSMConfig;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::{DeviceVec, HostSlice};
use icicle_runtime::stream::IcicleStream;
use libs::group_structures::G1serde;
use libs::iotools::SetupParams;

include!(concat!(env!("OUT_DIR"), "/local_subcircuit_library.rs"));

pub const fn testing_mode_enabled() -> bool {
    cfg!(feature = "testing-mode")
}

pub fn ensure_testing_mode(context: &str) {
    assert!(
        testing_mode_enabled(),
        "{context} requires the `testing-mode` feature"
    );
}

#[macro_export]
macro_rules! testing_log {
    ($($arg:tt)*) => {{
        if $crate::testing_mode_enabled() {
            println!($($arg)*);
        }
    }};
}

mod conversions;
mod utils;

mod accumulator;
mod contributor;
mod drive_upload;
mod flows;
mod phase1_source;

mod sigma;
mod versioning;

pub use flows::{
    run_dusk_backed_mpc_setup, run_native_mpc_setup, DuskBackedMpcSetupConfig, NativeMpcSetupConfig,
};

pub struct MsmWorkspace {
    stream: IcicleStream,
    output: DeviceVec<G1Projective>,
    host: Vec<G1Projective>,
    capacity: usize,
}

impl MsmWorkspace {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            stream: IcicleStream::create().expect("Stream creation failed"),
            output: DeviceVec::<G1Projective>::device_malloc(capacity)
                .expect("device_malloc failed"),
            host: vec![G1Projective::zero(); capacity],
            capacity,
        }
    }

    fn ensure_capacity(&mut self, capacity: usize) {
        if capacity <= self.capacity {
            return;
        }
        let new_capacity = capacity.next_power_of_two();
        self.output =
            DeviceVec::<G1Projective>::device_malloc(new_capacity).expect("device_malloc failed");
        self.host.resize(new_capacity, G1Projective::zero());
        self.capacity = new_capacity;
    }

    pub fn msm(&mut self, scalars: &[ScalarField], bases: &[G1Affine]) -> G1serde {
        assert_eq!(scalars.len(), bases.len());
        self.ensure_capacity(1);

        let mut cfg = MSMConfig::default();
        cfg.stream_handle = *self.stream;
        cfg.is_async = true;
        msm::msm(
            HostSlice::from_slice(scalars),
            HostSlice::from_slice(bases),
            &cfg,
            &mut self.output[..1],
        )
        .unwrap();
        self.stream.synchronize().unwrap();
        self.output[..1]
            .copy_to_host(HostSlice::from_mut_slice(&mut self.host[..1]))
            .unwrap();
        G1serde(G1Affine::from(self.host[0]))
    }

    pub fn shared_bases_msm(
        &mut self,
        bases: &[G1Affine],
        batched_scalars: &[ScalarField],
        output_size: usize,
    ) -> &[G1Projective] {
        assert!(output_size > 0);
        assert_eq!(batched_scalars.len(), bases.len() * output_size);
        self.ensure_capacity(output_size);

        let mut cfg = MSMConfig::default();
        cfg.stream_handle = *self.stream;
        cfg.is_async = true;
        cfg.batch_size = bases.len() as i32;
        cfg.are_points_shared_in_batch = true;
        msm::msm(
            HostSlice::from_slice(batched_scalars),
            HostSlice::from_slice(bases),
            &cfg,
            &mut self.output[..output_size],
        )
        .unwrap();
        self.stream.synchronize().unwrap();
        self.output[..output_size]
            .copy_to_host(HostSlice::from_mut_slice(&mut self.host[..output_size]))
            .unwrap();
        &self.host[..output_size]
    }
}

impl Drop for MsmWorkspace {
    fn drop(&mut self) {
        let _ = self.stream.destroy();
    }
}

pub struct NttWorkspace {
    stream: IcicleStream,
    device: DeviceVec<ScalarField>,
    host: Vec<ScalarField>,
    capacity: usize,
}

impl NttWorkspace {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(1);
        Self {
            stream: IcicleStream::create().expect("Stream creation failed"),
            device: DeviceVec::<ScalarField>::device_malloc(capacity)
                .expect("device_malloc failed"),
            host: vec![ScalarField::zero(); capacity],
            capacity,
        }
    }

    fn ensure_capacity(&mut self, capacity: usize) {
        if capacity <= self.capacity {
            return;
        }
        let new_capacity = capacity.next_power_of_two();
        self.device =
            DeviceVec::<ScalarField>::device_malloc(new_capacity).expect("device_malloc failed");
        self.host.resize(new_capacity, ScalarField::zero());
        self.capacity = new_capacity;
    }

    pub fn inverse_rows_into(
        &mut self,
        input: &[ScalarField],
        row_count: usize,
        row_len: usize,
        out: &mut Vec<ScalarField>,
    ) {
        let size = row_count * row_len;
        assert_eq!(input.len(), size);
        if size == 0 {
            out.clear();
            return;
        }

        self.ensure_capacity(size);
        if out.len() != size {
            out.resize(size, ScalarField::zero());
        }

        let mut cfg = NTTConfig::<ScalarField>::default();
        cfg.stream_handle = *self.stream;
        cfg.is_async = true;
        cfg.batch_size = row_count as i32;
        cfg.columns_batch = false;
        cfg.are_outputs_on_device = true;
        cfg.coset_gen = ScalarField::one();

        ntt::ntt(
            HostSlice::from_slice(input),
            NTTDir::kInverse,
            &cfg,
            &mut self.device[..size],
        )
        .unwrap();
        self.stream.synchronize().unwrap();
        self.device[..size]
            .copy_to_host(HostSlice::from_mut_slice(out))
            .unwrap();
    }
}

impl Drop for NttWorkspace {
    fn drop(&mut self) {
        let _ = self.stream.destroy();
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PublicWireSegments {
    pub user_out_end: usize,
    pub user_end: usize,
    pub free_end: usize,
    pub total_end: usize,
}

pub fn public_wire_segments(setup_params: &SetupParams) -> PublicWireSegments {
    let user_out_end = setup_params.l_user_out;
    let user_end = setup_params.l_user;
    let free_end = setup_params.l_free;
    let total_end = setup_params.l;

    assert!(user_out_end <= user_end, "l_user_out must be <= l_user");
    assert!(user_end <= free_end, "l_user must be <= l_free");
    assert!(free_end <= total_end, "l_free must be <= l");

    PublicWireSegments {
        user_out_end,
        user_end,
        free_end,
        total_end,
    }
}
