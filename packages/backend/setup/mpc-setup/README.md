# Tokamak zk-EVM MPC setup

Operator guide for generating Tokamak zk-SNARK CRS artifacts through the
native or Dusk-backed setup flow.

## Modes and distribution

| Binary                  | Phase-1 source                    | Phase 2         | Publication                                      |
| ----------------------- | --------------------------------- | --------------- | ------------------------------------------------ |
| `native_mpc_setup`      | Tokamak x-only phase 1            | Tokamak phase 2 | Local output                                     |
| `dusk_backed_mpc_setup` | Pinned Dusk Groth16 powers of tau | Tokamak phase 2 | Release builds upload to configured Google Drive |

Both binaries are part of the Rust backend workspace. They are not published
as standalone npm or crates.io packages. CLI users normally obtain compatible
CRS artifacts through
[`@tokamak-zk-evm/cli`](https://www.npmjs.com/package/@tokamak-zk-evm/cli).
Repository source currently targets `2.1.4`; release notes are in
[CHANGELOG.md](../../../../CHANGELOG.md).

The two modes produce the same final CRS layout. Intermediate ceremony state
is written to `--intermediate`; consumable artifacts are written to `--output`.
The [phase-2 output contract](./docs/phase2-output-contract.md) defines the
formulas, trapdoor ownership, contribution checks, and trust limitation.

## Prerequisites

- Complete the [native backend prerequisites](../../README.md#prerequisites).
- Install the official Circom compiler on `PATH`.
- Install OpenSSL when required by the platform.
- Run commands from `packages/backend`.

Cargo builds the local QAP compiler output and records the selected circuit
library in `build-metadata-mpc-setup.json`. The binaries do not accept a
runtime `--subcircuit-library` path.

## Native setup

```bash
cargo run --release -p mpc-setup --bin native_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/native.intermediate \
  --output ./setup/mpc-setup/output/native.final
```

Use `--beacon-mode` for deterministic seed-based beacon mode and
`--seed-input <PATH>` to supply wrapper seed input. Without testing mode, the
native phase-1 initialization scalar uses internal randomness.

## Dusk-backed setup

```bash
cargo run --release -p mpc-setup --bin dusk_backed_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

The flow uses `<intermediate>/dusk.response`. If missing, it downloads pinned
Dusk contribution `0015`. The compiled source URL, file ID, and SHA-256 digest
are authoritative; the wrapper verifies the digest and the used G1/G2 tau
ranges before phase 2.

A release run also:

1. validates the Google Drive environment and rejects a duplicate backend
   version;
2. validates `build-metadata-mpc-setup.json`;
3. creates a versioned, timestamped archive containing final CRS artifacts and
   build metadata;
4. uploads it and enables link-viewer download access; and
5. records publication data in the provenance manifest.

A non-release run performs generation but not publication:

```bash
cargo run -p mpc-setup --bin dusk_backed_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

## Publication environment

`dusk_backed_mpc_setup` reads:

```dotenv
TOKAMAK_MPC_DRIVE_FOLDER_ID=...
TOKAMAK_MPC_DRIVE_OAUTH_CLIENT_JSON_PATH=...
TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH=...
```

The OAuth client must be a Google desktop-app credential. The first
publication opens a browser for authentication and stores the token at the
configured path. The account needs permission to add files, create sharing
permissions, and update download restrictions. Preflight or upload failure
fails the complete run.

## Testing mode

Testing behavior is a Cargo feature, not a runtime flag:

```bash
cargo run --release --features testing-mode -p mpc-setup --bin native_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/native-testing.intermediate \
  --output ./setup/mpc-setup/output/native-testing.final

cargo run --release --features testing-mode -p mpc-setup --bin dusk_backed_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/dusk-testing.intermediate \
  --output ./setup/mpc-setup/output/dusk-testing.final
```

Testing-mode CRS must not be used as production setup material.

## Outputs and provenance

Intermediate directories contain phase accumulators, contribution proofs,
contributor metadata, and `dusk.response` for the Dusk-backed mode.

| Final file              | Format and role                                      |
| ----------------------- | ---------------------------------------------------- |
| `combined_sigma.rkyv`   | Opaque versioned prover CRS                          |
| `sigma_preprocess.rkyv` | Opaque versioned preprocessing CRS                   |
| `sigma_verify.json`     | Verifier CRS                                         |
| `crs_provenance.json`   | Source, version, publication, and final-file digests |

Every provenance manifest records generation time and backend version. A
Dusk-backed manifest additionally records the pinned source, expected and
actual source digest, verified exponent ranges, publication location, archive
name, and SHA-256 digest of every final CRS file.

Consumers must compare the recorded digest with the exact file they will load:

```bash
jq -r '.backend_version' "$CRS_DIR/crs_provenance.json"
jq -r '.combined_sigma_sha256' "$CRS_DIR/crs_provenance.json"
shasum -a 256 "$CRS_DIR/combined_sigma.rkyv"
```

## Security and operator responsibilities

The native phase-1 contract is x-only; `y` is introduced in phase 2.
`dusk_backed_mpc_setup` remains a single-party phase-2 wrapper and is not a
replacement for a distributed phase-2 ceremony. A deployment requiring
distributed phase-2 trust must coordinate independent contributors.

Operators own authentication credentials, ceremony integrity, provenance,
artifact publication, and disposal of setup secrets. Stop on source, range,
metadata, digest, or upload validation failures.

## Project and license

- [Backend overview](../../README.md)
- [Phase-2 output contract](./docs/phase2-output-contract.md)
- [CRS release folder](https://drive.google.com/drive/folders/14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv)

Dual-licensed under `MIT OR Apache-2.0`.
