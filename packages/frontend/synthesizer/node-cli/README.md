# `@tokamak-zk-evm/synthesizer-node`

`@tokamak-zk-evm/synthesizer-node` is the Node package for running the Tokamak zk-EVM synthesizer against JSON snapshot inputs.

## When to use this package

Use `@tokamak-zk-evm/synthesizer-node` when you want a file-based Node.js CLI that reads Tokamak L2 transaction replay JSON files from disk and writes synthesized JSON artifacts back to disk.

## Install

```bash
npm install @tokamak-zk-evm/synthesizer-node
```

## npm publication

| Item                              | Value                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Package                           | [`@tokamak-zk-evm/synthesizer-node`](https://www.npmjs.com/package/@tokamak-zk-evm/synthesizer-node)                |
| Current repository source version | `2.1.4`; check the npm page or `npm view @tokamak-zk-evm/synthesizer-node version` for the latest published version |
| Release policy                    | Versioned with the other supported Tokamak zk-EVM packages                                                          |
| Runtime dependencies              | Resolves the compatible published subcircuit library and bundles the recorded `tokamak-l2js` implementation         |
| Release notes                     | [Repository `CHANGELOG.md`](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)               |

## Package Role

- Exposes the published `synthesizer` CLI.
- Loads `@tokamak-zk-evm/subcircuit-library` from the installed dependency at runtime.
- Reads one JSON transaction replay payload from disk.
- Writes synthesized JSON artifacts back to disk.

The shared synthesis logic lives in `../core` and is bundled into this package at build time.

## CLI usage

```bash
npx synthesizer tokamak-ch-tx \
  --previous-state ./previous_state_snapshot.json \
  --transaction ./transaction.json \
  --block-info ./block_info.json \
  --contract-code ./contract_codes.json
```

## Required Input Files

The command reads four JSON files that together describe one transaction
replay:

| File                           | Role                                                                                               | Format owner                                                                                                              | How to obtain it                                                                                                      | Complete example                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `previous_state_snapshot.json` | State immediately before the transaction, including the data needed to reconstruct account storage | [`tokamak-l2js` `StateSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts) | Prepare a `TokamakL2StateManager`, then call `captureStateSnapshot()` before executing the transaction                | [Example state snapshot](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/previous_state_snapshot.json) |
| `transaction.json`             | Signed Tokamak L2 transaction snapshot to replay                                                   | [`tokamak-l2js` `TxSnapshot`](https://github.com/tokamak-network/TokamakL2JS/blob/main/src/interface/channel/types.ts)    | Create or load a `TokamakL2Tx`, then call `captureTxSnapshot()`                                                       | [Example transaction](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/transaction.json)                |
| `block_info.json`              | Block and execution-environment values consumed by block opcodes                                   | This package's `BlockInfo` input contract                                                                                 | Normalize the target L2 block context from the application or its trusted RPC source                                  | [Example block information](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/block_info.json)           |
| `contract_codes.json`          | Deployed bytecode required by the transaction's supported call flow                                | This package's `ContractCodeEntry[]` input contract                                                                       | Export bytecode from the application state, deployment artifacts, or the trusted state/RPC source used for the replay | [Example contract code list](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/frontend/synthesizer/examples/L2StateChannel/contract_codes.json)      |

`StateSnapshot` and `TxSnapshot` are not locally redefined compatibility
shapes. They are imported from the `tokamak-l2js` version recorded in this
package's `buildMetadata`. Applications that construct these files should use
the corresponding exported types and capture methods.

### Input formats

`previous_state_snapshot.json` serializes `StateSnapshot`:

| Field              | JSON shape                               | Meaning                                        |
| ------------------ | ---------------------------------------- | ---------------------------------------------- |
| `stateRoots`       | `string[]`                               | Tokamak state roots before execution           |
| `storageAddresses` | `string[]`                               | Storage-bearing contract addresses             |
| `storageKeys`      | `string[][]`                             | Original storage-slot keys grouped by address  |
| `storageTrieRoots` | `string[]`                               | Ethereum storage-trie roots grouped by address |
| `storageTrieDb`    | `{ "key": string, "value": string }[][]` | Trie database records used to rebuild storage  |
| `channelId`        | `number`                                 | Tokamak L2 state-channel identifier            |

The address-indexed arrays must remain aligned. The values under `storageKeys`
are storage-slot keys; `storageTrieDb[*][*].key` values are trie database keys.

`transaction.json` serializes `TxSnapshot`:

| Field          | JSON shape               | Meaning                      |
| -------------- | ------------------------ | ---------------------------- |
| `nonce`        | `number`                 | Transaction nonce            |
| `to`           | `string`                 | Destination address          |
| `data`         | `string`                 | Hex-encoded calldata         |
| `senderPubKey` | `string`                 | Tokamak L2 sender public key |
| `v`, `r`, `s`  | optional `string` values | Signature components         |

`block_info.json` contains `0x`-prefixed hex strings named `coinBase`,
`timeStamp`, `blockNumber`, `prevRanDao`, `gasLimit`, `chainId`, `selfBalance`,
and `baseFee`, plus a `prevBlockHashes` array of `0x`-prefixed hash strings.

`contract_codes.json` is an array of address and deployed-bytecode pairs:

```json
[
  {
    "address": "0x...",
    "code": "0x..."
  }
]
```

Use the four files from one coherent pre-transaction state and block context.
Do not combine a transaction with an unrelated state snapshot or contract-code
set.

The repository's complete
[L2StateChannel input directory](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/frontend/synthesizer/examples/L2StateChannel)
shows the files together.

## Transaction Support

This package uses the shared Synthesizer transaction-support boundary. It is not limited to simple token or native transfers, but contract-call support depends on whether execution stays within the opcode set, call flows, storage/memory/log handling, and runtime model currently supported by Tokamak zk-EVM.

For the full consumer-facing answer, see the workspace [transaction support FAQ](../README.md#transaction-support-faq).

Add `--output-supplement` when execution analysis outputs are needed.

## Output Files

The CLI writes primary outputs by default:

| File                        | Format and role                                                                    | Used by                                         |
| --------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| `placementVariables.json`   | JSON witness values, subcircuit IDs, and instance descriptions for every placement | Tokamak zk-EVM prover                           |
| `instance.json`             | JSON public and function-instance field values derived from the placement witness  | Preprocessor, prover, and verifier              |
| `instance_description.json` | JSON human-readable descriptions aligned with public instance values               | Proof-bundle inspection and application display |
| `permutation.json`          | JSON wire-equality cycles represented by `{ row, col, X, Y }` entries              | Preprocessor and prover                         |
| `state_snapshot.json`       | JSON `tokamak-l2js` `StateSnapshot` captured after transaction execution           | The application or a later transaction replay   |

With `--output-supplement`, it also writes:

| File                                     | Format and role                                                |
| ---------------------------------------- | -------------------------------------------------------------- |
| `supplement/step_log.json`               | JSON execution-step analysis for debugging                     |
| `supplement/placements.json`             | JSON circuit placements after EVM-to-Circom wire conversion    |
| `supplement/message_code_addresses.json` | JSON list of distinct code addresses observed during execution |

The downstream files are a matched set. Keep `placementVariables.json`,
`instance.json`, and `permutation.json` from the same synthesis run.

## Notes

- Build-time dependency metadata is exported as `buildMetadata`.
- The same metadata is also written to `build-metadata.json` in the published package root.
- `buildMetadata.dependencies.subcircuitLibrary.buildVersion` records the version present when this package was built, while the Node runtime still resolves the installed `@tokamak-zk-evm/subcircuit-library` package.
- `buildMetadata.dependencies.tokamakL2js.buildVersion` records the exact `tokamak-l2js` version bundled into the published package.
- Debug-only config execution lives under `examples/config-runner.ts`.
- Browser usage belongs to `@tokamak-zk-evm/synthesizer-web`.
- Workspace overview: [../README.md](../README.md)
- Repository changelog:
  [CHANGELOG.md](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)

## Security and application responsibilities

This package reads local JSON files and does not require an RPC API key, wallet
credential, or private signing key. If an external state-acquisition tool uses
those credentials to create the input files, keep them out of the JSON,
terminal history, output directory, and source control.

Treat state snapshots, transaction snapshots, witnesses, and execution logs
according to the application's data policy. Validate the source and coherence
of all four inputs before synthesis. Successful synthesis means that the
supported execution was converted into circuit artifacts; it does not by
itself establish the security of the application, contract, circuit library,
trusted setup, or surrounding protocol.

## Project and license

- [Source repository](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/frontend/synthesizer/node-cli)
- [Issue tracker](https://github.com/tokamak-network/Tokamak-zk-EVM/issues)
- [Release notes](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)

This package is dual-licensed under `MIT OR Apache-2.0`.
