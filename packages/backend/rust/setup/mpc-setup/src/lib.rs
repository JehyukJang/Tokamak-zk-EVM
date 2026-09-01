include!(concat!(env!("OUT_DIR"), "/mpc_subcircuit_library.rs"));

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

pub mod alpha_x_basis;
pub mod ceremony_workspace;
pub mod contribution_kernel;
mod drive_upload;
mod flows;
pub mod operator;
pub mod participant;
pub mod phase1_contribution;
pub mod phase2_circuit;
pub mod phase2_contribution;
pub mod protocol;
pub mod state_bundle;
pub mod transcript;
pub mod universal_tau;

mod versioning;

pub use flows::{
    qap_circuit::prepare_selected_phase1_from_qap, run_dusk_backed_ceremony,
    run_dusk_backed_mpc_setup, run_dusk_backed_publication, run_native_mpc_setup,
    DuskBackedMpcSetupConfig, DuskPublicationConfig, MpcSetupError, NativeMpcSetupConfig,
};
