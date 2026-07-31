# Tokamak zk-EVM

Tokamak zk-EVM is the open-source monorepo for converting Tokamak Network
Layer 2 transaction execution into zero-knowledge proof artifacts. It contains
the transaction Synthesizer, a prebuilt subcircuit library, native and browser
Tokamak zk-SNARK backends, and the command-line workflow that connects them.

[TokamakL2JS](https://github.com/tokamak-network/TokamakL2JS), a
Tokamak-specific toolkit built on EthereumJS, defines the Layer 2 transaction
and state model consumed by the Synthesizer. The proving protocol is
[Tokamak zk-SNARK](https://eprint.iacr.org/2024/507).

## Repository Scope

The repository covers the complete proof-artifact pipeline:

1. the Synthesizer replays a Tokamak L2 transaction and creates circuit inputs;
2. the subcircuit library supplies the compiled constraints and witness
   generators;
3. the native or browser backend preprocesses, proves, and verifies; and
4. the CLI coordinates the supported local workflow.

Detailed installation, API, command, input-file, and operational guidance
belongs to the package README selected below.

## Package Chooser

| Need                                                      | Install or read                                                                          | Role                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete local workflow                                   | [`@tokamak-zk-evm/cli`](./packages/cli/README.md)                                        | Installs the local runtime and runs synthesize, preprocess, prove, verify, and proof extraction commands.                                                |
| File-based synthesis in Node.js                           | [`@tokamak-zk-evm/synthesizer-node`](./packages/frontend/synthesizer/node-cli/README.md) | Reads Tokamak L2 transaction replay JSON files from disk and writes synthesized JSON artifacts back to disk.                                             |
| Browser-facing synthesis APIs                             | [`@tokamak-zk-evm/synthesizer-web`](./packages/frontend/synthesizer/web-app/README.md)   | Accepts payload objects or uploaded files and uses bundled subcircuit-library assets.                                                                    |
| Browser preprocessing, proof generation, and verification | [`@tokamak-zk-evm/snark-browser-compat`](./packages/backend-wasm/README.md)              | Preprocesses verifier commitments, generates and verifies Tokamak zk-SNARK proofs, and converts runtime artifacts in bundler-based browser applications. |
| Prebuilt circuit artifacts                                | [`@tokamak-zk-evm/subcircuit-library`](./packages/frontend/qap-compiler/README.md)       | Publishes R1CS artifacts, WASM witness-generation artifacts, JSON metadata, and related subcircuit-library files.                                        |

## npm Packages and Releases

The supported npm packages use one synchronized repository release version.
Repository manifests currently target `2.1.4`; npm availability can lag until
publication completes. Use each npm page as the source of truth for published
versions and dist-tags, select packages from the same release line, and follow
the package README:

| npm package                            | Distribution role                                                    | npm                                                                               |
| -------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `@tokamak-zk-evm/cli`                  | Complete local command-line workflow and native backend distribution | [View on npm](https://www.npmjs.com/package/@tokamak-zk-evm/cli)                  |
| `@tokamak-zk-evm/synthesizer-node`     | File-based Node.js transaction synthesis                             | [View on npm](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-node)     |
| `@tokamak-zk-evm/synthesizer-web`      | Browser-facing transaction synthesis                                 | [View on npm](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-web)      |
| `@tokamak-zk-evm/snark-browser-compat` | Browser preprocessing, proving, verification, and conversion         | [View on npm](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat) |
| `@tokamak-zk-evm/subcircuit-library`   | Prebuilt constraints, witness generators, and circuit metadata       | [View on npm](https://www.npmjs.com/package/@tokamak-zk-evm/subcircuit-library)   |

The Rust backend is not published as a standalone npm package. It is built and
installed for CLI users by `@tokamak-zk-evm/cli`. Release notes for every
supported package are maintained in [CHANGELOG.md](./CHANGELOG.md).

## Canonical Documentation

- [CLI package README](./packages/cli/README.md): local installation, commands,
  input files, output files, runtime requirements, and operational
  responsibilities.
- [Synthesizer workspace README](./packages/frontend/synthesizer/README.md): Synthesizer package chooser, shared input model, shared output model, and runtime model.
- [Synthesizer Node README](./packages/frontend/synthesizer/node-cli/README.md): file-based Node.js CLI usage.
- [Synthesizer Web README](./packages/frontend/synthesizer/web-app/README.md): browser-style API usage.
- [Browser-compatible SNARK README](./packages/backend-wasm/README.md): browser preprocess, prover, verifier, converter, artifact, deployment, and lifecycle APIs.
- [Subcircuit Library README](./packages/frontend/qap-compiler/README.md): published subcircuit artifact package contents and compatibility.
- [llms.txt](./llms.txt): root LLM-readable map for repository and package documentation.
- [CHANGELOG.md](./CHANGELOG.md): canonical release-note source for all npm-published packages in this monorepo.

## Repository FAQ

### What is Tokamak zk-EVM?

Tokamak zk-EVM is a monorepo for turning Tokamak Layer 2 transaction execution into zk-SNARK proof artifacts. It contains the command-line package, the transaction Synthesizer packages, the prebuilt subcircuit library package, and the Rust backend code for setup, proving, and verification.

### What is a Tokamak Layer 2 transaction?

A Tokamak Layer 2 transaction is the transaction format used by Tokamak's L2 execution model. In Tokamak zk-EVM, it is the unit of execution that the Synthesizer replays from a transaction snapshot: the snapshot carries the L2 transaction data, sender/signature material, calldata, previous state, contract code, and block context needed to reconstruct the transition and produce proof inputs. The TypeScript toolkit for Tokamak L2 transactions, state snapshots, and ZKP-friendly cryptography is `tokamak-l2js`: https://www.npmjs.com/package/tokamak-l2js. Its source repository is https://github.com/tokamak-network/TokamakL2JS.

### What are the main package groups in this monorepo?

The monorepo has five main supported package groups. The CLI package is the end-to-end local entry point. The Synthesizer packages convert Tokamak L2 transaction replay data into circuit-ready inputs. The browser-compatible SNARK package provides browser preprocessing, proof generation, verification, and artifact conversion. The subcircuit library package publishes the prebuilt R1CS, WASM witness-generation artifacts, and metadata consumed by the Synthesizer and backend. The native backend packages implement setup, proof generation, and proof verification for the Tokamak zk-SNARK proving system.

### Which npm package should I install?

If you are new to Tokamak zk-EVM or want the complete local workflow, install `@tokamak-zk-evm/cli`. It is the main package for installing the local runtime and running synthesize, preprocess, prove, verify, and proof extraction commands. Use `@tokamak-zk-evm/synthesizer-node` for file-based Node.js synthesis, `@tokamak-zk-evm/synthesizer-web` for browser synthesis, and `@tokamak-zk-evm/snark-browser-compat` for browser preprocessing, proof generation, verification, and artifact conversion. Use `@tokamak-zk-evm/subcircuit-library` only when consuming the prebuilt subcircuit artifacts directly.

### What does `tokamak-cli` do?

`tokamak-cli` installs and prepares the local Tokamak zk-EVM runtime, runs synthesis from Tokamak L2 transaction snapshots, runs backend preprocessing and proving, verifies proof artifacts, and can extract proof bundles for later verification.

### What is the subcircuit library?

The subcircuit library is the published package of prebuilt circuit artifacts used by Tokamak zk-EVM. It contains R1CS artifacts, WASM witness-generation artifacts, JSON metadata, and related files that let the Synthesizer and backend use a consistent circuit library without rebuilding every circuit from source.

### What does the Synthesizer do?

The Synthesizer takes a Tokamak L2 transaction replay payload and turns it into the artifacts required by the proving pipeline. Its input includes previous state, transaction data, block information, and contract code. Its output includes circuit placement data, public instances, permutation data, final state data, and execution analysis files.

### What backend proving and verification protocol does Tokamak zk-EVM use?

The backend proving and verification packages are based on Tokamak zk-SNARK. The protocol is described in `An Efficient SNARK for Field-Programmable and RAM Circuits` by Jehyuk Jang and Jamie Judd, IACR Cryptology ePrint Archive 2024/507: https://eprint.iacr.org/2024/507.

### Is there an on-chain Solidity verifier implementation?

Yes. The on-chain Solidity verifier implementation lives in the `tokamak-network/Tokamak-zk-EVM-contracts` repository: https://github.com/tokamak-network/Tokamak-zk-EVM-contracts. The Tokamak verifier contract source is `bridge/src/verifiers/TokamakVerifier.sol`: https://github.com/tokamak-network/Tokamak-zk-EVM-contracts/blob/main/bridge/src/verifiers/TokamakVerifier.sol. The current Ethereum mainnet deployment artifact lists `tokamakVerifier` at `0x0C467a5082323Cc6F4b7077A9dFb0bbdaf6eC626`, which can be inspected on Etherscan: https://etherscan.io/address/0x0C467a5082323Cc6F4b7077A9dFb0bbdaf6eC626.

### What is the difference between `synthesizer-node` and `synthesizer-web`?

`@tokamak-zk-evm/synthesizer-node` is a Node.js CLI package that reads JSON files from disk and writes synthesized JSON artifacts back to disk. `@tokamak-zk-evm/synthesizer-web` is a browser-facing package that accepts payload objects or uploaded files and bundles the subcircuit library assets at build time.

### Does the Synthesizer support complex contract-call transactions?

Partially, yes. The Synthesizer is not limited to simple native transfers or a hardcoded ERC20 transfer template. It accepts a complete transaction replay payload, including transaction data, contract code, previous state, and block information, then follows the Tokamak L2/EVM execution path to produce circuit-ready artifacts. For complex contracts, support is not determined by whether the transaction is an ERC20 transfer, a native transfer, or another simple transaction type. Instead, support depends on whether the execution stays within the opcode set, call flows, storage/memory/log handling, and runtime model currently supported by Tokamak zk-EVM.

### Is Tokamak zk-EVM intended for arbitrary Ethereum L1 execution?

No. Tokamak zk-EVM is designed under the strict assumption that it is used in Ethereum Layer 2 execution. Features outside that target runtime model are intentionally excluded from the consumer support claim.

### Which features are intentionally scoped out?

Transactions that require unsupported behavior, such as contract creation, precompiled contracts, transient storage, blob opcodes, invalid/selfdestruct paths, or other unvalidated opcode/control-flow combinations, are outside the supported consumer claim. These limitations are intentional scope boundaries rather than underdevelopment or future work.

### Are browser preprocessing, proof generation, and verification officially supported?

Yes. Use `@tokamak-zk-evm/snark-browser-compat` for supported bundler-based browser preprocessing, proof generation, and verification. Its package README defines the required browser capabilities, binary inputs, installation lifecycle, and verified environments. Legacy WASM verifier packages remain deprecated and should be treated only as historical or reference material. For on-chain verification, use the Solidity verifier contracts in `tokamak-network/Tokamak-zk-EVM-contracts` and the deployed verifier addresses published with the bridge artifacts.

### Where are release notes maintained?

Release notes are maintained in the root `CHANGELOG.md`. Package artifacts do not include package-local changelog files; package READMEs link back to the root changelog as the canonical release-note source.

## Package Composition

![Tokamak-zk-EVM Flow Chart](.github/assets/flowchart.png)

### Frontend Packages (compilers)

| Package                                                        | Description                                                                               | Language   | Repo Version | Published Package                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| [`qap-compiler`](./packages/frontend/qap-compiler)             | Maintainer-side generator for the published subcircuit library package                    | Circom     | `2.1.4`      | [`@tokamak-zk-evm/subcircuit-library`](https://www.npmjs.com/package/@tokamak-zk-evm/subcircuit-library) |
| [`synthesizer-node`](./packages/frontend/synthesizer/node-cli) | Node CLI package that converts Tokamak L2 transaction snapshots into circuit inputs       | TypeScript | `2.1.4`      | [`@tokamak-zk-evm/synthesizer-node`](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-node)     |
| [`synthesizer-web`](./packages/frontend/synthesizer/web-app)   | Browser-facing package that converts Tokamak L2 transaction snapshots into circuit inputs | TypeScript | `2.1.4`      | [`@tokamak-zk-evm/synthesizer-web`](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-web)       |

### Browser-Compatible SNARK Package

| Package                                   | Description                                                                            | Language   | Repo Version | Published Package                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| [`backend-wasm`](./packages/backend-wasm) | Browser preprocessing, proof generation, verification, and artifact conversion package | TypeScript | `2.1.4`      | [`@tokamak-zk-evm/snark-browser-compat`](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat) |

### CLI Package

| Package                         | Description                                                                                       | Language   | Repo Version | Published Package                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- | ------------ | -------------------------------------------------------------------------- |
| [`tokamak-cli`](./packages/cli) | npm-distributed launcher package that builds the backend locally and exposes the Tokamak CLI flow | TypeScript | `2.1.4`      | [`@tokamak-zk-evm/cli`](https://www.npmjs.com/package/@tokamak-zk-evm/cli) |

### Backend Packages

| Package                                                   | Description                                                          | Language       | Repo Version | Distribution                                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------- | -------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| [`mpc-setup`](./packages/backend/setup/mpc-setup)         | Tokamak zk-SNARK's setup algorithm (multi-party computation version) | Rust           | `2.1.4`      | [Published CRS artifacts](https://drive.google.com/drive/u/0/folders/14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv) |
| [`trusted-setup`](./packages/backend/setup/trusted-setup) | Tokamak zk-SNARK's setup algorithm (trusted single entity version)   | Rust           | `2.1.4`      | Source-only in this repository                                                                          |
| [`prover`](./packages/backend/prove)                      | Tokamak zk-SNARK's proving algorithm                                 | Rust           | `2.1.4`      | Source-only in this repository                                                                          |
| [`verify`](./packages/backend/verify)                     | Tokamak zk-SNARK's verifying algorithm                               | Rust, Solidity | `2.1.4`      | Source-only in this repository                                                                          |

Release versions are synchronized from the root repository version. The root [CHANGELOG.md](./CHANGELOG.md) is the canonical changelog for npm-published package consumers; record only changes that affect published package artifacts or their consumer-facing behavior. Package artifacts do not include changelog files; package READMEs link to the root changelog instead.

## Project Status

The current `main` release is `2.1.4`. The supported Tokamak Layer 2 proof
pipeline covers transaction-signature verification, input-state verification,
supported opcode execution, and output-state reconstruction. Native proving
uses ICICLE acceleration, and the browser package supports bundler-based
preprocessing, proving, and verification.

Tokamak zk-EVM is compatible with
[Tokamak Private App Channels](https://github.com/tokamak-network/Tokamak-zk-EVM-contracts).
Its supported execution boundary is summarized in the
[repository FAQ](#does-the-synthesizer-support-complex-contract-call-transactions);
package-specific limitations and verified environments belong to the
corresponding package README.

## Documentation

- [Project Tokamak Network ZKP (Medium)](https://medium.com/tokamak-network/project-tokamak-zk-evm-67483656fd21) (Last updated in Nov. 2025)
- [Project Tokamak zk-EVM(Slide)](https://docs.google.com/presentation/d/1D49fRElwkZYbEvQXB_rp5DEy22HFsabnXyeMQdNgjRw/edit?usp=sharing) (Last updated in Jul. 2025)
- [Tokamak zk-SNARK Paper](https://eprint.iacr.org/2024/507) (Last updated in Apr. 2025)
- Frontend - [Synthesizer](https://tokamak-network-zk-evm.gitbook.io/tokamak-network-zk-evm) (work in progress)
<!-- - [API Reference](./docs/api) -->
