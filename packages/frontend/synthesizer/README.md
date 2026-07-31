# Tokamak zk-EVM Synthesizer

The Synthesizer replays one Tokamak Layer 2 transaction and produces the
transaction-specific circuit artifacts required by the proving backends.

## Choose a runtime

| Package                                                                                              | Use it when                                                     | Documentation                       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| [`@tokamak-zk-evm/synthesizer-node`](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-node) | A Node.js process reads and writes local JSON files             | [Node README](./node-cli/README.md) |
| [`@tokamak-zk-evm/synthesizer-web`](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-web)   | A browser application supplies objects, uploaded files, or URLs | [Web README](./web-app/README.md)   |

Both npm packages use the shared runtime under `core/`; `core/` is not a
standalone public package. Check the npm pages for published versions and
[CHANGELOG.md](../../../CHANGELOG.md) for release notes.

## Shared input contract

Each runtime consumes one coherent transaction replay payload:

| Property        | Role                                                                      | Format owner                                                                                                              | Acquisition                                                                |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `previousState` | State immediately before execution, including storage reconstruction data | [`tokamak-l2js` `StateSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts) | Call `TokamakL2StateManager.captureStateSnapshot()`                        |
| `transaction`   | Signed Tokamak L2 transaction to replay                                   | [`tokamak-l2js` `TxSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts)    | Call `TokamakL2Tx.captureTxSnapshot()`                                     |
| `blockInfo`     | L2 block and execution-environment values                                 | Synthesizer `BlockInfo`                                                                                                   | Normalize the trusted application or L2 RPC block context                  |
| `contractCodes` | Deployed bytecode required by the supported call flow                     | Synthesizer `ContractCodeEntry[]`                                                                                         | Export application deployment/state data or query the trusted state source |

The complete
[`L2StateChannel` example](./examples/L2StateChannel) contains the conventional
JSON filenames. The Node and Web package READMEs document each field and input
method.

## Shared outputs

Primary outputs are:

| File                        | Purpose                                                |
| --------------------------- | ------------------------------------------------------ |
| `placementVariables.json`   | Placement IDs, offsets, and witness values for proving |
| `instance.json`             | Public and function-instance field values              |
| `instance_description.json` | Human-readable descriptions aligned with the instance  |
| `permutation.json`          | Wire-equality cycles used by preprocessing and proving |
| `state_snapshot.json`       | `tokamak-l2js` state snapshot after execution          |

Supplementary execution logs and placement analysis are emitted only when
requested with `--output-supplement` in Node or `{ outputSupplement: true }` in
the Web output helpers.

The Node runtime resolves the installed subcircuit library at execution time.
The Web runtime bundles the compatible JSON and WASM circuit assets when the
package is built.

<a id="transaction-support-faq"></a>

## Transaction support

The Synthesizer is not limited to native transfers or a hardcoded ERC20
template. It supports contract calls when execution stays within the opcode
set, call flows, storage, memory, log handling, and runtime model implemented
by Tokamak zk-EVM. Current validation is strongest for ERC20 transfers and the
private-state mint, transfer, and redeem flows.

It should not be described as supporting every arbitrary Ethereum transaction.
Contract creation, precompiles, transient storage, blob opcodes,
invalid/self-destruct paths, and other unvalidated combinations are outside the
supported Tokamak L2 boundary.

## Project and license

- [Maintainer documentation](./docs/README.md)
- [Subcircuit Library](../qap-compiler/README.md)
- [Release notes](../../../CHANGELOG.md)

The published Synthesizer packages are dual-licensed under
`MIT OR Apache-2.0`. Dependencies retain their own licenses.
