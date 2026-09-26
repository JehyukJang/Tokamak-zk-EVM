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
  Publish-mode `contribute` and `finalize` use the version recorded in their
  input transcript. The CLI rejects `--library-version` on every other
  operation. `upload` accepts only a finalized CRS directory and does not read
  a transcript. Development-mode transcripts record `null`; each development
  operation uses its supplied local library path. Publish mode requires Node.js
  and npm, does not modify repository manifests or dependencies, and has no
  local-QAP fallback.

Specify the mode before every operation. Publish mode selects the circuit input
for a release-eligible CRS; it does not distribute a binary. `finalize` verifies
the transcript and writes the completed CRS locally. The separate `upload`
operation sends that already finalized CRS to Google Drive without replaying the
ceremony or regenerating keys. Neither the Cargo profile nor a Cargo feature
selects the MPC circuit source.

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
  finalize --filecoin-source /path/to/challenge_19 --input ./bob.mpc --output ./final-keys
```

For a publish ceremony, remove `--subcircuit-library ...` and replace
`--mode development` in every command with `--mode publish`. On `init`,
`--library-version <exact-compatible-version>` is optional; `contribute` and
`finalize` take the exact version from their input transcript and reject that
option. `upload` takes only the finalized CRS directory. Do not rebuild the
executable to change modes. Run contributor commands in each contributor's
own environment. Initialization is deterministic and is not a contribution;
each transcript output must use a new path.

## Checks and outputs

Source preparation verifies the pinned digest, file length, response header,
and required point families. Initialization derives circuit-specific material
from encoded powers. Each contribution updates the designated phase 2 state and
provides share-knowledge evidence. `finalize` verifies the full record chain
and final-family equations before deriving CRS keys. The
[design record](docs/current-phase2-design.md) defines the exact source mapping,
contribution evidence, and query handling.

Finalization requires at least one verified contribution and writes four common
CRS payloads plus `crs_provenance.json`, which records the cumulative verified
phase-2 contribution count. Offline finalization always records
`releaseEligible: false`. Ordinary proving users can consume distributed tau
files; contributors must authenticate the original Filecoin source themselves.

## Upload a finalized CRS

After `finalize` has verified the transcript and produced a release-eligible
CRS directory, upload only that completed output:

```sh
target/release/mpc --mode publish \
  upload --crs-directory ./rust/setup/output/crs
```

The upload operation does not accept a transcript, library version, or Filecoin
source. It checks that the local directory contains a release-eligible CRS with
valid payload digests, then transfers those files. It does not verify the
ceremony or regenerate CRS keys. If a transfer is interrupted, rerun `upload`
with the same finalized CRS directory. The standalone
`check_crs_publication` tool checks metadata and payloads only; it neither
verifies a ceremony nor authorizes upload.

Configure these environment variables only in the operator environment:

| Variable | Purpose |
| --- | --- |
| `TOKAMAK_MPC_DRIVE_FOLDER_ID` | Writable CRS root folder. |
| `TOKAMAK_MPC_DRIVE_OAUTH_CLIENT_JSON_PATH` | Installed-app OAuth client configuration. |
| `TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH` | Owner-only token-cache path. |

Keep credential files outside Git. Finalization verifies the transcript and
creates the local CRS before upload. Upload checks the completed payloads and
their SHA-256 values, rejects conflicting releases, and does not overwrite
published artifacts. A failed upload preserves local output and reports the
failed stage.

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
