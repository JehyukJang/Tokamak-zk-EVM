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

mod accumulator;
mod contributor;
mod drive_upload;
mod flows;
mod phase1_source;

mod sigma;
mod versioning;

pub use flows::{
    run_dusk_backed_ceremony, run_dusk_backed_mpc_setup, run_dusk_backed_publication,
    run_native_mpc_setup, DuskBackedMpcSetupConfig, DuskPublicationConfig, MpcSetupError,
    NativeMpcSetupConfig,
};
