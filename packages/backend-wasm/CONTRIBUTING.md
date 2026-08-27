# Contributing to Backend WASM

## Audience

This document is for maintainers developing, testing, and preparing
`@tokamak-zk-evm/snark-browser-compat` for publication. Application integration belongs
in `README.md`.

## Package boundaries

The package exposes only:

- `@tokamak-zk-evm/snark-browser-compat/prover`
- `@tokamak-zk-evm/snark-browser-compat/preprocess`
- `@tokamak-zk-evm/snark-browser-compat/verifier`
- `@tokamak-zk-evm/snark-browser-compat/converter`

Internal runtime, protocol, generated, and binary implementation modules are
not public APIs. See
[`docs/architecture/package-boundaries.md`](./docs/architecture/package-boundaries.md)
before changing dependency direction or publication contents.

## Repository structure

```text
packages/backend-wasm/
  docs/
    architecture/
    optimization/
    release/
  fixtures/
  scripts/
    fixtures/
    generate/
    package/
  src/
    artifacts/
    converter/
    preprocess/
    prover/
    runtime/
    verifier/
  test/
  tools/
    rkyv-decoder-wasm/
  tmp/
```

- `src/artifacts`: binary containers, decoded views, and versioned specs.
- `src/converter`: public converter API, material conversion, optional
  inspection and validation, and the prover CRS Worker.
- `src/generated`: shared generated setup and dependency-version constants.
- `src/preprocess`: independent preprocess lifecycle, permutation-polynomial
  construction, and verifier-preprocess commitment output.
- `src/prover`: public prover lifecycle and integrated protocol operations.
- `src/runtime`: shared ffjavascript-backed field, curve, group, pairing,
  transcript, random, and polynomial infrastructure.
- `src/verifier`: public verifier lifecycle and verification protocol math.
- `scripts`: generated-source, fixture-copy, and package-maintenance commands.
- `test`: checks, browser entry points, diagnostics, and test-only references.
- `tools/rkyv-decoder-wasm`: Rust/WASM decoder source built into the converter.
- `tmp`: ignored planning, benchmark, audit, and other temporary output.

## Prerequisites

- Node.js 20 or newer
- npm
- Rust and Cargo
- the `wasm32-unknown-unknown` Rust target
- `wasm-bindgen-cli` matching the decoder crate's wasm-bindgen version

Install JavaScript dependencies from this package directory:

```sh
npm install
```

Check the Rust/WASM build prerequisites:

```sh
npm run rkyv-decoder:check-tools
```

## Generated build inputs

Do not edit generated inputs manually. The generators write ignored active
outputs under `src/generated/active`, `src/prover/generated/active`, and
`src/verifier/generated/active`; compilation consumes only those outputs.
Both build modes compile the same optimized package output. Their only input
selection difference is the subcircuit-library and verifier-CRS source.

Development selects local qap-compiler output and an explicit trusted-setup
debug Sigma:

```sh
export BACKEND_WASM_VERIFIER_CRS_DIR=../backend/setup/trusted-setup/output/debug
npm run build:development
npm run typecheck:development
```

Production selects the pinned npm `@tokamak-zk-evm/subcircuit-library`
snapshot and requires an explicit complete final CRS directory:

```sh
export BACKEND_WASM_VERIFIER_CRS_DIR=/absolute/path/to/final-crs-directory
npm run build:production
npm run typecheck:production
```

The production verifier generator requires `sigma_verify.json` and
`crs_provenance.json`, validates the backend provenance contract and
compatibility class, and verifies all final-artifact digests before embedding
the verifier Sigma. `prepack` always runs the production build, so it cannot
reuse locally generated active inputs. The development generator requires only
the explicit debug Sigma; it does not treat a debug CRS as publishable.

## Test fixture policy

Fixture preparation copies existing owner-package outputs. It must not run
native setup, preprocess, prove, verifier, QAP compilation, or synthesizer
programs.

Prepare the required owner outputs first, then run:

```sh
npm run fixtures:copy
npm run fixtures:prepare
```

Source copies are written under ignored `tmp/fixtures/`. Converted test
artifacts are written under ignored `fixtures/small/runtime/`. Missing owner
artifacts must fail explicitly; do not add generated fallbacks.

## Checks

Run focused checks while developing:

```sh
npm run typecheck
npm run typecheck:scripts
npm run contracts:check
npm run binary:check
npm run prover:ops:check
npm run prover:witness:check
npm run verifier:check
npm run preprocess:public-api:check
npm run preprocess:browser:check
npm run prover:check
npm run verifier:browser:check
npm run prover:browser:check
npm run converter:browser:check
npm run docs:examples:check
npm run build
```

`npm run prover:stage-timing:check` is the retained development-only timing
table generator. Timing, diagnostics, tests, fixtures, scripts, tools, and
`tmp` output must not enter the npm tarball.

Optimization work must preserve the benchmark and correctness requirements in
the repository's
[`prover-optimization-history.md`](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/backend-wasm/docs/optimization/prover-optimization-history.md).

## Publication preparation

1. Run `npm run version:sync -- X.Y.Z` at the repository root. This updates
   the package manifest, lockfile declaration, generated version constants,
   and private decoder package together with the other synchronized release
   surfaces.
2. Run `npm run version:check` at the repository root.
3. Regenerate production inputs with `npm run build:production` and run the
   complete relevant production check set.
4. Build the exact package candidate.
5. Inspect the actual packlist and packed metadata:

   ```sh
   export BACKEND_WASM_VERIFIER_CRS_DIR=/absolute/path/to/final-crs-directory
   npm pack --dry-run
   ```

6. Confirm that `dist`, README, both package licenses, third-party notices, the
   converter Worker, and decoder WASM are included.
7. Confirm that `test`, `scripts`, `fixtures`, `tools`, `tmp`, diagnostics, and
   copied artifacts are excluded.
8. Exercise the packed package through the browser consumer checks before
   publication:

   ```sh
npm run converter:browser:check
npm run converter:crs:browser:check
npm run converter:webpack:check
   ```

   `converter:crs:browser:check` requires the copied and prepared owner
   fixtures described above. The release CI runs the converter error and
   Worker-boundary check because it does not acquire or generate test CRS
   fixtures.

The package intentionally remains outside the root npm workspace. Its release
build resolves the exact synchronized `@tokamak-zk-evm/subcircuit-library`
version from npm after the release workflow publishes that package.

`docs:development-package:check` validates documentation and a package built
from local QAP and the explicit debug Sigma. It is not a publication-candidate
check. The release workflow runs `package:publication:check` only after
`build:production`; that command requires packed active setup metadata to
identify the npm snapshot.

The repository release workflow validates the latest compatible public CRS,
exports its verified `sigma_verify.json`, rebuilds the embedded verifier CRS,
and uploads `snark-browser-compat-release-tarball`. It compares the synchronized
tarball version with npm and uses the configured npm Trusted Publisher to
publish only a strictly newer version. An equal version is validated but not
republished; an older repository version fails. npm versions are immutable and
must never be reused for changed package contents.

For a synchronized release:

1. Run the root version synchronization and validation commands.
2. Review and merge the release PR into `main`.
3. Require the browser-compatible SNARK build and pre-publish checks to pass.
4. Confirm the publish job selects the exact verified tarball and reports the
   expected local and previously published versions.
5. Download `snark-browser-compat-release-tarball` when an independent archive
   review is required and run `sha256sum --check SHA256SUMS`.

License and redistribution findings for release 2.1.4 are recorded in the
repository's
[`snark-browser-compat-2.1.4-license-audit.md`](https://github.com/tokamak-network/Tokamak-zk-EVM/blob/main/packages/backend-wasm/docs/release/snark-browser-compat-2.1.4-license-audit.md).

Use `npm run clean:temp` to remove package-local temporary output while
preserving `tmp/planning.md`.
