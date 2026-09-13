fn main() -> std::process::ExitCode {
    match mpc_setup::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("MPC failed: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
