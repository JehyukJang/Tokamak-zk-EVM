# Backend WASM rkyv decoder

Private Rust/WASM adapter used by the browser backend's CRS converter. It is
tooling, not prover or verifier runtime code.

## Responsibility

The decoder accepts native `combined_sigma.rkyv` bytes and returns a compact
section container used by TypeScript to create standalone prover, preprocess,
and verifier CRS binaries. It supports only the explicit native `SigmaRkyv`
shape from the compatible backend release.

This is intentionally not a generic rkyv decoder: archives depend on Rust type
layout and rkyv version. The returned section container is an in-memory adapter
format, not a persisted runtime or fixture format.

The crate also exports `decodeCombinedSigma` through `wasm-bindgen`. The generated
JavaScript package should be lazy-loaded by converter tooling rather than imported
by prover or verifier runtime code.

## Build

Build the browser package from this directory with:

```sh
npm run build
```

From the backend-wasm package root, the same build is available as:

```sh
npm run rkyv-decoder:build
```

Requirements:

- `cargo`
- `rustc` with the `wasm32-unknown-unknown` target installed
- `wasm-bindgen` CLI

The build regenerates ignored `pkg/` and `target/` outputs. Check the toolchain
without building with:

```sh
npm run check:build-tools
```

## Browser integration

The public converter owns decoder loading. `convertCrs()` transfers its source
buffer to a temporary Worker, loads this WASM module, creates the three runtime
CRS artifacts, and terminates the Worker.

```js
import { convertCrs } from '@tokamak-zk-evm/snark-browser-compat/converter';

const { proverCrs, preprocessCrs, verifierCrs } = await convertCrs(combinedSigmaRkyv);
```

The transfer detaches `combinedSigmaRkyv`. Pass
`combinedSigmaRkyv.slice()` when the application must retain the source.
Prover and verifier runtime modules must not import this decoder package.

## Node.js fixture integration

The Node.js wrapper is for local fixture preparation only. It reads the generated
WASM file from `pkg/` and exposes the same payload decoder shape:

```js
import { createCombinedSigmaRkyvPayloadDecoder } from '../../src/converter/conversion/rkyv-to-binary.js';
import { loadCombinedSigmaPayloadDecoder } from './tools/rkyv-decoder-wasm/src/node.js';

const payloadDecoder = await loadCombinedSigmaPayloadDecoder();
const decoder = createCombinedSigmaRkyvPayloadDecoder(payloadDecoder.decodeCombinedSigmaPayload);
```

Run `npm run rkyv-decoder:build` before using the Node.js wrapper. The wrapper is
still tooling-only and must not be imported by prover or verifier runtime modules.

## Publication and license

`@tokamak-zk-evm/backend-wasm-rkyv-decoder` is private and is not published as
a standalone npm package. Its generated WASM is incorporated into
[`@tokamak-zk-evm/snark-browser-compat`](../../README.md).

Dual-licensed under `MIT OR Apache-2.0`.
