use std::error::Error;
use std::process::ExitCode;

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
