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
| Published version | `npm view @tokamak-zk-evm/snark-browser-compat version`                                                      |
| Release notes     | [Repository `CHANGELOG.md`](../../CHANGELOG.md)                                                              |

## Quick start

Before running this example, prepare these five files:

- `witness.bin`, `permutation.bin`, and `instance.bin` converted from one
  Synthesizer result;
- `prover-crs.bin` and `preprocess-crs.bin` converted from one compatible
  `combined_sigma.rkyv`.

The [runtime artifact guide](#runtime-artifact-guide-and-acquisition) explains
each source and conversion. The example below includes its loader, installs
each runtime once, and keeps all transaction artifacts from one synthesis:

```ts
import { install as installPreprocess, preprocess } from '@tokamak-zk-evm/snark-browser-compat/preprocess';
import { install as installProver, prove } from '@tokamak-zk-evm/snark-browser-compat/prover';
import { install as installVerifier, verify } from '@tokamak-zk-evm/snark-browser-compat/verifier';

async function loadBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

await Promise.all([installPreprocess(), installProver(), installVerifier()]);

const [witness, permutation, instance, proverCrs, preprocessCrs] = await Promise.all([
  loadBinary('/artifacts/witness.bin'),
  loadBinary('/artifacts/permutation.bin'),
  loadBinary('/artifacts/instance.bin'),
  loadBinary('/artifacts/prover-crs.bin'),
  loadBinary('/artifacts/preprocess-crs.bin'),
]);

const verifierPreprocess = await preprocess({ permutation, instance, preprocessCrs });
const proof = await prove({ witness, permutation, instance, proverCrs });
const valid = await verify({ proof, instance, verifierPreprocess });
console.log({ valid });
```

The files may use different URLs, but they must be same-origin or served with
the required CORS headers. See the
[runnable Vite example](./examples/browser/README.md) for a complete
application.

Preprocess and prover accept `chunkSizeExponent` from `10` through `19`.
Defaults are `17` for preprocess and `18` for proving. A later explicit
`install()` may change the value while that runtime is idle. `verify()` returns
`false` for a well-formed but cryptographically invalid proof; runtime and input
failures reject with `BackendWasmError`.

The verifier CRS is compiled into the package. Applications do not provide it
to `verify()`.

## Track proving progress

Use a staged prover session when the application needs coarse phase updates.
The calls are ordered and share one in-memory transcript:

```ts
import { begin, type ProverInput } from '@tokamak-zk-evm/snark-browser-compat/prover';

export async function proveWithProgress(input: ProverInput): Promise<Uint8Array> {
  const session = await begin(input);
  try {
    console.log('Arithmetic');
    await session.proveArithmetic();
    console.log('Copy');
    await session.proveCopy();
    console.log('Binding');
    await session.proveBinding();
    console.log('Finalizing');
    return await session.finalize();
  } finally {
    session.dispose();
  }
}
```

These boundaries provide coarse progress, not percentages or resumable state.
Finalize or dispose every session; an unfinished session retains large prover
state. Pass the same `ProverInput` used by `prove()` after installing the prover.
The runnable example includes a
[callback-based progress recipe](./examples/browser/src/staged-proof.ts).

## Runtime artifact guide and acquisition

The application owns artifact acquisition, provenance verification, conversion,
storage, caching, and invalidation.

Runtime inputs use the Tokamak binary artifact format with magic `TZBWASM1`
and binary `formatVersion` 1. The filename is an application convention; the
binary header identifies the actual artifact kind.

| Property             | Role and binary kind                                                         | Source                                                          | Acquisition                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `witness`            | Placement witness; `prover_placement_variables`                              | `placementVariables.json` from a Synthesizer package or the CLI | Call `convertWitness()`, conventionally producing `witness.bin`                                              |
| `permutation`        | Wire-equality cycles; `prover_permutation`                                   | `permutation.json` from the same synthesis                      | Call `convertPermutation()`, conventionally producing `permutation.bin`                                      |
| `instance`           | Public and function-instance values; `instance`                              | `instance.json` from the same synthesis                         | Call `convertInstance()`, conventionally producing `instance.bin`                                            |
| `proverCrs`          | Prover commitment key; `prover_crs`                                          | Compatible `combined_sigma.rkyv` release file                   | Authenticate the source, call `convertCrs()`, and retain `proverCrs` as `prover-crs.bin`                     |
| `preprocessCrs`      | Preprocessing CRS; `preprocess_crs`                                          | The same `combined_sigma.rkyv`                                  | Retain `preprocessCrs` from `convertCrs()` as `preprocess-crs.bin`                                           |
| `verifierPreprocess` | Commitments for the permutation and function instance; `verifier_preprocess` | Native `preprocess.json` or browser `preprocess()` output       | Call `convertVerifierPreprocess()` for native JSON, or store the browser output as `verifier-preprocess.bin` |
| `proof`              | Complete verifier proof; `verifier_proof`                                    | Native `proof.json` or browser `prove()` output                 | Call `convertProof()` for native JSON, or store the browser output as `proof.bin`                            |

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
  convertCrs,
  convertWitness,
  inspectBinary,
  validateBinary,
} from '@tokamak-zk-evm/snark-browser-compat/converter';

const witnessSource = await fetch('/sources/placementVariables.json').then(response => response.json());
const witness = await convertWitness(witnessSource);

const rkyvResponse = await fetch('/sources/combined_sigma.rkyv');
const rkyvBytes = new Uint8Array(await rkyvResponse.arrayBuffer());
const { proverCrs } = await convertCrs(rkyvBytes);

await inspectBinary(proverCrs);
await validateBinary(proverCrs);
```

The application parses JSON before calling a converter. `convertCrs()`
transfers its input `ArrayBuffer` to a temporary module Worker, detaching the
caller's buffer. Pass `rkyvBytes.slice()` when the original bytes must remain
available.

`proverCrs` and `preprocessCrs` are runtime inputs. The returned `verifierCrs`
is inspectable, but the current verifier uses its build-generated CRS and does
not accept this value as an input.

`inspectBinary()` reads the file kind, versions, self-digest, and section table.
It does not establish validity. `validateBinary()` checks the fixed layout,
whole-file SHA-256 self-digest, and the versioned artifact specification. The
self-digest detects accidental or malicious byte changes; it does not
authenticate the producer or replace trusted provenance.

Preprocess, the prover, and the verifier deliberately do not call
`validateBinary()`. They decode and process their named binary inputs directly
to keep the runtime algorithms focused. Call validation separately when the
application's trust boundary requires it.

## Public API reference

Use the workflow sections above for integration. This table is the complete
public surface when looking up a specific operation:

| Subpath        | Export                             | Purpose                                                               |
| -------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `./prover`     | `prover.install(options?)`         | Create or reuse the prover runtime                                    |
| `./prover`     | `prover.prove(input)`              | Generate one complete verifier-proof binary                           |
| `./prover`     | `prover.begin(input)`              | Start a staged proving session                                        |
| `./prover`     | `ProverSession.proveArithmetic()`  | Execute the arithmetic phase                                          |
| `./prover`     | `ProverSession.proveCopy()`        | Execute the copy phase                                                |
| `./prover`     | `ProverSession.proveBinding()`     | Execute the binding phase                                             |
| `./prover`     | `ProverSession.finalize()`         | Finalize, return the proof, and release the session                   |
| `./prover`     | `ProverSession.dispose()`          | Release an unfinished session                                         |
| `./preprocess` | `preprocess.install(options?)`     | Create or reuse the preprocess runtime                                |
| `./preprocess` | `preprocess.preprocess(input)`     | Produce verifier-preprocess commitments                               |
| `./verifier`   | `verifier.install()`               | Create or reuse the verifier runtime                                  |
| `./verifier`   | `verifier.verify(input)`           | Return the cryptographic validity of one proof                        |
| `./converter`  | `convertWitness(value)`            | Convert placement-variable JSON                                       |
| `./converter`  | `convertPermutation(value)`        | Convert permutation JSON                                              |
| `./converter`  | `convertInstance(value)`           | Convert public and function-instance JSON                             |
| `./converter`  | `convertVerifierPreprocess(value)` | Convert native preprocess JSON                                        |
| `./converter`  | `convertProof(input)`              | Convert between native proof JSON and proof binary                    |
| `./converter`  | `convertCrs(bytes)`                | Split the combined CRS into prover, preprocess, and verifier binaries |
| `./converter`  | `inspectBinary(bytes)`             | Read binary header and section information                            |
| `./converter`  | `validateBinary(bytes)`            | Validate layout, digest, and the versioned artifact specification     |

Public types are `ProverInput`, `ProverInstallOptions`,
`ProverInstallationInfo`, `ProverSession`, `VerifierInput`,
`VerifierInstallationInfo`, `PreprocessInput`, `PreprocessInstallOptions`,
`PreprocessInstallationInfo`, `BinaryArtifactInspection`,
`BinarySectionInspection`, `ConvertedCrs`, `ConverterArtifactJson`,
`ConvertProofBinaryInput`, `ConvertProofInput`, `ConvertProofJsonInput`,
`RuntimeArtifactFileValidationResult`, `BackendWasmError`, and
`BackendWasmErrorCode`.

## Browser support and lifecycle

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

`install()` reports the package, native backend, and subcircuit-library
versions, which are synchronized for a release. Every binary carries
`formatVersion` 1 and its `sourcePackageVersion`; these identify the layout and
producer release respectively.

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

- [Source](https://github.com/tokamak-network/Tokamak-zk-EVM/tree/main/packages/backend-wasm)
- [Issue tracker](https://github.com/tokamak-network/Tokamak-zk-EVM/issues)
- [Repository changelog](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/CHANGELOG.md)
- [Tokamak zk-SNARK protocol paper](https://eprint.iacr.org/2024/507)

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
