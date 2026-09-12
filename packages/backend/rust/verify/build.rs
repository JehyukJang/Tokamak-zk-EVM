mod build_parameters;
#[path = "../build-support/subcircuit_library.rs"]
mod subcircuit_library;

use std::{env, fs, io, path::PathBuf};

fn main() -> io::Result<()> {
    let library_dir = subcircuit_library::configure_subcircuit_library_metadata(
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
    )?;
    let setup_path = library_dir.join("setupParams.json");
    println!("cargo:rerun-if-changed={}", setup_path.display());
    let bytes = fs::read(&setup_path).map_err(|error| {
        io::Error::new(error.kind(), format!("{}: {error}", setup_path.display()))
    })?;
    let generated = build_parameters::generate(&bytes).map_err(|error| {
        io::Error::new(error.kind(), format!("{}: {error}", setup_path.display()))
    })?;
    let out_dir = PathBuf::from(
        env::var_os("OUT_DIR").ok_or_else(|| io::Error::other("Cargo did not provide OUT_DIR"))?,
    );
    fs::write(out_dir.join("verifier_parameters.rs"), generated)?;
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build_parameters.rs");
    println!("cargo:rerun-if-changed=../build-support/subcircuit_library.rs");
    println!("cargo:rerun-if-changed=../build-support/subcircuit_library");
    Ok(())
}
