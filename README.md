# Tokamak zk-EVM

Tokamak zk-EVM converts Tokamak Network Layer 2 transaction execution into
Tokamak zk-SNARK proof artifacts. This monorepo contains the transaction
Synthesizer, a prebuilt subcircuit library, native and browser proving
backends, and the CLI that connects the complete workflow. Its proving protocol
is described in the [Tokamak zk-SNARK paper](https://eprint.iacr.org/2024/507).

## Scope and compatibility

The supported pipeline verifies transaction signatures and input state,
executes supported opcodes, and reconstructs output state for the Tokamak L2
runtime model. The Synthesizer consumes the transaction and state snapshots
defined by [TokamakL2JS](https://github.com/tokamak-network/TokamakL2JS). This
is not a claim of compatibility with arbitrary Ethereum L1 execution. Contract
creation, precompiles, transient storage, blob opcodes, invalid/self-destruct
paths, and other unvalidated execution combinations are outside the supported
boundary.

Tokamak zk-EVM supports contract functions whose successful calls retain a
stable execution shape for all supported inputs and states. Applications must
validate their intended input and state domain against that boundary. See the
[Synthesizer transaction-support guide](./packages/frontend/synthesizer/README.md#transaction-support)
for the complete definition and validation guidance.

## Concrete application

[Tokamak Private App Channels](https://github.com/tokamak-network/Tokamak-zk-EVM-contracts)
uses Tokamak zk-EVM for proof-backed state transitions in DApp-specific
channels. Ethereum remains the custody, proof-verification, and settlement
layer for those channels.

## How the repository fits together

```text
Tokamak L2 snapshot
        │
        ▼
Synthesizer ──► transaction-specific artifacts
        │
        ├──► Native Rust backend ──► preprocess, proof, verification
        │
        └──► Browser backend ──────► preprocess, proof, verification
                 ▲
                 │
       Subcircuit library and compatible setup material
```

The [CLI](./packages/cli/README.md) is the supported end-to-end local entry
point. Each package README provides its installation, commands, APIs, input
formats, examples, and operational responsibilities.

Native proving runs on CPU by default and can use ICICLE CUDA acceleration
when explicitly selected. The browser package supports bundler-based
preprocessing, proving, and verification. Package-specific compatibility and
verified environments are documented in the corresponding package README.

Unless you are embedding one component in another application, start with the
CLI. In the package descriptions below, R1CS means the circuit's rank-1
constraint system, a witness contains the values that satisfy those
constraints, and a CRS is the common reference string used by the proving
system.

## Choose a package

| Need                                            | Package                                     | Documentation and publication                                                                                                        |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Complete local proof workflow                   | `@tokamak-zk-evm/cli`                       | [README](./packages/cli/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/cli)                                        |
| File-based synthesis in Node.js                 | `@tokamak-zk-evm/synthesizer-node`          | [README](./packages/frontend/synthesizer/node-cli/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-node) |
| Synthesis in a browser application              | `@tokamak-zk-evm/synthesizer-web`           | [README](./packages/frontend/synthesizer/web-app/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-web)   |
| Browser preprocessing, proving, or verification | `@tokamak-zk-evm/snark-browser-compat`      | [README](./packages/backend/wasm/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat)              |
| Prebuilt circuit artifacts                      | `@tokamak-zk-evm/subcircuit-library`        | [README](./packages/frontend/qap-compiler/README.md) · [npm](https://www.npmjs.com/package/@tokamak-zk-evm/subcircuit-library)       |
| Direct Rust backend development                 | Backend workspace; not separately published | [README](./packages/backend/README.md)                                                                                               |

## Releases and npm publication

Use mutually compatible versions of the supported packages. A version becomes
publicly available only when it appears on npm; the npm package pages above are
the source of truth for published versions and release tags.

The Rust backend is not published as a standalone npm package. The CLI ships
the compatible source and builds it locally. Consumer-facing release notes are
maintained in [CHANGELOG.md](./CHANGELOG.md).

## Technical evaluation

Tokamak zk-EVM is a specialized proving pipeline for the supported Tokamak L2
execution model, not a general Ethereum execution environment. Evaluate a
release against its published package versions, supported execution boundary,
and application-specific setup and deployment requirements.

- The [changelog](./CHANGELOG.md) records public protocol, compatibility, and
  measured performance changes.
- The [backend reports](./packages/backend/docs/optimization/) provide the
  underlying qualification and measurement evidence.

Setup and artifact provenance remain an application trust-boundary
responsibility.

## Learn more

- [Project overview on Medium](https://medium.com/tokamak-network/project-tokamak-zk-evm-67483656fd21) (updated January 2026)
- [Project slides](https://docs.google.com/presentation/d/1D49fRElwkZYbEvQXB_rp5DEy22HFsabnXyeMQdNgjRw/edit?usp=sharing)
- [Legacy Synthesizer GitBook](https://tokamak-network-zk-evm.gitbook.io/tokamak-network-zk-evm) (historical; package READMEs are current)
- [On-chain verifier and current deployment records](https://github.com/tokamak-network/Tokamak-zk-EVM-contracts)
- [LLM-readable repository map](./llms.txt)

## License

Tokamak zk-EVM is dual-licensed under
[MIT](./LICENSE-MIT) or [Apache-2.0](./LICENSE-APACHE), at your option.
Third-party dependencies and incorporated components retain their own
licenses.
