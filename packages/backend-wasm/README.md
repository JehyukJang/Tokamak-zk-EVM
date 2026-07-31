# @tokamak-zk-evm/snark-browser-compat

Browser preprocessing, proof generation, verification, and artifact conversion
for Tokamak zk-SNARK. Use it in a bundler-based browser application; use
[`@tokamak-zk-evm/cli`](../cli/README.md) for the complete local native
workflow.

This package does not synthesize transactions, download artifacts, run setup,
or provide a generic proving-system API. Browser proving is long-running and
memory-intensive.

## Install and entry points

```sh
npm install @tokamak-zk-evm/snark-browser-compat
```

The package is ESM-only and exposes exactly four public subpaths:

```ts
import('@tokamak-zk-evm/snark-browser-compat/preprocess');
import('@tokamak-zk-evm/snark-browser-compat/prover');
import('@tokamak-zk-evm/snark-browser-compat/verifier');
import('@tokamak-zk-evm/snark-browser-compat/converter');
```

Do not import the package root, `dist/` files, runtime primitives, generated
constants, or protocol internals. Vite and Webpack production consumers are
verified; bundler-free direct serving is unsupported. A complete runnable
integration is available in [`examples/browser`](./examples/browser).

## npm publication

| Item              | Value                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Package           | [`@tokamak-zk-evm/snark-browser-compat`](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat) |
| Repository source | `2.1.4`; use `npm view @tokamak-zk-evm/snark-browser-compat version` for the published version               |
| Runtime           | ESM with `./preprocess`, `./prover`, `./verifier`, and `./converter`                                         |
| Release notes     | [Repository `CHANGELOG.md`](../../CHANGELOG.md)                                                              |

## Public API reference

Use `./preprocess` to produce verifier preprocessing commitments, `./prover`
to create proofs, `./verifier` to check proofs, and `./converter` to prepare or
examine binary artifacts.

| Task                             | Import                           | Installation required  | Result                     |
| -------------------------------- | -------------------------------- | ---------------------- | -------------------------- |
| Calculate verifier preprocessing | `./preprocess` `preprocess()`    | Preprocess `install()` | Verifier-preprocess binary |
| Generate one complete proof      | `./prover` `prove()`             | Prover `install()`     | Proof binary               |
| Generate with phase boundaries   | `./prover` `begin()`             | Prover `install()`     | Proof binary               |
| Verify a proof                   | `./verifier` `verify()`          | Verifier `install()`   | `boolean`                  |
| Convert one source material      | `./converter` material converter | No                     | Binary or proof JSON       |
| Read binary tables               | `./converter` `inspectBinary()`  | No                     | Inspection object          |
| Validate a binary                | `./converter` `validateBinary()` | No                     | Validated artifact view    |

Inspection decodes metadata, validation checks binary structure and
self-digest, and verification checks the cryptographic proof.

### Prover API

| Export                            | Purpose                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `prover.install(options?)`        | Create or reuse the prover runtime and return version and chunk-size information  |
| `prover.prove(input)`             | Generate one complete verifier-proof binary                                       |
| `prover.begin(input)`             | Start one staged, stateful proving session                                        |
| `ProverSession.proveArithmetic()` | Execute the arithmetic-constraints phase                                          |
| `ProverSession.proveCopy()`       | Execute the copy-constraints phase                                                |
| `ProverSession.proveBinding()`    | Execute the binding phase                                                         |
| `ProverSession.finalize()`        | Execute integrated finalization, return the proof binary, and release the session |
| `ProverSession.dispose()`         | Release an unfinished session; repeated calls are harmless                        |

Public prover types are `ProverInput`, `ProverInstallOptions`,
`ProverInstallationInfo`, and `ProverSession`.

### Verifier API

| Export                   | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `verifier.install()`     | Create or reuse the verifier runtime and return version information |
| `verifier.verify(input)` | Return the cryptographic validity of one proof                      |

Public verifier types are `VerifierInput` and `VerifierInstallationInfo`.

### Preprocess API

| Export                         | Purpose                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `preprocess.install(options?)` | Create or reuse the preprocess runtime and return version and chunk-size information |
| `preprocess.preprocess(input)` | Calculate `s0`, `s1`, and `O_pub_fix` and return one verifier-preprocess binary      |

Public preprocess types are `PreprocessInput`, `PreprocessInstallOptions`, and
`PreprocessInstallationInfo`.

### Converter API

| Export                             | Input and result                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `convertWitness(value)`            | Parsed placement-variable JSON to witness binary                                                                |
| `convertPermutation(value)`        | Parsed permutation JSON to permutation binary                                                                   |
| `convertInstance(value)`           | Parsed instance JSON to public and function instance sections                                                   |
| `convertVerifierPreprocess(value)` | Parsed preprocess JSON to verifier-preprocess binary                                                            |
| `convertProof(input)`              | Convert native proof JSON to binary, or proof binary to a native proof JSON object, according to `sourceFormat` |
| `convertCrs(bytes)`                | `combined_sigma.rkyv` bytes to named prover, preprocess, and verifier CRS binaries                              |
| `inspectBinary(bytes)`             | Binary header and section information without a validity claim                                                  |
| `validateBinary(bytes)`            | Validated decoded artifact after layout, digest, and spec checks                                                |

Public converter types are `BinaryArtifactInspection`,
`BinarySectionInspection`, `ConvertedCrs`, `ConverterArtifactJson`,
`ConvertProofBinaryInput`, `ConvertProofInput`, `ConvertProofJsonInput`, and
`RuntimeArtifactFileValidationResult`.

Every subpath exports `BackendWasmError` and `BackendWasmErrorCode`.

## Load binary artifacts

All runtime inputs are non-empty `Uint8Array` values. Complete network or
storage I/O before calling preprocess, the prover, or the verifier:

```ts
export async function loadBinary(url: string | URL): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
```

The package does not fetch, cache, refresh, or authenticate application
artifacts.

## Run preprocess

Install the independent preprocess runtime once and pass its three named binary
inputs:

```ts
import { install as installPreprocess, preprocess } from '@tokamak-zk-evm/snark-browser-compat/preprocess';

import { loadBinary } from './load-binary.js';

const installation = await installPreprocess();

const [permutation, instance, preprocessCrs] = await Promise.all([
  loadBinary('/artifacts/permutation.bin'),
  loadBinary('/artifacts/instance.bin'),
  loadBinary('/artifacts/preprocess-crs.bin'),
]);

const verifierPreprocess = await preprocess({
  permutation,
  instance,
  preprocessCrs,
});

console.log(installation.chunkSize, verifierPreprocess.byteLength);
```

The current default chunk exponent is `17`. An application may explicitly select an
integer from `10` through `19`. A later explicit option takes precedence while
preprocess is idle; omitting the option preserves the installed value.

Preprocess and prover are independent. Preprocess consumes
`instance.function`, produces the `s0`, `s1`, and `O_pub_fix` commitments, and
does not call or prepare the prover.

## Verify a proof

Install the verifier once, retain it for the page lifetime, and pass the three
named binaries:

```ts
import { install as installVerifier, verify } from '@tokamak-zk-evm/snark-browser-compat/verifier';

import { loadBinary } from './load-binary.js';

await installVerifier();

const [proof, instance, verifierPreprocess] = await Promise.all([
  loadBinary('/artifacts/proof.bin'),
  loadBinary('/artifacts/instance.bin'),
  loadBinary('/artifacts/verifier-preprocess.bin'),
]);

const valid = await verify({
  proof,
  instance,
  verifierPreprocess,
});
```

`verify()` returns `false` when a well-formed proof fails the cryptographic
verification equations. Installation, concurrency, binary decoding, and
runtime failures reject the Promise with `BackendWasmError`.

The verifier CRS is regenerated from the native owner artifact during every
package build and compiled into the verifier. Applications do not provide a
verifier CRS at runtime.

## Generate a proof

Install the prover once. Multithreaded ffjavascript primitives are always
enabled; the optional exponent controls only the outer dense Sigma1 MSM chunk
size:

```ts
import { install as installProver, prove } from '@tokamak-zk-evm/snark-browser-compat/prover';

import { loadBinary } from './load-binary.js';

const installation = await installProver({
  chunkSizeExponent: 18,
});

const [witness, permutation, instance, proverCrs] = await Promise.all([
  loadBinary('/artifacts/witness.bin'),
  loadBinary('/artifacts/permutation.bin'),
  loadBinary('/artifacts/instance.bin'),
  loadBinary('/artifacts/prover-crs.bin'),
]);

const proof = await prove({
  witness,
  permutation,
  instance,
  proverCrs,
});

console.log(installation.chunkSize, proof.byteLength);
```

The exponent must be an integer from `10` through `19`. Omitting it uses `18`
on the first installation. A later `install()` call may change it while the
prover is idle; a later explicit option takes precedence. The chunk size is
`2 ** chunkSizeExponent`.

The input artifacts are independent files:

| Property      | Content                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `witness`     | Placement subcircuit IDs, placement offsets, and field-valued placement variables |
| `permutation` | Row, column, X, and Y permutation entries                                         |
| `instance`    | Public instance field values shared with the verifier                             |
| `proverCrs`   | Prover CRS points and prepared Sigma1/Sigma2 commitment data                      |

`prove()` returns one verifier-proof binary. It is a convenience wrapper over
the same stateful implementation exposed by `begin()`.

## Track proving progress

Use a staged prover session when the application needs coarse phase updates.
The calls are ordered and share one in-memory transcript:

```ts
import { begin, install as installProver, type ProverInput } from '@tokamak-zk-evm/snark-browser-compat/prover';

type ProverPhase = 'preparing' | 'arithmetic' | 'copy' | 'binding' | 'finalizing' | 'completed';

export async function proveWithProgress(
  input: ProverInput,
  setPhase: (phase: ProverPhase) => void,
): Promise<Uint8Array> {
  await installProver();
  setPhase('preparing');
  const session = await begin(input);

  try {
    setPhase('arithmetic');
    await session.proveArithmetic();

    setPhase('copy');
    await session.proveCopy();

    setPhase('binding');
    await session.proveBinding();

    setPhase('finalizing');
    const proof = await session.finalize();
    setPhase('completed');
    return proof;
  } finally {
    session.dispose();
  }
}
```

These boundaries expose the arithmetic constraints, copy constraints, binding,
and integrated-finalization work. They do not serialize or validate
intermediate protocol state. The package does not estimate percentages or
remaining time. Finalize or dispose every session; an unfinished session
retains large prover state.

## Runtime artifact guide and acquisition

The application owns artifact acquisition, provenance verification, conversion,
storage, caching, and invalidation.

Runtime inputs use the Tokamak binary artifact format with magic `TZBWASM1`
and binary `formatVersion` 1. The filename is an application convention; the
binary header identifies the actual artifact kind.

| Runtime property     | Role and binary kind                                                             | Source format                                                                                                                              | How to obtain it                                                                                                                                                 | Example in this README                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `witness`            | Placement witness; `prover_placement_variables`                                  | Parsed `placementVariables.json` from `@tokamak-zk-evm/synthesizer-node`, `@tokamak-zk-evm/synthesizer-web`, or `tokamak-cli --synthesize` | Call `convertWitness(parsedJson)` and store the returned `Uint8Array`, conventionally as `witness.bin`                                                           | [`convertWitness()` example](#convert-inspect-and-validate-binaries)                                                   |
| `permutation`        | Wire-equality cycles; `prover_permutation`                                       | Parsed `permutation.json` from the same synthesis result                                                                                   | Call `convertPermutation(parsedJson)`, conventionally producing `permutation.bin`                                                                                | [`preprocess()` input](#run-preprocess) and [`prove()` input](#generate-a-proof)                                       |
| `instance`           | Public and function-instance field values; `instance`                            | Parsed `instance.json` from the same synthesis result                                                                                      | Call `convertInstance(parsedJson)`, conventionally producing `instance.bin`                                                                                      | [`preprocess()` input](#run-preprocess), [`prove()` input](#generate-a-proof), and [`verify()` input](#verify-a-proof) |
| `proverCrs`          | Prover commitment key; `prover_crs`                                              | Release `combined_sigma.rkyv` bytes                                                                                                        | Authenticate and load the compatible release file, call `convertCrs(bytes)`, and retain `proverCrs`, conventionally as `prover-crs.bin`                          | [`convertCrs()` example](#convert-inspect-and-validate-binaries)                                                       |
| `preprocessCrs`      | CRS subset required to generate verifier preprocessing; `preprocess_crs`         | The same release `combined_sigma.rkyv` bytes                                                                                               | Retain `preprocessCrs` from `convertCrs(bytes)`, conventionally as `preprocess-crs.bin`                                                                          | [`preprocess()` input](#run-preprocess)                                                                                |
| `verifierPreprocess` | Commitments tied to the permutation and function instance; `verifier_preprocess` | Either native `preprocess.json` or browser `preprocess()` output                                                                           | Call `convertVerifierPreprocess(parsedJson)` for native JSON, or store the `Uint8Array` returned by `preprocess()`, conventionally as `verifier-preprocess.bin`  | [`preprocess()` output](#run-preprocess) and [`verify()` input](#verify-a-proof)                                       |
| `proof`              | Complete verifier proof; `verifier_proof`                                        | Either native `proof.json` or browser `prove()` output                                                                                     | Call `convertProof({ sourceFormat: "json", proof: parsedJson })` for native JSON, or store the `Uint8Array` returned by `prove()`, conventionally as `proof.bin` | [`prove()` output](#generate-a-proof) and [`verify()` input](#verify-a-proof)                                          |

The package pins `@tokamak-zk-evm/subcircuit-library` and generates setup
parameters, packed R1CS data, and subcircuit metadata into the build. These are
not runtime inputs.

Obtain the large combined CRS source from the immutable
[Tokamak zk-EVM CRS release folder](https://drive.google.com/drive/folders/14xqCbLoyoVmUVTTlopiXtKnoHPBGL-Sv).
The package never downloads Google Drive artifacts. Keep provenance information
from the release source and invalidate cached converted binaries when the
application changes its compatible Tokamak release.

Keep `witness`, `permutation`, and `instance` from the same synthesis result.
Keep `verifierPreprocess` paired with the permutation and function instance
that produced it. Do not combine artifacts from incompatible Tokamak zk-EVM
release lines.

## Convert, inspect, and validate binaries

Converters handle one material per call and require no installation:

```ts
import {
  convertInstance,
  convertPermutation,
  convertProof,
  convertCrs,
  convertVerifierPreprocess,
  convertWitness,
  inspectBinary,
  validateBinary,
} from '@tokamak-zk-evm/snark-browser-compat/converter';

const witnessSource = await fetch('/sources/placementVariables.json').then(response => response.json());
const witness = await convertWitness(witnessSource);

const rkyvResponse = await fetch('/sources/combined_sigma.rkyv');
const rkyvBytes = new Uint8Array(await rkyvResponse.arrayBuffer());
const { proverCrs, preprocessCrs, verifierCrs } = await convertCrs(rkyvBytes);

const inspection = await inspectBinary(proverCrs);
const validated = await validateBinary(proverCrs);
```

The application parses JSON before calling a converter. `convertCrs()`
transfers its input `ArrayBuffer` to a temporary module Worker, detaching the
caller's buffer. Pass `rkyvBytes.slice()` when the original bytes must remain
available.

`proverCrs` and `preprocessCrs` are application-owned runtime inputs for their
respective APIs. `verifierCrs` is an independently inspectable and validatable
converter output, but the current verifier continues using its build-generated
hardcoded CRS and does not accept it as an input.

`inspectBinary()` reads the file kind, versions, self-digest, and section table.
It does not establish validity. `validateBinary()` checks the fixed layout,
whole-file SHA-256 self-digest, and the versioned artifact specification. The
self-digest detects accidental or malicious byte changes; it does not
authenticate the producer or replace trusted provenance.

Preprocess, the prover, and the verifier deliberately do not call
`validateBinary()`. They decode and process their named binary inputs directly
to keep the runtime algorithms focused. Call validation separately when the
application's trust boundary requires it.

## Browser deployment and lifecycle

Vite and Webpack production builds running in Chromium are the currently
verified browser-and-bundler combinations.

| Capability                                     | Status                            |
| ---------------------------------------------- | --------------------------------- |
| Chromium with a Vite production build          | Verified                          |
| Chromium with a Webpack production build       | Verified                          |
| Firefox or Safari                              | Not yet verified                  |
| Bundler-free static ESM                        | Unsupported                       |
| Cross-origin isolation and `SharedArrayBuffer` | Not required by the verified path |

Deployment requirements:

- serve emitted JavaScript and Worker assets with JavaScript-compatible MIME
  types;
- serve the decoder with `Content-Type: application/wasm`;
- allow WebAssembly evaluation, including `script-src 'wasm-unsafe-eval'` under
  a restrictive Chromium CSP;
- allow same-origin and Blob workers, including `worker-src 'self' blob:`;
- let the bundler resolve the converter Worker's bare `ffjavascript` import.

Preprocess, prover, and verifier installations are independent and each creates
one reusable curve runtime. Concurrent first installs for one runtime family
share the same attempt. A failed install is not retried automatically, but a
later explicit `install()` may retry.

Only one operation may use each runtime family at a time. A second operation
rejects with `BUSY`; requests are not queued. Preprocess, prover, and verifier
may run concurrently, but the application owns the resulting CPU and memory
contention. There is no public terminate API. Keep each installed runtime until
the page or host process ends.

Avoid concurrent large converter calls unless the application has budgeted for
duplicate WASM memories and temporary buffers.

## Compatibility and versioning

Snark-browser-compat 2.1.4 is aligned with the Tokamak zk-EVM native backend and
subcircuit-library 2.1.4 release line.

| Boundary                             | Current value          |
| ------------------------------------ | ---------------------- |
| Snark-browser-compat package         | 2.1.4                  |
| Native backend release line          | 2.1.4                  |
| `@tokamak-zk-evm/subcircuit-library` | 2.1.4                  |
| Binary `formatVersion`               | 1                      |
| Package module format                | ESM                    |
| Curve runtime                        | ffjavascript BLS12-381 |

`install()` reports the package, native backend, and subcircuit-library
versions. Every binary carries its independent `formatVersion` and
`sourcePackageVersion`. The format version identifies the binary layout; the
source package version identifies the producer release.

The runtime does not perform a separate compatibility handshake or optional
whole-file validation. Incompatible binary structure normally rejects with
`INVALID_INPUT`; a structurally decodable but cryptographically incompatible
proof may return `false`. Applications that manage multiple release lines
should inspect or validate artifacts before selecting a runtime.

## Measured browser performance

Accepted reference measurements generated preprocess and a 2,328-byte proof
and verified the proof in Chromium 149.0.7827.55:

| Measurement                              | Observed value |
| ---------------------------------------- | -------------: |
| Preprocess, three-run mean               |       10.942 s |
| Preprocess population standard deviation |           8 ms |
| Proof generation                         |       118.82 s |
| Proof verification                       |          19 ms |
| Peak total Chromium-process RSS          |      10.03 GiB |
| Peak largest-process RSS                 |       9.83 GiB |

Environment: MacBook Pro with Apple M4 Pro, 14 CPU cores, 48 GB memory, macOS
26.5.2, multithreaded ffjavascript, preprocess chunk exponent `17`, prover
chunk exponent `18`, and the 4,096 by 256 domain with 234 placements and
658,454 placement variables. Proof measurements were recorded on 2026-07-27
by package commit `4cb2ad9b`; preprocess measurements were recorded after
reboot on 2026-07-29 from benchmark source identity
`802c5ef0e35b1d6226392179c8d97176deb06e5ca943b13840225ca32dd22ea8`.

These are observations from one machine and fixture, not minimum requirements,
portable guarantees, or predictions for another browser, input, thermal state,
or system load.

## Errors and troubleshooting

All public subpaths export `BackendWasmError`. Branch on `error.code`, not the
message:

| Code               | Meaning                                                     | Application action                                               |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `INSTALL_REQUIRED` | Preprocess, prove, or verify was called before installation | Complete the matching `install()` call                           |
| `INSTALL_FAILED`   | Runtime construction failed                                 | Report the cause and retry only through a later explicit install |
| `BUSY`             | The same runtime family is active                           | Disable duplicate actions and wait for the active operation      |
| `INVALID_OPTION`   | An install option is unknown or out of range                | Correct the option before retrying                               |
| `INVALID_INPUT`    | A binary or converter source could not be decoded           | Check artifact kind, source, version, and conversion             |
| `RUNTIME_FAILED`   | Installed runtime work failed                               | Report the cause and treat the operation as failed               |

Additional troubleshooting:

- `verify()` returning `false` is a cryptographic invalid-proof result, not an
  exception or installation failure.
- A validation self-digest mismatch means the binary bytes changed. Replace the
  complete artifact from its trusted source.
- Worker-load failures usually indicate an unsupported bundler output, CSP
  restriction, incorrect asset URL, or MIME type.
- A version mismatch requires selecting and converting artifacts from the
  compatible release line; the package does not silently fall back.
- Browser memory exhaustion may terminate the operation or renderer before an
  error can be delivered. Avoid concurrent proving and large conversions.
  A lower chunk exponent reduces the maximum outer dense-MSM submission but is
  not a universal memory guarantee.

## Security and application responsibilities

This package does not download, authenticate, authorize, or retain application
artifacts. The application must establish trusted sources for synthesis JSON,
CRS material, verifier preprocessing, and proofs; validate provenance at its
trust boundary; and keep compatible artifacts together.

Do not embed RPC API keys, wallet credentials, private signing keys, or
restricted artifact URLs in browser bundles or generated binaries. Witnesses
and transaction-derived artifacts may contain sensitive application data, so
decide whether they may be fetched, cached, logged, or persisted before
conversion or proving.

A `true` verification result establishes validity under the supplied instance,
preprocessing data, compiled verifier CRS, and implemented protocol equations.
It does not by itself establish the security of the application, circuit
library, trusted setup, artifact distribution channel, or surrounding
protocol. Browser proving is resource-intensive; applications are responsible
for concurrency controls, memory budgeting, cancellation UX, and recovery from
renderer termination.

## Project and license

- [Tokamak zk-EVM repository](https://github.com/tokamak-network/Tokamak-zk-EVM)
- [Snark-browser-compat package source](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/backend-wasm)
- [Issue tracker](https://github.com/tokamak-network/Tokamak-zk-EVM/issues)
- [Repository changelog](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)
- [Tokamak zk-SNARK protocol paper](https://eprint.iacr.org/2024/507)
- [`@tokamak-zk-evm/subcircuit-library` on npm](https://www.npmjs.com/package/@tokamak-zk-evm/subcircuit-library)
- [`@tokamak-zk-evm/snark-browser-compat` on npm](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat)

This package's own code follows the repository's `MIT OR Apache-2.0` policy.
See [LICENSE-MIT](./LICENSE-MIT), [LICENSE-APACHE](./LICENSE-APACHE), and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

This package license does not override dependency licenses. `ffjavascript` is
GPL-licensed. An application distribution that imports, links, or bundles
backend-wasm with `ffjavascript` must comply with the applicable GPL obligations
for the resulting combination. Externalizing dependencies from the converter
Worker changes where code is bundled; it does not remove those obligations.
This information is not legal advice.

Repository development and publication instructions are in
[CONTRIBUTING.md](./CONTRIBUTING.md).
