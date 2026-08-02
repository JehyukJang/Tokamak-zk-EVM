# `@tokamak-zk-evm/subcircuit-library`

Prebuilt circuit artifacts consumed by the Tokamak zk-EVM Synthesizer and
proving backends. The repository directory retains the historical
`qap-compiler` name because it also contains maintainer-side generation tools.

## Install

```bash
npm install @tokamak-zk-evm/subcircuit-library
```

Consumers install the npm package. They do not need to run the QAP compiler or
rebuild the circuits.

## When to use this package

Most applications should let the Synthesizer, CLI, or proving backend select
and resolve this package. Import it directly only when an integration needs a
specific published circuit file or is implementing one of those runtimes.

R1CS means rank-1 constraint system: the compiled constraints used during
setup and proving. Each matching WASM file generates witness values for one
subcircuit.

## How it is used

| Consumer                                        | Use                                                           |
| ----------------------------------------------- | ------------------------------------------------------------- |
| [Synthesizer](../synthesizer/README.md)         | Loads metadata and matching WASM witness generators           |
| [Native backend](../../backend/README.md)       | Uses binary R1CS files during setup and proving               |
| [Browser backend](../../backend-wasm/README.md) | Converts and validates compatible runtime artifacts           |
| [CLI](../../cli/README.md)                      | Installs the synchronized library in the local proof workflow |

The Node Synthesizer resolves installed assets at runtime. The Web Synthesizer
bundles the matching JSON and WASM assets at build time.

Fixed-capacity public-output buffers are zero-padded. The higher-level protocol
is responsible for filtering storage tuples with a zero address and log tuples
whose fields are all zero.

## Published artifacts

All files are acquired from the same installed npm package version:

| Path                                          | Role                                                     | Format                      | Example            |
| --------------------------------------------- | -------------------------------------------------------- | --------------------------- | ------------------ |
| `subcircuits/library/r1cs/subcircuit<N>.r1cs` | Compiled constraints used by setup and proving           | Circom binary R1CS          | `subcircuit0.r1cs` |
| `subcircuits/library/wasm/subcircuit<N>.wasm` | Witness generator for one subcircuit                     | WebAssembly                 | `subcircuit0.wasm` |
| `subcircuits/library/json/subcircuit<N>.json` | Compiler metadata for one subcircuit                     | JSON                        | `subcircuit0.json` |
| `subcircuits/library/setupParams.json`        | Circuit capacity and setup parameters                    | JSON numeric object         | Published file     |
| `subcircuits/library/globalWireList.json`     | Global-to-local wire mapping                             | JSON two-number tuple array | Published file     |
| `subcircuits/library/subcircuitInfo.json`     | Subcircuit catalog, wire ranges, and flattening metadata | JSON record array           | Published file     |
| `subcircuits/library/frontendCfg.json`        | Frontend buffer and subcircuit configuration             | JSON                        | Published file     |
| `subcircuits/library/generate_witness.js`     | Witness-generation entry point                           | JavaScript module           | Published file     |
| `subcircuits/library/witness_calculator.js`   | Runtime witness calculator                               | JavaScript module           | Published file     |
| `subcircuits/circom/constants.circom`         | Constants synchronized with the generated library        | Circom source               | Published file     |
| `build-metadata.json`                         | Build identity and dependency versions                   | JSON                        | Package root       |

The supported acquisition path is npm. Keep R1CS, WASM, metadata, constants,
and setup artifacts on one compatible release line.

Direct Node consumers can resolve a file without assuming an installation
directory:

```js
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const setupParamsPath = require.resolve('@tokamak-zk-evm/subcircuit-library/subcircuits/library/setupParams.json');
```

## Compatibility

- Consumer artifacts are platform-neutral.
- Maintainer-side regeneration requires Node.js 18+, Circom, and the validation
  process in [the maintainer documentation](./docs/README.md).
- The package is versioned with the other supported Tokamak zk-EVM packages.

## npm publication

| Item              | Value                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Package           | [`@tokamak-zk-evm/subcircuit-library`](https://www.npmjs.com/package/@tokamak-zk-evm/subcircuit-library) |
| Published version | `npm view @tokamak-zk-evm/subcircuit-library version`                                                    |
| Release notes     | [Repository `CHANGELOG.md`](../../../CHANGELOG.md)                                                       |

## Security and application responsibilities

Pin a compatible package version and verify the package source according to
the application's supply-chain policy. Do not combine artifacts from different
builds. Published constraints and witness generators do not by themselves
establish that a circuit, setup ceremony, integration, or surrounding protocol
is secure.

## Project and license

- [Maintainer documentation](./docs/README.md)
- [Tokamak zk-SNARK paper](https://eprint.iacr.org/2024/507)
- [Issues](https://github.com/tokamak-network/Tokamak-zk-EVM/issues)

Dual-licensed under `MIT OR Apache-2.0`.
