use crate::backend_build_metadata::BackendBuildMetadata;
use std::env;
use std::error::Error;
use std::ffi::OsStr;
use std::process::ExitCode;

const BACKEND_BUILD_IDENTITY_ARGUMENT: &str = "--build-identity-json";

/// A user-facing error emitted by a backend workflow binary.
pub trait CliDiagnostic: Error {
    fn hint(&self) -> &'static str;
}

/// Render a workflow error consistently without moving workflow policy into `libs`.
pub fn render_error(error: &dyn CliDiagnostic) -> ExitCode {
    eprintln!("error: {error}");

    let mut source = error.source();
    while let Some(cause) = source {
        eprintln!("caused by: {cause}");
        source = cause.source();
    }

    eprintln!("hint: {}", error.hint());
    ExitCode::FAILURE
}

/// Prints a production binary's build metadata through the machine-readable
/// identity interface when it is the only requested argument.
pub fn print_backend_build_identity_if_requested(
    package_name: &str,
    package_version: &str,
    compatible_backend_version: Option<&str>,
    subcircuit_library_package_version: Option<&str>,
) -> Result<bool, String> {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if !arguments
        .iter()
        .any(|argument| argument == OsStr::new(BACKEND_BUILD_IDENTITY_ARGUMENT))
    {
        return Ok(false);
    }
    if arguments.len() != 1 || arguments[0] != OsStr::new(BACKEND_BUILD_IDENTITY_ARGUMENT) {
        return Err(format!(
            "{BACKEND_BUILD_IDENTITY_ARGUMENT} cannot be combined with workflow arguments"
        ));
    }

    let compatible_backend_version = compatible_backend_version.ok_or_else(|| {
        format!(
            "{BACKEND_BUILD_IDENTITY_ARGUMENT} is unavailable because this binary was not built with the production subcircuit-library input"
        )
    })?;
    let subcircuit_library_package_version = subcircuit_library_package_version.ok_or_else(|| {
        format!(
            "{BACKEND_BUILD_IDENTITY_ARGUMENT} is unavailable because this binary was not built with the production subcircuit-library input"
        )
    })?;
    let metadata = BackendBuildMetadata::new(
        package_name,
        package_version,
        compatible_backend_version,
        subcircuit_library_package_version,
    )?;
    println!(
        "{}",
        serde_json::to_string(&metadata)
            .map_err(|error| format!("failed to serialize backend build identity: {error}"))?
    );
    Ok(true)
}
