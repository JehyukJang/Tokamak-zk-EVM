# `@tokamak-zk-evm/synthesizer-web`

`@tokamak-zk-evm/synthesizer-web` is the browser-facing package for running the Tokamak zk-EVM synthesizer from uploaded files or application-provided payload objects.

## When to use this package

Use `@tokamak-zk-evm/synthesizer-web` when you need a browser-facing synthesis API that accepts payload objects or uploaded files and uses bundled subcircuit-library assets at runtime.

## Install

```bash
npm install @tokamak-zk-evm/synthesizer-web
```

## npm publication

| Item                              | Value                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Package                           | [`@tokamak-zk-evm/synthesizer-web`](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-web)                 |
| Current repository source version | `2.1.4`; check the npm page or `npm view @tokamak-zk-evm/synthesizer-web version` for the latest published version |
| Release policy                    | Versioned with the other supported Tokamak zk-EVM packages                                                         |
| Published runtime                 | ESM browser package with the compatible subcircuit-library assets bundled at build time                            |
| Release notes                     | [Repository `CHANGELOG.md`](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)              |

## Runtime Model

- The published build bundles the subcircuit library JSON and WASM artifacts at build time.
- Callers only provide the transaction/state/block/code payload.
- No extra subcircuit fetch or file upload step is required at runtime.

## Quick start

```ts
import { loadSynthesisInputFromUrls, saveSynthesisOutputToFiles, synthesize } from '@tokamak-zk-evm/synthesizer-web';

const payload = await loadSynthesisInputFromUrls({
  previousState: '/inputs/previous_state_snapshot.json',
  transaction: '/inputs/transaction.json',
  blockInfo: '/inputs/block_info.json',
  contractCodes: '/inputs/contract_codes.json',
});

const output = await synthesize(payload);
saveSynthesisOutputToFiles(output);
```

Pass `{ outputSupplement: true }` to include supplementary analysis outputs:

```ts
saveSynthesisOutputToFiles(output, { outputSupplement: true });
await postSynthesisOutput(url, output, undefined, { outputSupplement: true });
```

## Input Shape

`synthesize(input)` expects one transaction payload with:

- `previousState`
- `transaction`
- `blockInfo`
- `contractCodes`

The same logical input can be supplied in three forms:

| API                                       | Accepted form                        | When to use it                                                  |
| ----------------------------------------- | ------------------------------------ | --------------------------------------------------------------- |
| `synthesize(input)`                       | Parsed JavaScript objects            | The application already owns typed transaction and state data   |
| `loadSynthesisInputFromFiles(files)`      | Four `Blob` or browser `File` values | A user selects or drops local JSON files                        |
| `loadSynthesisInputFromUrls(urls, init?)` | Four URLs returning JSON             | The application serves or retrieves the inputs before synthesis |

All three forms use the following data contract:

| Property / conventional filename                 | Role                                                                            | Format owner                                                                                                              | How to obtain it                                                                                       | Complete example                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `previousState` / `previous_state_snapshot.json` | State immediately before the transaction, including storage reconstruction data | [`tokamak-l2js` `StateSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts) | Prepare a `TokamakL2StateManager`, then call `captureStateSnapshot()` before execution                 | [Example state snapshot](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/previous_state_snapshot.json) |
| `transaction` / `transaction.json`               | Signed Tokamak L2 transaction snapshot to replay                                | [`tokamak-l2js` `TxSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts)    | Create or load a `TokamakL2Tx`, then call `captureTxSnapshot()`                                        | [Example transaction](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/transaction.json)                |
| `blockInfo` / `block_info.json`                  | Block and execution-environment values used by block opcodes                    | This package's `BlockInfo` input contract                                                                                 | Normalize the target L2 block context from application state or a trusted RPC source                   | [Example block information](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/block_info.json)           |
| `contractCodes` / `contract_codes.json`          | Deployed bytecode required by the supported transaction call flow               | This package's `ContractCodeEntry[]` input contract                                                                       | Export deployed bytecode from application state, deployment artifacts, or the trusted state/RPC source | [Example contract code list](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/contract_codes.json)      |

`StateSnapshot` and `TxSnapshot` are imported from the `tokamak-l2js` version
recorded in this package's `buildMetadata`; they are not independently defined
browser compatibility shapes.

### Input formats

`previousState` has the `StateSnapshot` fields `stateRoots`,
`storageAddresses`, `storageKeys`, `storageTrieRoots`, `storageTrieDb`, and
`channelId`. The address-indexed storage arrays must remain aligned.
`storageKeys` contains original storage-slot keys, while
`storageTrieDb[*][*].key` contains trie database keys.

`transaction` has the `TxSnapshot` fields `nonce`, `to`, `data`,
`senderPubKey`, and optional signature strings `v`, `r`, and `s`.

`blockInfo` is an object whose `coinBase`, `timeStamp`, `blockNumber`,
`prevRanDao`, `gasLimit`, `chainId`, `selfBalance`, and `baseFee` members are
`0x`-prefixed hex strings. `prevBlockHashes` is an array of `0x`-prefixed hash
strings.

`contractCodes` is an array:

```json
[
  {
    "address": "0x...",
    "code": "0x..."
  }
]
```

Use inputs from one coherent pre-transaction state and block context. The
repository provides a complete
[L2StateChannel example set](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/frontend/synthesizer/examples/L2StateChannel).

The package also provides:

- `loadSynthesisInputFromFiles(...)`
- `loadSynthesisInputFromUrls(...)`
- `saveSynthesisOutputToFiles(...)`
- `postSynthesisOutput(...)`

Output helpers expose primary outputs by default. Supplementary outputs use logical keys such as `supplement/step_log.json` and `supplement/placements.json` when `{ outputSupplement: true }` is provided.

## Output files

`saveSynthesisOutputToFiles()` downloads the following primary JSON files:

| File                        | Role                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| `placementVariables.json`   | Witness values and subcircuit identity for every circuit placement              |
| `instance.json`             | Public and function-instance field values used by preprocess, prove, and verify |
| `instance_description.json` | Human-readable descriptions aligned with public instance values                 |
| `permutation.json`          | Wire-equality cycles used by preprocess and prove                               |
| `state_snapshot.json`       | `tokamak-l2js` `StateSnapshot` after transaction execution                      |

Keep `placementVariables.json`, `instance.json`, and `permutation.json` from
the same synthesis result. When supplementary output is enabled, the helper
also emits execution-step logs, circuit placements, and observed message-code
addresses under `supplement/`.

## Transaction Support

This package uses the shared Synthesizer transaction-support boundary. It is not limited to simple token or native transfers, but contract-call support depends on whether execution stays within the opcode set, call flows, storage/memory/log handling, and runtime model currently supported by Tokamak zk-EVM.

For the full consumer-facing answer, see the workspace [transaction support FAQ](../README.md#transaction-support-faq).

## Notes

- Build-time dependency metadata is exported as `buildMetadata`.
- The same metadata is also written to `build-metadata.json` in the published package root.
- `buildMetadata.dependencies.subcircuitLibrary.buildVersion` and `buildMetadata.dependencies.tokamakL2js.buildVersion` record the exact versions bundled into the published web package.
- This package targets browser-style runtimes and ESM consumption.
- Node CLI usage belongs to `@tokamak-zk-evm/synthesizer-node`.
- Workspace overview: [../README.md](../README.md)
- Repository changelog: [https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)

## Security and application responsibilities

The package parses caller-supplied objects, files, and URL responses in the
browser. Authenticate remote input sources as required by the application, and
do not embed RPC API keys, wallet credentials, or private signing keys in
browser bundles, input URLs, JSON payloads, or downloaded artifacts.

State snapshots, transaction snapshots, witnesses, and execution logs may be
sensitive application data. Decide whether they may be uploaded, cached, or
downloaded before invoking the corresponding helpers. Successful synthesis
does not by itself establish the security of the application, contract,
circuit library, trusted setup, or surrounding protocol.

## Project and license

- [Source repository](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/frontend/synthesizer/web-app)
- [Issue tracker](https://github.com/tokamak-network/Tokamak-zk-EVM/issues)
- [Release notes](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)

This package is dual-licensed under `MIT OR Apache-2.0`.
