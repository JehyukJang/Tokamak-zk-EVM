# MPC Setup Guide for Tokamak zk-EVM

`mpc-setup` exposes two user-facing entrypoints only:

- `native_mpc_setup`
- `dusk_backed_mpc_setup`

Both binaries are thin CLI wrappers. The ceremony logic lives in library flow modules under
[`src/flows`](./src/flows). The `local-development-subcircuit-library` feature prepares the local
qap-compiler subcircuit library; release builds without that feature prepare the npm
subcircuit-library snapshot. Neither mode accepts a runtime library path argument.

Both binaries are part of the Rust backend workspace and are not published as
standalone npm or crates.io packages. CLI users normally obtain compatible CRS
artifacts through [`@tokamak-zk-evm/cli`](https://www.npmjs.com/package/@tokamak-zk-evm/cli).
Release notes are in [CHANGELOG.md](../../../../CHANGELOG.md).

## Overview

The final CRS output format is identical in both modes. Only the phase-1 source and release
eligibility differ. Native mode writes `releaseEligible: false`; only Dusk-backed mode writes
`releaseEligible: true`.

- `native_mpc_setup`
  - Runs the Tokamak x-only phase-1 flow and then the Tokamak phase-2 flow.
- `dusk_backed_mpc_setup`
  - Skips Tokamak phase 1 and derives the phase-2 source from a pinned Dusk Groth16 raw
    powers-of-tau artifact.

Both wrappers write:

- intermediate ceremony artifacts to `--intermediate`
- final CRS artifacts to `--output`

The mathematical formulas, trapdoor ownership, contribution checks, and known
security limitation of the implemented phase-2 protocol are documented in the
[phase-2 output contract](docs/phase2-output-contract.md).

## Prerequisites

Before running the ceremony:

- follow the repository prerequisites from the backend root README
- ensure the official `circom` compiler is available on `PATH`
- install OpenSSL if required by your platform

Run all commands from:

```bash
cd "$PWD/packages/backend"
```

## Native Mode

`mpc-setup` builds with `local-development-subcircuit-library` build the local
`../frontend/qap-compiler` package during the Cargo build, including when Cargo uses the release
profile. Release builds without that feature use the npm subcircuit-library snapshot and reject a
snapshot whose package major.minor differs from the backend compatibility class. `mpc-setup` does
not accept `--subcircuit-library`.
The setup flow consumes binary R1CS constraint files from the prepared library's `r1cs/` directory.

```bash
cargo run --release -p mpc-setup --bin native_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/native.intermediate \
  --output ./setup/mpc-setup/output/native.final
```

Use `--beacon-mode` to switch the normal build from random sampling to deterministic
seed-based beacon mode.

Optional wrapper-only input:

- `--seed-input`

The wrappers are non-interactive. Contributor metadata defaults to empty strings, and the
native phase-1 initialization scalar uses internal randomness when testing mode is not enabled.

## Dusk-Backed Mode

```bash
cargo run --release -p mpc-setup --bin dusk_backed_mpc_setup -- \
  ceremony \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

Optional wrapper-only input:

- `--seed-input`

In dusk-backed mode:

- the raw Dusk artifact path is fixed to `<intermediate>/dusk.response`
- if the file is missing, the wrapper downloads the pinned Dusk contribution
- the downloaded or local file must match the pinned SHA-256 digest compiled into the binary
- the used G1 and G2 tau ranges are verified before phase 2 begins

`ceremony` does not read Google Drive configuration, open a browser, or publish an artifact. It
creates a local release-eligible CRS and records provenance. It may download the pinned public
Dusk source when `<intermediate>/dusk.response` is absent.

Publish an existing ceremony output separately:

```bash
cargo run --release -p mpc-setup --bin dusk_backed_mpc_setup -- \
  publish \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

`publish` checks that the Google Drive upload environment is valid, rejects a target folder that
already contains a CRS archive for the current backend version, creates an archive containing the
final `--output` artifacts, and uploads it to the configured Google Drive folder. It is only
available in release builds. Before upload, it requires Dusk phase-1 provenance and an npm
subcircuit-library snapshot origin recorded in `crs_provenance.json`. The archive name includes
the backend version and CRS generation timestamp.

Use `run` instead of `ceremony` to execute ceremony followed by publication in one command:

```bash
cargo run --release -p mpc-setup --bin dusk_backed_mpc_setup -- \
  run \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

Local developer build example:

```bash
cargo run --release -p mpc-setup --features local-development-subcircuit-library \
  --bin dusk_backed_mpc_setup -- \
  ceremony \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

The current pinned Dusk source is:

- contribution: `0015`
- README:
  `https://raw.githubusercontent.com/dusk-network/trusted-setup/main/contributions/0015/README.md`
- drive file id: `1nv9WpxXWMiP8-YwImd2FVn523u7_sb48`

## Dusk Upload Environment

The `publish` and `run` subcommands read publication configuration from `.env`; `ceremony` does
not read it.

Required keys:

- `TOKAMAK_MPC_DRIVE_FOLDER_ID`
- `TOKAMAK_MPC_DRIVE_OAUTH_CLIENT_JSON_PATH`
- `TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH`

The published folder URL recorded in provenance is derived automatically from
`TOKAMAK_MPC_DRIVE_FOLDER_ID`.
The OAuth client JSON file must be a Google desktop-app client credential file.
On the first `publish` or `run`, `dusk_backed_mpc_setup` opens a browser window for Google login
and stores the OAuth token at `TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH`.
The authenticated Google account must be able to add children to the configured folder and must
also be allowed to create file permissions and update file sharing restrictions on uploaded
archives; otherwise the publication step fails after upload.
If publication preflight or upload fails, the completed local CRS remains available and its
publication fields remain unchanged.

## Testing-Mode Builds

Like `trusted-setup`, `mpc-setup` uses the `testing-mode` cargo feature instead of a
runtime testing flag.

Native:

```bash
cargo run --release -p mpc-setup --features testing-mode --bin native_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/native-testing.intermediate \
  --output ./setup/mpc-setup/output/native-testing.final
```

Dusk-backed:

```bash
cargo run --release -p mpc-setup --features testing-mode --bin dusk_backed_mpc_setup -- \
  ceremony \
  --intermediate ./setup/mpc-setup/output/dusk-testing.intermediate \
  --output ./setup/mpc-setup/output/dusk-testing.final
```

## Output Layout

The intermediate directory contains ceremony state such as:

- `phase1_acc_*`
- `phase1_proof_*`
- `phase2_acc_*`
- `phase2_proof_*`
- contributor metadata files
- `dusk.response` in dusk-backed mode

The final output directory contains only:

- `combined_sigma.rkyv`
- `sigma_preprocess.rkyv`
- `sigma_verify.json`
- `crs_provenance.json`

Trusted setup and native MPC emit the same three Sigma files for local development, but their
provenance records `releaseEligible: false`. Neither is a release or deployment CRS and neither
may be published.

## CRS Provenance

`crs_provenance.json` is a final output artifact. Service-side loaders must require
`releaseEligible: true` before accepting a CRS for release or deployment, and should then verify
the applicable provenance fields and exact final CRS bytes.

For every CRS, the manifest also records:

- `releaseEligible`, which is true only for a Dusk-backed CRS
- `generated_at_utc`
- `compatibleBackendVersion`
- `subcircuitLibrary.packageName`
- `subcircuitLibrary.packageVersion`

For dusk-backed mode, the manifest records:

- the pinned Dusk source download URL
- the pinned Dusk contribution metadata
- the expected and actual Dusk raw SHA-256 digest
- whether the file was auto-downloaded
- whether used-range tau verification succeeded
- the maximum G1 and G2 exponents consumed by Tokamak phase 2
- the Google Drive folder URL used for publication
- the uploaded archive file name
- the SHA-256 digests of:
  - `combined_sigma.rkyv`
  - `sigma_preprocess.rkyv`
  - `sigma_verify.json`

## Service-Side Provenance Verification

When serving a dusk-backed CRS, the service wrapper should verify:

1. the pinned Dusk source metadata
2. the pinned Dusk raw SHA-256
3. the final CRS file hashes
4. the expected published folder URL, if the deployment relies on the automated upload path

Example checks:

```bash
jq -r '.phase1_source_provenance.DuskGroth16.pinned_contribution' "$CRS_DIR/crs_provenance.json"
jq -r '.phase1_source_provenance.DuskGroth16.expected_source_sha256' "$CRS_DIR/crs_provenance.json"
jq -r '.generated_at_utc' "$CRS_DIR/crs_provenance.json"
jq -r '.compatibleBackendVersion' "$CRS_DIR/crs_provenance.json"
jq -r '.subcircuitLibrary.packageName' "$CRS_DIR/crs_provenance.json"
jq -r '.subcircuitLibrary.packageVersion' "$CRS_DIR/crs_provenance.json"
jq -r '.published_folder_url' "$CRS_DIR/crs_provenance.json"
jq -r '.published_archive_name' "$CRS_DIR/crs_provenance.json"
jq -r '.crs_download_url' "$CRS_DIR/crs_provenance.json"
jq -r '.combined_sigma_sha256' "$CRS_DIR/crs_provenance.json"
shasum -a 256 "$CRS_DIR/combined_sigma.rkyv"
```

The service wrapper must compare the digest recorded in the manifest against the digest of
the exact file it is about to load.

## Current Notes

- The Tokamak phase-1 contract is x-only.
- `y` is introduced during phase 2.
- Later phase-2 contributors validate the disclosed `y`, but the first phase-2 step still
  determines that value.
- Downstream `preprocess`, `prove`, and `verify` continue to consume the same final CRS
  layout as before.

## Future Work

`dusk_backed_mpc_setup` is still a single-party phase-2 wrapper. It is convenient for local
generation and deployment preparation, but it is not a substitute for a real multi-party
phase-2 ceremony. A production ceremony that requires distributed phase-2 trust must split
the phase-2 contribution flow across multiple independent operators.
