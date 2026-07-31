# Tokamak zk-EVM

Tokamak zk-EVM converts Tokamak Network Layer 2 transaction execution into
Tokamak zk-SNARK proof artifacts. This monorepo contains the transaction
Synthesizer, a prebuilt subcircuit library, native and browser proving
backends, and the CLI that connects the complete workflow.

[TokamakL2JS](https://github.com/tokamak-network/TokamakL2JS) defines the
Tokamak L2 transaction and state snapshots consumed by the Synthesizer. The
proving protocol is described in
[An Efficient SNARK for Field-Programmable and RAM Circuits](https://eprint.iacr.org/2024/507).

## How the repository fits together

```text
Tokamak L2 snapshot
        │
        ▼
Synthesizer ──► placement, instance, and permutation artifacts
        │
        ├──► Native Rust backend ──► preprocess, proof, verification
        │
        └──► Browser backend ──────► preprocess, proof, verification
                 ▲
                 │
       Subcircuit library and compatible CRS
```

The CLI is the supported end-to-end local entry point. Package READMEs own
installation, commands, APIs, input formats, examples, and operational
responsibilities.

## Choose a package

| Need                                            | Package                                                                                                                                                                   | Purpose                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Complete local proof workflow                   | `@tokamak-zk-evm/cli` · [README](./packages/cli/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/cli)                                                     | Installs the native runtime and runs synthesis, preprocessing, proving, verification, and proof export. |
| File-based synthesis in Node.js                 | `@tokamak-zk-evm/synthesizer-node` · [README](./packages/frontend/synthesizer/node-cli/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-node) | Reads one Tokamak L2 replay snapshot from JSON files and writes circuit artifacts.                      |
| Synthesis in a browser application              | `@tokamak-zk-evm/synthesizer-web` · [README](./packages/frontend/synthesizer/web-app/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-web)    | Accepts objects, uploaded JSON files, or URLs and uses bundled circuit assets.                          |
| Browser preprocessing, proving, or verification | `@tokamak-zk-evm/snark-browser-compat` · [README](./packages/backend-wasm/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat)          | Converts runtime artifacts and runs Tokamak zk-SNARK operations in bundler-based browsers.              |
| Prebuilt circuit artifacts                      | `@tokamak-zk-evm/subcircuit-library` · [README](./packages/frontend/qap-compiler/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/subcircuit-library)     | Publishes R1CS, witness-generator WASM, metadata, and related circuit files.                            |
| Direct Rust backend development                 | [Backend workspace](./packages/backend/README.md) · source only                                                                                                           | Implements setup, preprocessing, proving, and verification.                                             |

## Releases and npm publication

The supported packages share one repository source version and compatible
release line. A manifest version is not a published release until it appears
on npm; use the npm links above as the source of truth for published versions
and dist-tags.

The Rust backend is not published as a standalone npm package. The CLI ships
the compatible source and builds it locally. Consumer-facing release notes are
maintained in [CHANGELOG.md](./CHANGELOG.md).

## Repository map

| Path                                                                 | Language                       | Responsibility                                                        |
| -------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| [`packages/cli`](./packages/cli)                                     | TypeScript                     | Native workflow installation and orchestration                        |
| [`packages/frontend/synthesizer`](./packages/frontend/synthesizer)   | TypeScript                     | Shared transaction-to-circuit runtime and Node/browser adapters       |
| [`packages/frontend/qap-compiler`](./packages/frontend/qap-compiler) | Circom, TypeScript, JavaScript | Circuit source generation and the published subcircuit library        |
| [`packages/backend`](./packages/backend)                             | Rust                           | Trusted/MPC setup, preprocessing, proving, and verification           |
| [`packages/backend-wasm`](./packages/backend-wasm)                   | TypeScript, WebAssembly        | Browser preprocessing, proving, verification, and artifact conversion |

The on-chain Solidity verifier is maintained separately in
[`Tokamak-zk-EVM-contracts`](https://github.com/tokamak-network/Tokamak-zk-EVM-contracts/blob/main/bridge/src/verifiers/TokamakVerifier.sol).
Use that repository's
[mainnet monitoring artifact](https://github.com/tokamak-network/Tokamak-zk-EVM-contracts/blob/main/docs/audit/monitoring/data/TPAC-Contract-Addresses.json)
for current deployment addresses rather than copying an address from this
README.

## Scope and compatibility

The supported pipeline verifies transaction signatures and input state,
executes supported opcodes, and reconstructs output state for the Tokamak L2
runtime model. It is not a claim of compatibility with arbitrary Ethereum L1
execution. Contract creation, precompiles, transient storage, blob opcodes,
invalid/self-destruct paths, and other unvalidated execution combinations are
outside the supported boundary.

Native proving uses ICICLE acceleration. The browser package supports
bundler-based preprocessing, proving, and verification. Tokamak zk-EVM is also
used by
[Tokamak Private App Channels](https://github.com/tokamak-network/Tokamak-zk-EVM-contracts).
Package-specific compatibility and verified environments are documented in the
corresponding package README.

## Learn more

- [LLM-readable repository map](./llms.txt)
- [Project overview on Medium](https://medium.com/tokamak-network/project-tokamak-zk-evm-67483656fd21) (updated January 2026)
- [Project slides](https://docs.google.com/presentation/d/1D49fRElwkZYbEvQXB_rp5DEy22HFsabnXyeMQdNgjRw/edit?usp=sharing)
- [Legacy Synthesizer GitBook](https://tokamak-network-zk-evm.gitbook.io/tokamak-network-zk-evm) (historical; package READMEs are current)

## License

Tokamak zk-EVM is dual-licensed under
[MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at your option.
Third-party dependencies and incorporated components retain their own
licenses.
