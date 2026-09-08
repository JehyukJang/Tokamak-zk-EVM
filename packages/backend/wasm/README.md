# @tokamak-zk-evm/snark-browser-compat

`@tokamak-zk-evm/snark-browser-compat` provides browser-compatible
preprocessing, proving, verification, and artifact conversion for the current
Tokamak zk-EVM univariate proving protocol. It is not a generic proving-system
API and does not synthesize transactions.

## Audience and scope

This package is for browser application developers who already have the
artifacts produced by the Tokamak synthesizer and backend trusted setup. Use the
Tokamak CLI for the complete local synthesis and native backend workflow.

The package exposes four ESM subpaths:

```ts
import('@tokamak-zk-evm/snark-browser-compat/preprocess');
import('@tokamak-zk-evm/snark-browser-compat/prover');
import('@tokamak-zk-evm/snark-browser-compat/verifier');
import('@tokamak-zk-evm/snark-browser-compat/converter');
```

Do not import the package root, `dist/` files, generated constants, or runtime
internals. The package performs no network or filesystem I/O.

## Install

```sh
npm install @tokamak-zk-evm/snark-browser-compat
```

The browser runtime uses BLS12-381 through ffjavascript. Vite and Webpack ESM
consumers are supported. Applications must serve WebAssembly and emitted worker
assets with appropriate MIME types and content-security policy.

## Artifact model

The current protocol accepts the following independent binary artifacts:

| Artifact | Owner | Consumer |
| --- | --- | --- |
| `selector` | Synthesizer | Preprocess, prover, verifier configuration |
| `permutation` | Synthesizer | Preprocess, prover, verifier configuration |
| `witness` | Synthesizer | Prover |
| `instance` | Synthesizer | Prover and verifier |
| `proverCrs` | Backend trusted setup | Prover |
| `preprocessCrs` | Backend trusted setup | Preprocess and verifier configuration |
| `verifierCrs` | Backend trusted setup | Verifier |
| `verifierPreprocess` | `preprocess()` | Verifier |
| `proof` | `prove()` | Verifier |

`proof` contains exactly the current protocol's eleven affine G1 values and
nine scalar evaluations. The selector, transcript state, configuration, and
provenance are not duplicated inside the proof.

All binaries use the backend-owned `TZBWASM1` container. The container records
the artifact kind, producer package version, section table, and self-digest.
Its layout version is not a protocol-version compatibility layer.

## Public API reference

| Export | Purpose |
| --- | --- |
| `prover.install(options?)` | Install or reconfigure the prover runtime while idle |
| `prover.prove(input)` | Produce one complete proof binary |
| `preprocess.install(options?)` | Install or reconfigure the preprocessing runtime while idle |
| `preprocess.preprocess(input)` | Produce the two verifier preprocessing commitments |
| `verifier.install()` | Install the verifier runtime |
| `verifier.verify(input)` | Check one current-protocol proof |
| `convertWitness(value)` | Convert synthesizer placement variables |
| `convertSelector(value)` | Convert the synthesizer placement selector |
| `convertPermutation(value)` | Convert the synthesizer permutation |
| `convertInstance(value)` | Convert the synthesizer public instance |
| `convertUnivariateCrs(value)` | Split the native univariate CRS JSON projection by runtime role |
| `inspectBinary(bytes)` | Inspect a binary container without a validity claim |
| `validateBinary(bytes)` | Validate binary layout, shape, and self-digest |

Public operation types are `ProverInput`, `ProverInstallOptions`,
`ProverInstallationInfo`, `PreprocessInput`, `PreprocessInstallOptions`,
`PreprocessInstallationInfo`, `VerifierInput`, and
`VerifierInstallationInfo`. Converter types are `BinaryArtifactInspection`,
`BinarySectionInspection`, `ConvertedCrs`, and
`RuntimeArtifactFileValidationResult`. Every public subpath exports
`BackendWasmError` and `BackendWasmErrorCode`.

## Convert source artifacts

Converters accept the producer-owned JSON shapes and return browser binary
artifacts. They require no runtime installation.

```ts
import {
  convertInstance,
  convertPermutation,
  convertSelector,
  convertUnivariateCrs,
  convertWitness,
  inspectBinary,
  validateBinary,
} from '@tokamak-zk-evm/snark-browser-compat/converter';

const [witnessSource, selectorSource, permutationSource, instanceSource, crsSource] =
  await Promise.all([
    fetch('/sources/placementVariables.json').then(response => response.json()),
    fetch('/sources/selector.json').then(response => response.json()),
    fetch('/sources/permutation.json').then(response => response.json()),
    fetch('/sources/instance.json').then(response => response.json()),
    fetch('/sources/univariate_crs.json').then(response => response.json()),
  ]);

const [witness, selector, permutation, instance, crs] = await Promise.all([
  convertWitness(witnessSource),
  convertSelector(selectorSource),
  convertPermutation(permutationSource),
  convertInstance(instanceSource),
  convertUnivariateCrs(crsSource),
]);

await validateBinary(crs.proverCrs);
console.log(await inspectBinary(crs.proverCrs));
```

`inspectBinary()` reports container metadata without making a validity claim.
`validateBinary()` checks the container structure, artifact specification, and
self-digest. Neither function authenticates the producer.

Development builds generate embedded circuit metadata from the local
qap-compiler output. Production builds select the pinned npm
`@tokamak-zk-evm/subcircuit-library` snapshot. Both modes use the same runtime
artifact interfaces.

## Preprocess

Install the preprocessing runtime once, then commit the admitted selector and
permutation using the preprocessing CRS.

```ts
import {
  install as installPreprocess,
  preprocess,
} from '@tokamak-zk-evm/snark-browser-compat/preprocess';
import { loadBinary } from './load-binary.js';

await installPreprocess({ chunkSizeExponent: 17 });

const [selector, permutation, preprocessCrs] = await Promise.all([
  loadBinary('/artifacts/selector.bin'),
  loadBinary('/artifacts/permutation.bin'),
  loadBinary('/artifacts/preprocess-crs.bin'),
]);

const verifierPreprocess = await preprocess({
  selector,
  permutation,
  preprocessCrs,
});
```

`preprocess()` returns the two G1 commitments required by the current verifier.
It does not consume the witness or public instance.

## Prove

Install the prover once and generate a complete proof in one call.

```ts
import {
  install as installProver,
  prove,
} from '@tokamak-zk-evm/snark-browser-compat/prover';
import { loadBinary } from './load-binary.js';

await installProver({ chunkSizeExponent: 18 });

const [witness, selector, permutation, instance, proverCrs] = await Promise.all([
  loadBinary('/artifacts/witness.bin'),
  loadBinary('/artifacts/selector.bin'),
  loadBinary('/artifacts/permutation.bin'),
  loadBinary('/artifacts/instance.bin'),
  loadBinary('/artifacts/prover-crs.bin'),
]);

const proof = await prove({
  witness,
  selector,
  permutation,
  instance,
  proverCrs,
});
```

Only one proof operation may use the installed runtime at a time. Concurrent
calls reject with `BackendWasmError` code `BUSY`. The chunk exponent must be an
integer from 10 through 19 and may be changed while the runtime is idle.

## Verify

The verifier admits the fixed selector, permutation, preprocessing CRS,
preprocessing commitments, and verifier CRS before checking the proof and
public instance.

```ts
import {
  install as installVerifier,
  verify,
} from '@tokamak-zk-evm/snark-browser-compat/verifier';
import { loadBinary } from './load-binary.js';

await installVerifier();

const [proof, instance, selector, permutation, preprocessCrs, verifierPreprocess, verifierCrs] =
  await Promise.all([
    loadBinary('/artifacts/proof.bin'),
    loadBinary('/artifacts/instance.bin'),
    loadBinary('/artifacts/selector.bin'),
    loadBinary('/artifacts/permutation.bin'),
    loadBinary('/artifacts/preprocess-crs.bin'),
    loadBinary('/artifacts/verifier-preprocess.bin'),
    loadBinary('/artifacts/verifier-crs.bin'),
  ]);

const valid = await verify({
  proof,
  instance,
  selector,
  permutation,
  preprocessCrs,
  verifierPreprocess,
  verifierCrs,
});
```

`verify()` returns `false` for a well-formed proof that fails the protocol
equations. Installation, concurrency, malformed artifacts, and runtime failures
reject with `BackendWasmError`.

## Loading binaries

Applications own artifact acquisition, authentication, caching, and
invalidation. Complete I/O before calling a runtime operation:

```ts
export async function loadBinary(url: string | URL): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
```

Source provenance remains an application trust-boundary concern. Runtime
admission checks the exact binary kind and required sections but does not use
`releaseEligible` as a preprocess, prove, or verify gate.

## Development workflow

From `packages/backend/wasm`:

```sh
npm run build:development
npm run typecheck:development
npm run typecheck:scripts
npm run binary:check
npm run univariate:domain:check
npm run univariate:relation:check
npm run univariate:polynomial:check
npm run univariate:transcript:check
```

To prepare local browser E2E inputs, first generate `selector.json` with the
synthesizer and `univariate_crs.json` with native trusted setup. Then run:

```sh
npm run fixtures:copy
npm run fixtures:prepare
npm run prover:browser:check
```

The fixture preparation step converts owner-package outputs; it does not invoke
native setup, preprocessing, proving, or verification on behalf of the owner.

See [`examples/browser`](./examples/browser) for a runnable Vite workflow.

## Security and lifecycle

- Treat witness and proof-generation state as sensitive application data.
- Do not run two operations concurrently through the same installed subpath.
- Retain one mutually compatible selector, permutation, circuit library, CRS,
  preprocess output, instance, and proof set.
- Validate and authenticate source artifacts at the application's trust
  boundary; a binary self-digest is not producer authentication.
- Development trusted-setup output is not release or deployment material.

## Project and license

The package is dual-licensed under `MIT OR Apache-2.0`. Dependencies retain
their own licenses. Repository-level release notes are maintained in
[`CHANGELOG.md`](../../../CHANGELOG.md).
