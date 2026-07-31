# Tokamak zk-EVM native backend

Rust workspace implementing the Tokamak zk-SNARK setup, preprocessing, proving,
and verification algorithms described in the
[protocol paper](https://eprint.iacr.org/2024/507).

## Components

| Binary                  | Responsibility                                                |
| ----------------------- | ------------------------------------------------------------- |
| `trusted-setup`         | Generate a CRS with one trusted setup operator                |
| `native_mpc_setup`      | Run Tokamak phase 1 and phase 2                               |
| `dusk_backed_mpc_setup` | Derive phase 2 from a pinned Dusk powers-of-tau artifact      |
| `preprocess`            | Commit permutation and fixed function-instance data           |
| `prove`                 | Generate a proof for one synthesized transaction              |
| `verify`                | Verify the proof, preprocess commitments, and public instance |

## Distribution

The backend is not published as a standalone npm or crates.io package. Users
obtain the supported native workflow through
[`@tokamak-zk-evm/cli`](https://www.npmjs.com/package/@tokamak-zk-evm/cli),
which ships the compatible source, builds it locally, and installs its runtime
resources.

Repository source currently targets `2.1.4`. See
[CHANGELOG.md](../../CHANGELOG.md) for consumer-facing changes. The direct
Cargo commands below are for backend operators and repository contributors.

## Prerequisites

- Rust and Cargo
- Node.js and npm
- CMake and a working C/C++ toolchain
- Circom for setup and local subcircuit-library generation
- Platform dependencies documented by the [CLI](../cli/README.md)

Run commands from the backend workspace:

```bash
cd /path/to/Tokamak-zk-EVM/packages/backend
```

## Circuit library

All binaries use the same binary R1CS subcircuit library.

- Release builds of `trusted-setup`, `preprocess`, `prove`, and `verify` embed
  the library selected at build time.
- Non-release builds require
  `--subcircuit-library ../frontend/qap-compiler/subcircuits/library`.
- MPC builds prepare the local QAP compiler output and record it in
  `build-metadata-mpc-setup.json`.

The selected directory must contain `r1cs/subcircuit<N>.r1cs`. JSON R1CS files
are not accepted.

## Setup

### Trusted setup

```bash
cargo run --release -p trusted-setup -- \
  --output ./setup/trusted-setup/output
```

For a non-release build:

```bash
cargo run -p trusted-setup -- \
  --subcircuit-library ../frontend/qap-compiler/subcircuits/library \
  --output ./setup/trusted-setup/output
```

### MPC setup

```bash
# Native Tokamak phase 1 and phase 2
cargo run --release -p mpc-setup --bin native_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/native.intermediate \
  --output ./setup/mpc-setup/output/native.final

# Pinned Dusk phase-1 source followed by Tokamak phase 2
cargo run --release -p mpc-setup --bin dusk_backed_mpc_setup -- \
  --intermediate ./setup/mpc-setup/output/dusk.intermediate \
  --output ./setup/mpc-setup/output/dusk.final
```

The Dusk-backed release flow validates its pinned source and publishes the
result through the configured Google Drive account. Ceremony configuration,
provenance checks, and the phase-2 trust limitation are documented in the
[MPC operator guide](./setup/mpc-setup/README.md).

### Setup outputs

| File                    | Role                                                    | Used by                            |
| ----------------------- | ------------------------------------------------------- | ---------------------------------- |
| `combined_sigma.rkyv`   | Opaque versioned prover CRS archive                     | `prove` and browser CRS conversion |
| `sigma_preprocess.rkyv` | Opaque versioned preprocessing CRS archive              | `preprocess`                       |
| `sigma_verify.json`     | Verifier CRS in JSON                                    | `verify`                           |
| `crs_provenance.json`   | Ceremony source, version, publication, and SHA-256 data | Artifact authentication            |

Generate these files with a setup command or download the compatible immutable
archive from the
[CRS release folder](https://drive.google.com/drive/folders/14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv).
Keep the set together and verify `crs_provenance.json`. Do not edit or
reserialize `.rkyv` files.

## Preprocess, prove, and verify

The Synthesizer files in each command must come from the same transaction.

### Preprocess

```bash
cargo run --release -p preprocess -- \
  --crs ./setup/output \
  --synthesizer-stat ./synthesizer/output \
  --output ./preprocess/output
```

| Input                   | Role                                | Acquisition                                              |
| ----------------------- | ----------------------------------- | -------------------------------------------------------- |
| `sigma_preprocess.rkyv` | Preprocessing CRS                   | Compatible setup output or authenticated release archive |
| `permutation.json`      | Wire-equality cycles                | Synthesizer output                                       |
| `instance.json`         | Public and function-instance values | Same Synthesizer run                                     |
| Binary R1CS library     | Constraint definitions              | Embedded release library or explicit non-release path    |

Output: `preprocess.json`, containing verifier commitments as hex strings.

### Prove

```bash
cargo run --release -p prove -- \
  --crs ./setup/output \
  --synthesizer-stat ./synthesizer/output \
  --output ./prove/output
```

| Input                     | Role                                  | Acquisition                                              |
| ------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `combined_sigma.rkyv`     | Prover CRS                            | Compatible setup output or authenticated release archive |
| `placementVariables.json` | Placement IDs, offsets, and witnesses | Synthesizer output                                       |
| `permutation.json`        | Wire-equality cycles                  | Same Synthesizer run                                     |
| `instance.json`           | Public and function-instance values   | Same Synthesizer run                                     |
| Binary R1CS library       | Constraint definitions                | Embedded release library or explicit non-release path    |

Output: `proof.json`, using the native verifier/Solidity-compatible field and
point representation.

### Verify

```bash
cargo run --release -p verify -- \
  --crs ./setup/output \
  --synthesizer-stat ./synthesizer/output \
  --preprocess ./preprocess/output \
  --proof ./prove/output
```

| Input               | Role                                                           | Acquisition                                           |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `sigma_verify.json` | Verifier CRS                                                   | Matching setup output                                 |
| `instance.json`     | Public values asserted by the proof                            | Matching Synthesizer run or proof bundle              |
| `preprocess.json`   | Commitments for the matching permutation and function instance | Matching preprocess run                               |
| `proof.json`        | Proof to verify                                                | Matching prove run or trusted producer                |
| Binary R1CS library | Constraint definitions                                         | Embedded release library or explicit non-release path |

Output: `true` or `false` on stdout.

```text
setup/output/        synthesizer/output/       preprocess/output/   prove/output/
├── combined_sigma.rkyv  ├── instance.json        └── preprocess.json  └── proof.json
├── sigma_preprocess.rkyv├── permutation.json
└── sigma_verify.json    └── placementVariables.json
```

The CRS, circuit library, Synthesizer output, preprocess commitments, proof,
and backend must belong to compatible release lines.

## Performance and debugging

- [Measured native proving report](./prove/optimization/timing.release.md)
- [Raw timing data](./prove/optimization/timing.release.json)
- VS Code launch configurations: `.vscode/launch.json`

Timing results are reference observations for their recorded environment, not
deployment guarantees.

## Security and operator responsibilities

Setup operators own ceremony integrity, contributor coordination, provenance,
digest publication, and disposal of trusted-setup secrets. Artifact consumers
must authenticate the source and verify published digests.

Protect witnesses, instances, proofs, and transaction-derived files according
to the application's data policy. Keep RPC credentials and signing keys out of
backend directories. Backend commands can consume substantial CPU, GPU,
memory, disk, and time; apply suitable limits and isolation. A successful
proof or `true` result does not establish the security of the application,
circuit library, setup, distribution channel, or surrounding protocol.

## Project and license

- [CLI package](../cli/README.md)
- [Subcircuit Library](../frontend/qap-compiler/README.md)
- [Contributing](../../CONTRIBUTING.md)

The native backend is dual-licensed under `MIT OR Apache-2.0`.
