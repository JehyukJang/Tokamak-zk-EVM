# Tokamak zk-EVM MPC setup

For phase 2 contributors, operators and backend implementers. Filecoin
supplies the externally completed phase 1; this repository implements only
Tokamak phase 2. There is no standalone phase 1 adapter or trusted import
receipt.

## Prerequisites and commands

Follow the [native build prerequisites](../../../README.md#prerequisites).
The executable links ICICLE through the shared native library. When running
`target/release/mpc` directly, include the ICICLE library directory in
`DYLD_LIBRARY_PATH` on macOS or `LD_LIBRARY_PATH` on Linux.

MPC runs only from a local repository checkout. Build one release-optimized
executable for both execution modes:

- `--mode development` requires `--subcircuit-library PATH` and takes a private
  snapshot of that local QAP build. Build QAP first. This mode cannot authorize
  publication.
- `--mode publish` acquires a compatible npm package at runtime. Pass
  `--library-version MAJOR.MINOR.PATCH` on `init` to select an exact version;
  omit it there to select the latest published version matching the backend's
  `MAJOR.MINOR` version. The selected version is recorded in the transcript.
  Later publish-mode operations use that recorded version and reject this
  option. Development-mode transcripts record `null` and use the local library
  path for subsequent operations. Publish mode requires Node.js and npm, does
  not modify repository manifests or dependencies, and has no local-QAP
  fallback.

Specify the mode before every operation. Publish mode selects the circuit input
for CRS publication to Google Drive; it does not distribute a binary. Only
`publish` uploads; `finalize` remains offline. Neither the Cargo profile nor a
Cargo feature selects the MPC circuit source.

Obtain `challenge_19` directly from the pinned
[Filecoin source](https://trusted-setup.filecoin.io/phase1/challenge_19), or
omit `--filecoin-source` to download it during the operation. The source is
77,309,411,488 bytes (about 72 GiB). Every invocation reads and hashes the
complete original before accepting state or sampling secret shares. Keeping a
local copy avoids a download, not the digest check.

From `packages/backend`:

```sh
cargo build --locked --release -p mpc-setup --bin mpc

target/release/mpc --mode development \
  --subcircuit-library ../frontend/qap-compiler/subcircuits/library \
  init --filecoin-source /path/to/challenge_19 --output ./initial.mpc

target/release/mpc --mode development \
  --subcircuit-library ../frontend/qap-compiler/subcircuits/library \
  contribute --filecoin-source /path/to/challenge_19 --input ./initial.mpc --output ./alice.mpc

target/release/mpc --mode development \
  --subcircuit-library ../frontend/qap-compiler/subcircuits/library \
  contribute --filecoin-source /path/to/challenge_19 --input ./alice.mpc --output ./bob.mpc

target/release/mpc --mode development \
  --subcircuit-library ../frontend/qap-compiler/subcircuits/library \
  verify --filecoin-source /path/to/challenge_19 --input ./bob.mpc

target/release/mpc --mode development \
  --subcircuit-library ../frontend/qap-compiler/subcircuits/library \
  finalize --filecoin-source /path/to/challenge_19 --input ./bob.mpc --output ./final-keys
```

For a publish ceremony, remove `--subcircuit-library ...` and replace
`--mode development` in every command with `--mode publish`. On `init`,
`--library-version <exact-compatible-version>` is optional; later operations
take the exact version from the input transcript and reject that option. Do not
rebuild the executable to change modes. Run contributor commands in each
contributor's own environment. Initialization is deterministic and is not a
contribution; each transcript output must use a new path.

## Checks and outputs

Source preparation verifies the pinned digest, file length, response header,
and required point families. Initialization derives circuit-specific material
from encoded powers. Each contribution updates the designated phase 2 state and
provides share-knowledge evidence; verification checks the full record chain
and final-family equations. The [design record](docs/current-phase2-design.md)
defines the exact source mapping, contribution evidence, and query handling.

Finalization requires at least one verified contribution and writes four common
CRS payloads plus `crs_provenance.json`. Offline finalization always records
`releaseEligible: false`. Ordinary proving users can consume distributed tau
files; contributors must authenticate the original Filecoin source themselves.

## Publish a completed ceremony

After participants independently complete a publish-mode transcript, one
operator can verify it, derive the final CRS, and upload it:

```sh
target/release/mpc --mode publish \
  publish --input /path/to/final.mpc --output ./rust/setup/output/crs \
  --filecoin-source /path/to/challenge_19
```

The command authenticates the original source, acquires the npm version recorded
in the transcript, verifies initialization and every contribution, and
requires at least one contribution. Only this result receives
`releaseEligible: true`. The standalone
`check_crs_publication` tool checks metadata and payloads only; it neither
verifies a ceremony nor authorizes upload.

Configure these environment variables only in the operator environment:

| Variable | Purpose |
| --- | --- |
| `TOKAMAK_MPC_DRIVE_FOLDER_ID` | Writable CRS root folder. |
| `TOKAMAK_MPC_DRIVE_OAUTH_CLIENT_JSON_PATH` | Installed-app OAuth client configuration. |
| `TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH` | Owner-only token-cache path. |

Keep credential files outside Git. Publication verifies completed payloads and
their SHA-256 values before staged activation. It rejects conflicting releases
and does not overwrite published artifacts. A failed command preserves local
output and reports the failed stage; rerunning rechecks the source and
transcript.

## Qualification and security status

The operator workflow verifies source, transcript, circuit identity, and
published artifacts. These operational checks do not by themselves certify an
application or Tokamak-specific phase 2 extensions.

Repository contributors can follow the [qualification guide](docs/qualification.md)
for development-only native E2E checks and release test scope. The
[MPC optimization report](../../../docs/optimization/current-univariate-mpc.md)
contains measured performance and reproduction evidence.

The [phase 2 design record](docs/current-phase2-design.md) and
[security references](docs/security-references.md) describe the contribution
construction, its assumptions, and the deferred analysis of Tokamak-specific
extensions. They are design material, not a live-ceremony qualification or
security certification.

## License

The MPC setup implementation and documentation are dual-licensed under
`MIT OR Apache-2.0`.
