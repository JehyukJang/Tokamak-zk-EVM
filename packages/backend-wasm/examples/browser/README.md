# Browser Workflow Example

Runnable Vite integration for
`@tokamak-zk-evm/snark-browser-compat`. It exposes independent installation and
execution controls for preprocess, prove, and verify.

## Run

```sh
npm install
npm run dev
```

Open the Vite URL and run preprocess, prove, and verify in order. Outputs remain
in memory for the page lifetime and can also be downloaded.

## Source map

The page entry point is [`src/main.ts`](./src/main.ts). It coordinates these
operation-specific modules:

- [`src/run-preprocess.ts`](./src/run-preprocess.ts): install preprocess, load
  its three binary inputs, and generate verifier preprocess bytes.
- [`src/generate-proof.ts`](./src/generate-proof.ts): install the prover, load
  its four binary inputs, and generate proof bytes.
- [`src/verify-proof.ts`](./src/verify-proof.ts): install the verifier, load the
  instance, and verify the generated proof and preprocess bytes.
- [`src/load-binary.ts`](./src/load-binary.ts): fetch one binary artifact and
  reject unsuccessful responses.

[`index.html`](./index.html), [`src/styles.css`](./src/styles.css), and
[`src/global.d.ts`](./src/global.d.ts) support the runnable page rather than
defining separate API recipes.

## Input artifacts

Create `public/artifacts/` and provide the binary files needed by the operations
you intend to run:

| File                 | Role and source                                                   | Used by                          |
| -------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `permutation.bin`    | `convertPermutation(permutation.json)` from one synthesis         | Preprocess and prover            |
| `instance.bin`       | `convertInstance(instance.json)` from the same synthesis          | Preprocess, prover, and verifier |
| `preprocess-crs.bin` | `convertCrs(combined_sigma.rkyv).preprocessCrs`                   | Preprocess                       |
| `witness.bin`        | `convertWitness(placementVariables.json)` from the same synthesis | Prover                           |
| `prover-crs.bin`     | `convertCrs(combined_sigma.rkyv).proverCrs`                       | Prover                           |

The default URLs in the page point to these names. They can be replaced with
same-origin or CORS-enabled application URLs. The verifier CRS is compiled into
the package and is not an application input.

The CRS and witness files are intentionally not included in this example or in
the npm package. Obtain a compatible `combined_sigma.rkyv` from the published
CRS release, authenticate its provenance, and keep transaction artifacts from
one synthesis.

## Additional Recipes

These focused modules are source recipes. They are typechecked and published
with the example, but are not imported by the runnable page:

- [`src/prepare-artifacts.ts`](./src/prepare-artifacts.ts): convert native JSON
  materials and `combined_sigma.rkyv` into the separate runtime binaries.
- [`src/inspect-and-validate.ts`](./src/inspect-and-validate.ts): inspect binary
  metadata and independently validate the same artifact.
- [`src/staged-proof.ts`](./src/staged-proof.ts): execute the ordered prover
  session API and report arithmetic, copy, binding, and finalization progress.

## Publication and license

This example package is private and is not published to npm. The public
package is
[`@tokamak-zk-evm/snark-browser-compat`](https://www.npmjs.com/package/@tokamak-zk-evm/snark-browser-compat);
release notes are in [CHANGELOG.md](../../../../CHANGELOG.md).

Example source follows the repository's `MIT OR Apache-2.0` license.
