# Subcircuit Library Generation and Release

This document describes how the maintainer-side `qap-compiler` workflow relates to the published Tokamak zk-EVM Subcircuit Library package.

## Overview

The published package is the consumer-facing output.

The maintainer-side `qap-compiler` is the generation algorithm and tooling that produces that output from EVM-spec-derived circuit definitions and constants. Consumers use the generated subcircuit library. Maintainers use `qap-compiler` to regenerate it.

## qap-compiler and the Published Library

The relationship is:

`qap-compiler` generation algorithm and tooling -> generated Tokamak zk-EVM Subcircuit Library package

More concretely:

- `qap-compiler` works from the repository's circuit templates, subcircuit definitions, and synced constants.
- Those inputs encode Tokamak zk-EVM behavior derived from the relevant EVM semantics and project-specific circuit design choices.
- The generation flow produces the compiled subcircuit library artifacts that downstream consumers use.
- The published npm package exposes the generated library, not the maintainer-side generation workflow.

## Generation Flow

The maintainer-side flow is:

1. Run `npx qap-compiler --reload-constants`. The command resolves npm's current
   `tokamak-l2js` `latest` release, installs that exact version locally, and updates
   only `nPrivateMessageInputs` and `nPoseidonInputs` in
   `subcircuits/circom/constants.circom`. A normal initial install also declares
   the `latest` release line; the reload command is the explicit maintainer action
   that synchronizes generated constants to the then-current npm release.
2. Build the generated subcircuit library into `subcircuits/library`. The build
   invokes Circom with explicit O2 optimization; compiler-default, O0, and O1
   artifacts are not valid library outputs or constraint-measurement baselines.
3. Assemble the publishable `dist` package from the generated library, synced constants, package metadata, and the consumer-facing README.
4. Publish `dist` to npm.

The published `dist` package excludes the build-log-style `info` directory and keeps the consumer-facing artifact surface focused on the generated library outputs and synced constants.

## Published Artifact Surface

The published package contains:

- generated R1CS artifacts
- generated WASM artifacts
- generated JSON metadata
- witness-generation helper scripts
- synced `constants.circom`
- `build-metadata.json` with the `tokamak-l2js` package version used for the generated build
- package metadata and licenses

These published outputs form the consumer-facing subcircuit library surface.

## Versioning and Release

The repository source package remains private. The published npm package is assembled from `dist`.

Versioning rules for this package are:

- npm version changes are synchronized from the root repository version.
- changelog entries are maintained in the root `CHANGELOG.md` and record only changes that affect npm-published package artifacts or their consumer-facing behavior.
- the `dist` package does not include a changelog file; its README links to the root changelog.
- package-specific Git tags use the format `subcircuit-library-vX.Y.Z`.
- package-specific tags are maintained from `1.0.0` onward.
- pre-`1.0.0` history is preserved as reconstructed repository history rather than as package-specific tags.

## Documentation Split

The top-level `README.md` is consumer-facing.

Detailed material lives in `docs/`:

- consumer integration details
- maintainer-side generation and release details
- security audit and reference material
