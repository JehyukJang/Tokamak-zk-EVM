# `@tokamak-zk-evm/cli`

The supported command-line entry point for installing the native Tokamak
zk-EVM runtime and running synthesis, preprocessing, proving, verification, and
proof export.

## Install and run

First prepare a directory containing the
[four synthesis input files](#synthesis-inputs). The
[`L2StateChannel` example](../frontend/synthesizer/examples/L2StateChannel)
shows the expected layout and values.

The quick start below assumes that the
[native requirements](#native-requirements) are already installed and
downloads the compatible CRS. Use
[`--include-prerequisite`](#automatic-prerequisite-installation) for a guided
macOS or Ubuntu setup, or `--docker` on another Linux distribution or Windows.

```bash
npm install -g @tokamak-zk-evm/cli
tokamak-cli --install
tokamak-cli --synthesize ./L2StateChannel
tokamak-cli --preprocess
tokamak-cli --prove
tokamak-cli --verify
```

The npm package installs the launcher and compatible source. `--install`
builds the native Rust backend on the target machine; there is no separate
backend npm package.

## Installation modes

| Command                                        | Use                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `tokamak-cli --install`                        | Build with prerequisites already installed and download compatible CRS artifacts |
| `tokamak-cli --install --include-prerequisite` | Offer to install missing prerequisites on macOS or supported Ubuntu releases     |
| `tokamak-cli --install --docker`               | Build and run in the packaged Linux container workflow                           |
| `tokamak-cli --install --trusted-setup`        | Generate setup artifacts locally instead of downloading them                     |
| `tokamak-cli --install --no-setup`             | Install without CRS artifacts; preprocess, prove, and verify remain unavailable  |

### Native requirements

- Node.js 20 or newer and npm
- Rust and Cargo 1.85 or newer
- CMake 3.18 or newer
- `pkg-config`, `tar`, and `unzip`
- C/C++ build tools
- Git, Ninja, Clang, LLDB, and LLD on Ubuntu
- outbound HTTPS to npm, crates.io, GitHub, GitHub Releases, and Google Drive

Native targets are macOS, Ubuntu 20.04, and Ubuntu 22.04. Other Linux
distributions should use Docker. Native Windows is unsupported; use WSL2 or
Docker Desktop.

Example host preparation:

```bash
# macOS: install prerequisites yourself
xcode-select --install
brew install node cmake pkg-config
curl https://sh.rustup.rs -sSf | sh

# Ubuntu 20.04 or 22.04: let the CLI propose missing prerequisites
npm install -g @tokamak-zk-evm/cli
tokamak-cli --install --include-prerequisite
```

Docker hosts need Node.js 20+, the CLI package, Docker, and a running daemon.
CUDA mode requires a successful CUDA 12.2 container probe, an NVIDIA GPU, and
driver `525.60.13` or newer.

### Automatic prerequisite installation

`--include-prerequisite` requires a TTY, prints the complete change plan, and
continues only after an explicit `y` or `yes`.

| Scope                 | Behavior                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| Ubuntu                | Uses targeted APT/LLVM commands and, on 20.04 when needed, a checksum-verified CMake 3.27.4 source archive |
| macOS                 | Uses Xcode Command Line Tools and Homebrew                                                                 |
| Rust                  | Uses the official rustup installer when missing or incompatible                                            |
| Never installed       | Node.js, npm, Docker, GPU drivers, and network configuration                                               |
| Privileged operations | Requests elevation only for the individual operation; do not run the complete CLI as root                  |
| Uninstall             | Removes only the CLI runtime, not system packages, Xcode tools, Rust, Homebrew, or source-installed CMake  |

Review external installer terms and organizational policy before approval. If
an installer fails, resolve its error and rerun the command; prerequisite
detection resumes without masking the failure.

### What `--install` creates

The installer:

- builds the native backend;
- downloads ICICLE runtime archives and verifies their packaged SHA-256
  digests;
- downloads the compatible CRS unless setup is skipped, validating version,
  provenance, and artifact hashes; and
- stores runtime resources under the CLI cache.

Docker installation records its state in
`~/.tokamak-zk-evm/linux/docker/bootstrap.json`. Linux falls back to a valid
native runtime when Docker is unavailable. Windows requires Docker Desktop
because native backend execution is unsupported.

## Commands

| Command                     | Input                                         | Result                                                |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `--install`                 | Installation options                          | Prepared local runtime                                |
| `--synthesize <DIR>`        | Four transaction replay JSON files            | Placement, instance, permutation, and state artifacts |
| `--preprocess [DIR_OR_ZIP]` | Matching permutation and instance             | Verifier preprocessing commitments                    |
| `--prove [DIR_OR_ZIP]`      | Matching placement, permutation, and instance | Proof                                                 |
| `--verify [DIR_OR_ZIP]`     | Matching proof, preprocess, and instance      | Verification result                                   |
| `--extract-proof <ZIP>`     | Completed cached workflow                     | Portable proof bundle                                 |
| `--doctor`                  | Installed runtime                             | Runtime path and installation status                  |
| `--uninstall`               | CLI cache                                     | Removes the CLI-owned runtime                         |

Relative paths are resolved from the current working directory.

## Synthesis inputs

`--synthesize <DIR>` expects these four files at the directory root:

| File                           | Role                                                                      | Format and owner                                                                                                          | How to obtain it                                                     | Example                                                                              |
| ------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `previous_state_snapshot.json` | State immediately before execution, including storage reconstruction data | [`tokamak-l2js` `StateSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts) | Call `TokamakL2StateManager.captureStateSnapshot()` before execution | [File](../frontend/synthesizer/examples/L2StateChannel/previous_state_snapshot.json) |
| `transaction.json`             | Signed Tokamak L2 transaction to replay                                   | [`tokamak-l2js` `TxSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts)    | Call `TokamakL2Tx.captureTxSnapshot()`                               | [File](../frontend/synthesizer/examples/L2StateChannel/transaction.json)             |
| `block_info.json`              | Block-opcode and execution-environment values                             | Synthesizer `BlockInfo` JSON                                                                                              | Normalize the trusted application or L2 RPC block context            | [File](../frontend/synthesizer/examples/L2StateChannel/block_info.json)              |
| `contract_codes.json`          | Deployed bytecode reached by the supported call flow                      | Synthesizer `ContractCodeEntry[]` JSON                                                                                    | Export deployment/state data or query the trusted state source       | [File](../frontend/synthesizer/examples/L2StateChannel/contract_codes.json)          |

`StateSnapshot` contains `stateRoots`, `storageAddresses`, `storageKeys`,
`storageTrieRoots`, `storageTrieDb`, and `channelId`. Its address-indexed arrays
must remain aligned. Storage-slot keys and trie database keys are not
interchangeable.

`TxSnapshot` contains `nonce`, `to`, hex calldata in `data`, `senderPubKey`,
and optional signature strings `v`, `r`, and `s`.

`block_info.json` contains `0x`-prefixed `coinBase`, `timeStamp`,
`blockNumber`, `prevRanDao`, `gasLimit`, `chainId`, `selfBalance`, and
`baseFee` values plus `prevBlockHashes`.

`contract_codes.json` is an address/bytecode array:

```json
[
  {
    "address": "0x...",
    "code": "0x..."
  }
]
```

Use the `StateSnapshot` and `TxSnapshot` exports from the compatible
`tokamak-l2js` package rather than recreating them. All four files must
describe one coherent pre-transaction state and block context.

```bash
# Conventional directory
tokamak-cli --synthesize ./L2StateChannel

# Explicit files
tokamak-cli --synthesize \
  --previous-state ./inputs/previous_state_snapshot.json \
  --transaction ./inputs/transaction.json \
  --block-info ./inputs/block_info.json \
  --contract-code ./inputs/contract_codes.json
```

## Backend inputs

Without an argument, backend commands use the preceding outputs in the runtime
cache. A supplied directory or ZIP contains only transaction-specific files;
the compatible CRS remains in the installed cache.

| Command        | External input            | Role and acquisition                                         |
| -------------- | ------------------------- | ------------------------------------------------------------ |
| `--preprocess` | `permutation.json`        | Synthesizer wire-equality cycles                             |
| `--preprocess` | `instance.json`           | Public and function-instance values from the same synthesis  |
| `--prove`      | `placementVariables.json` | Placement IDs, offsets, and witnesses from synthesis         |
| `--prove`      | `permutation.json`        | Matching Synthesizer permutation                             |
| `--prove`      | `instance.json`           | Matching Synthesizer instance                                |
| `--verify`     | `proof.json`              | Output of the matching prove run or a trusted proof producer |
| `--verify`     | `preprocess.json`         | Commitments from the matching preprocess run                 |
| `--verify`     | `instance.json`           | Instance asserted by the proof                               |

Installed setup files are:

| Cache file              | Used by    | Format                                   |
| ----------------------- | ---------- | ---------------------------------------- |
| `sigma_preprocess.rkyv` | Preprocess | Opaque versioned Rust CRS archive        |
| `combined_sigma.rkyv`   | Prove      | Opaque versioned Rust prover CRS archive |
| `sigma_verify.json`     | Verify     | JSON verifier CRS                        |

Do not place setup files in an external transaction directory. Do not mix
files from different synthesis runs or incompatible releases.

```text
preprocess-input/       prove-input/                 verify-input/
├── instance.json       ├── instance.json            ├── instance.json
└── permutation.json    ├── permutation.json         ├── preprocess.json
                        └── placementVariables.json  └── proof.json
```

```bash
tokamak-cli --preprocess ./artifacts
tokamak-cli --prove ./artifacts.zip
tokamak-cli --verify ./proof-bundle.zip
```

## Outputs and cache

The default cache root is `~/.tokamak-zk-evm`; override it with
`TOKAMAK_ZKEVM_CLI_CACHE_DIR`.

```text
<cache>/<platform>/runtime/resource/
├── setup/output
├── synthesizer/output
├── preprocess/output
└── prove/output
```

Synthesis writes `placementVariables.json`, `instance.json`,
`instance_description.json`, `permutation.json`, and `state_snapshot.json`.
Preprocess writes `preprocess.json`; prove writes `proof.json`.
`--synthesize` clears its previous output directory before writing.

`--extract-proof <OUTPUT_ZIP_PATH>` writes to the requested path and includes:

- `proof.json`
- `preprocess.json`
- `instance.json`
- `instance_description.json`
- `benchmark.json` when available

```bash
tokamak-cli --extract-proof ./proof-bundle.zip
tokamak-cli --verify ./proof-bundle.zip
```

`--doctor` prints the absolute runtime path and verifies that the current
platform has an installed runtime.

## npm publication

| Item              | Value                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| Package           | [`@tokamak-zk-evm/cli`](https://www.npmjs.com/package/@tokamak-zk-evm/cli) |
| Published version | `npm view @tokamak-zk-evm/cli version`                                     |
| Distribution      | npm launcher plus locally built native backend                             |
| Release notes     | [Repository `CHANGELOG.md`](../../CHANGELOG.md)                            |

## Security and operational responsibilities

Authenticate external directories, ZIP files, CRS artifacts, and their release
compatibility. Keep RPC credentials, signing keys, and wallet secrets out of
inputs, command history, proof bundles, and source control. Snapshots,
witnesses, logs, proofs, and cache contents may contain sensitive application
data.

Installation can invoke package managers, container tools, and network
services. Proof operations can consume substantial CPU, GPU, memory, disk, and
time. Apply appropriate authorization, resource limits, isolation, and
monitoring. Successful proving or verification does not establish the
security of the application, circuit library, setup, or surrounding protocol.

## Project and license

- [Source](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/cli)
- [Issues](https://github.com/tokamak-network/Tokamak-zk-EVM/issues)
- [Native backend](../backend/README.md)

Dual-licensed under `MIT OR Apache-2.0`. Dependencies retain their own
licenses.
