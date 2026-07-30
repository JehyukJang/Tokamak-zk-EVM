# `@tokamak-zk-evm/cli`

`@tokamak-zk-evm/cli` installs the Tokamak zk-EVM runtime on the local machine and runs the proof flow from the command line.

Release notes are maintained in the [repository changelog](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md).

## When to use this package

Use `@tokamak-zk-evm/cli` when you want the complete local Tokamak zk-EVM workflow from the command line: install the runtime, synthesize transaction inputs, preprocess circuit data, generate proofs, verify proofs, and extract proof bundles.

Main commands:

- `--install`
- `--install --include-prerequisite`
- `--install --docker`
- `--synthesize`
- `--preprocess`
- `--prove`
- `--verify`
- `--extract-proof`
- `--doctor`

## Quick Start

```bash
npm install -g @tokamak-zk-evm/cli
tokamak-cli --install
tokamak-cli --synthesize ./L2StateChannel
tokamak-cli --preprocess
tokamak-cli --prove
tokamak-cli --verify
```

## What Do I Need Before `--install`?

Before running `--install`, make sure the machine has:

- Node.js 20 or newer
- npm
- Rust and Cargo
- `cmake`
- `pkg-config`
- `tar`
- `unzip`
- a working C/C++ toolchain
- outbound HTTPS access to npm, crates.io, GitHub, GitHub Releases, and Google Drive

Native Linux installation supports Ubuntu 20.04 and Ubuntu 22.04 only. The CLI
rejects other Linux distributions and Ubuntu releases because the packaged
ICICLE v3.8.0 manifest does not provide matching runtime artifacts. On another
Linux distribution, use `--install --docker` with a working Docker daemon.

For `--install --docker`, the Linux host or Windows host with Docker Desktop needs Docker installed and a running Docker daemon. CUDA is enabled only when a CUDA 12.2 Docker probe can run with `--gpus all`, report at least one NVIDIA GPU, and report driver version `525.60.13` or newer.

### macOS

```bash
xcode-select --install
brew install node cmake pkg-config
curl https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"
npm install -g @tokamak-zk-evm/cli
```

### Linux

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl cmake unzip tar pkg-config bash
curl https://sh.rustup.rs -sSf | sh
source "$HOME/.cargo/env"
npm install -g @tokamak-zk-evm/cli
```

Docker installation is also available on Linux and Windows with Docker Desktop:

```bash
tokamak-cli --install --docker
```

### Windows

Native Windows installation is not supported. Use WSL2, or install through Docker Desktop:

```powershell
npm install -g @tokamak-zk-evm/cli
tokamak-cli --install --docker
```

## Can The CLI Install Missing Prerequisites?

Yes. On macOS, Ubuntu 20.04, or Ubuntu 22.04, use:

```bash
tokamak-cli --install --include-prerequisite
```

This option detects Rust, Cargo, CMake, the C/C++ toolchain, `pkg-config`,
`tar`, and `unzip`. It plans installation only for missing tools and does not
upgrade or replace tools already found on `PATH`.

Before changing the host, the CLI prints the detected operating system, the
status and version of every managed prerequisite, the package or upstream
installer for each missing tool, the commands that will run, and the operations
that can request administrator authentication or open an operating-system UI.
It then prompts:

```text
Proceed with prerequisite installation? [y/N]
```

Only `y` or `yes`, matched case-insensitively, approves the plan. Empty input,
EOF, and every other response decline it. A terminal (TTY) is required; there
is no unattended `--yes` mode.

The option can be combined with `--trusted-setup`, `--no-setup`, and
`--verbose`. It cannot be combined with `--docker`, and the existing
`--trusted-setup`/`--no-setup` conflict still applies.

### What Gets Installed?

On Ubuntu 20.04 and 22.04, the CLI refreshes APT metadata and uses targeted
`sudo apt-get` commands to install missing official Ubuntu packages:

- `build-essential` for the C/C++ toolchain
- `cmake`
- `pkg-config`
- `tar`
- `unzip`

On macOS, missing Xcode Command Line Tools are handled first. The CLI launches
`xcode-select --install`, stops, and asks you to rerun the same command after
Apple's installer finishes. For other missing packages, it uses an existing
Homebrew installation or runs Homebrew's official installer, loads
`brew shellenv` into the current CLI process, and installs the required
formulae.

If Rust or Cargo is missing on either operating system, the CLI runs the
official rustup installer and installs the latest upstream stable toolchain in
the standard `~/.rustup` and `~/.cargo` locations. Existing Rust and Cargo
installations are not updated. Other missing tools use the latest version
available from the operating system's configured official package manager; the
CLI does not add PPAs, APT repositories, Homebrew taps, or equivalent package
sources.

After installation, the CLI verifies every managed command and its reported
version. A verification failure stops the backend install without trying a
different version or installer.

Node.js 20 or newer and npm are not managed by this option: they must already
be installed for `tokamak-cli` itself to run. The option also does not install
Docker, Docker Desktop, GPU drivers, or network configuration.

Do not run the full command with `sudo`. The CLI rejects
`--include-prerequisite` when its own process is running as root and requests
elevation only for Ubuntu package-manager commands that need it.

### Prerequisite Installation Disclaimer

`--include-prerequisite` is an opt-in convenience that invokes operating-system
package managers and official third-party installers. These tools may download
code, contact external services, request credentials, display their own license
terms, and modify system or user directories outside the Tokamak CLI cache.
Available versions and installer behavior are controlled by Ubuntu, Apple,
Homebrew, and Rust project infrastructure and can change independently of this
package.

Review the displayed plan, upstream terms, your organization's security
policies, and any package-manager prompts before approving. You are responsible
for backups, access authorization, license compliance, and determining whether
the proposed changes are appropriate for the machine. To retain full control,
install the prerequisites manually and run `tokamak-cli --install` without this
option.

`tokamak-cli --uninstall` removes only the CLI-owned runtime workspace and
downloads. It does not remove or roll back Rust, Cargo, Homebrew, Homebrew
formulae, Xcode Command Line Tools, or APT packages installed through
`--include-prerequisite`.

### Troubleshooting Or Removing Prerequisites

If an installer or package-manager command fails partway through, fix the
reported upstream error and rerun the same `tokamak-cli` command. Detection is
repeated on every run, so the next plan contains only tools that are still
missing. The CLI does not attempt an automatic rollback.

If post-install verification fails, confirm that the installed command is on
`PATH` and works in a new terminal. Useful upstream checks include
`xcode-select -p`, `brew shellenv`, `rustup show`, and the relevant APT or
Homebrew package status command. The CLI deliberately stops before building
the backend when verification is incomplete.

Remove an unwanted prerequisite only through the tool that installed it:
Ubuntu's APT, Homebrew, Apple's Xcode Command Line Tools management process, or
`rustup self uninstall`. Review the official uninstall documentation and
dependent packages first. Removing a shared compiler, package manager, or
system package can break software unrelated to Tokamak zk-EVM.

## What Does `--install` Do?

`--install`:

- builds the local backend binaries
- downloads the ICICLE runtime libraries, reusing cached tarballs only when their SHA-256 hashes match the packaged manifest
- downloads CRS files, unless `--no-setup` is used, reusing cached CRS output only when `crs_provenance.json` version and artifact hashes match the latest CRS
- retries the anonymous CRS download up to 5 times, then fails
- writes everything into the CLI runtime cache

`--install --docker` is supported on Linux hosts and Windows hosts with Docker Desktop. It uses the static Dockerfile shipped in the npm package, checks that Docker is running, probes CUDA with `docker run --rm --gpus all ... nvidia-smi`, then installs through either an `ubuntu22-cuda122` container environment or a CPU-only `ubuntu22` container environment. CUDA Docker installs re-check CUDA availability before each backend command and run without `--gpus all` if the GPU runtime is no longer available. Docker installs always write the Linux runtime cache and store Docker bootstrap files in:

```text
~/.tokamak-zk-evm/linux/docker
```

When `--preprocess`, `--prove`, or `--verify` runs later, the CLI uses that bootstrap to execute the backend command inside Docker if the bootstrap exists and Docker is running. On Linux, if Docker is not running, the CLI falls back to the native runtime path. On Windows, Docker Desktop must be running because native Windows backend execution is not supported.

## What Does The Docker Install Image Include?

The npm package ships the Dockerfile used by `--install --docker`.
The host still needs only Node.js 20 or newer, the installed CLI package, Docker, and outbound HTTPS access.

Inside the Docker image, the CLI installs the build and runtime tools needed to compile the vendored backend and provision local resources:

- Ubuntu 22.04, or NVIDIA CUDA 12.2 on Ubuntu 22.04 when Docker CUDA probing succeeds
- Node.js and npm for running the packaged CLI and backend build scripts
- Rust and Cargo for building the backend binaries
- C/C++ build tooling, `cmake`, `pkg-config`, `clang`, and `libclang-dev` for native Rust dependencies
- `curl`, `git`, `tar`, `unzip`, and CA certificates for downloading, Git dependencies, and archive extraction

The image is intentionally conservative rather than aggressively minimal. Removing packages such as `clang`, `libclang-dev`, `pkg-config`, or `bash` requires a clean Docker build test of the backend before release.

## Which Working Directory Does The CLI Use?

The CLI reads relative input paths from the directory where you run the command.

Example:

```bash
cd /path/to/project
tokamak-cli --synthesize ./L2StateChannel
```

In that example, `./L2StateChannel` means `/path/to/project/L2StateChannel`.

## Where Are Output Files Written?

The CLI does not write synth, preprocess, or prove outputs into your current directory.
It writes them into the runtime cache.

Default cache root:

```text
~/.tokamak-zk-evm
```

You can change that location with `TOKAMAK_ZKEVM_CLI_CACHE_DIR`.

Output locations under the cache:

- `macos/runtime/resource/synthesizer/output`
- `macos/runtime/resource/preprocess/output`
- `macos/runtime/resource/prove/output`
- `macos/runtime/resource/setup/output`
- `linux/runtime/resource/synthesizer/output`
- `linux/runtime/resource/preprocess/output`
- `linux/runtime/resource/prove/output`
- `linux/runtime/resource/setup/output`

`--synthesize` clears the synth output directory before writing new files.

`--extract-proof <OUTPUT_ZIP_PATH>` is different. It writes the zip file to the path you pass on the command line.

## What Files Does `--synthesize` Need?

If you pass a directory, it must contain:

- `previous_state_snapshot.json`
- `transaction.json`
- `block_info.json`
- `contract_codes.json`

Example:

```bash
tokamak-cli --synthesize ./L2StateChannel
```

You can also pass the files one by one:

```bash
tokamak-cli --synthesize \
  --previous-state ./inputs/previous_state_snapshot.json \
  --transaction ./inputs/transaction.json \
  --block-info ./inputs/block_info.json \
  --contract-code ./inputs/contract_codes.json
```

## What Do `--preprocess`, `--prove`, and `--verify` Read?

If you run them without an argument, they use the files already stored in the runtime cache.

If you pass a directory or zip file:

- `--preprocess` needs `permutation.json` and `instance.json`
- `--prove` needs `placementVariables.json`, `permutation.json`, and `instance.json`
- `--verify` needs `proof.json`, `preprocess.json`, and `instance.json`

Examples:

```bash
tokamak-cli --preprocess
tokamak-cli --prove
tokamak-cli --verify
```

```bash
tokamak-cli --preprocess ./artifacts
tokamak-cli --prove ./artifacts.zip
tokamak-cli --verify ./proof-bundle.zip
```

## What Does `--extract-proof` Produce?

`--extract-proof <OUTPUT_ZIP_PATH>` writes a zip file that includes:

- `proof.json`
- `preprocess.json`
- `instance.json`
- `instance_description.json`
- `benchmark.json` when available

Example:

```bash
tokamak-cli --extract-proof ./proof-bundle.zip
tokamak-cli --verify ./proof-bundle.zip
```

## What Does `--doctor` Check?

`--doctor` checks whether the CLI can find the installed runtime for the current platform and prints the absolute runtime workspace path.

```bash
tokamak-cli --doctor
```

## Common Questions

### Why Is `--install` Slow?

`--install` builds native Rust binaries on the local machine. The first build is usually the slowest.

### Why Are My Outputs Not In My Project Directory?

Because the CLI writes runtime artifacts into the cache directory, not next to the input files.

### How Do I Move The Cache Directory?

Set `TOKAMAK_ZKEVM_CLI_CACHE_DIR` before running the CLI.

Example:

```bash
export TOKAMAK_ZKEVM_CLI_CACHE_DIR="$HOME/tokamak-cli-cache"
tokamak-cli --install
```

### How Do I Start From A Clean State?

Delete the CLI cache directory and run `tokamak-cli --install` again.
