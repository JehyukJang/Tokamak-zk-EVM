use libs::crs_publication_admission::{admit_final_crs_publication, PublicationIdentity};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut arguments = std::env::args_os();
    let executable = arguments
        .next()
        .unwrap_or_else(|| "check_crs_publication".into());
    let Some(output_directory) = arguments.next() else {
        return usage(&PathBuf::from(executable));
    };
    if arguments.next().is_some() {
        return usage(&PathBuf::from(executable));
    }

    let output_directory = PathBuf::from(output_directory);
    let expected = match PublicationIdentity::current_package() {
        Ok(expected) => expected,
        Err(error) => {
            eprintln!("Cannot derive publication identity: {error}");
            return ExitCode::FAILURE;
        }
    };
    match admit_final_crs_publication(&output_directory, &expected) {
        Ok(provenance) => {
            println!(
                "Final CRS publication admission passed: compatibility={} subcircuit-library={}@{} source-digest={}",
                provenance.compatible_backend_version,
                provenance.subcircuit_library.package_name,
                provenance.subcircuit_library.package_version,
                provenance.subcircuit_library.source_digest
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!(
                "Final CRS publication admission failed for {}: {error}",
                output_directory.display()
            );
            ExitCode::FAILURE
        }
    }
}

fn usage(executable: &PathBuf) -> ExitCode {
    eprintln!("Usage: {} <final-crs-directory>", executable.display());
    ExitCode::FAILURE
}
