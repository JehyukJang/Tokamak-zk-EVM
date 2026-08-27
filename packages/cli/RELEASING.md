# Releasing `@tokamak-zk-evm/cli`

The normal release path publishes this package automatically from `main`. A
manual maintainer command remains available for an intentional direct
publication or recovery.

## Before You Merge

1. Run the root version sync script with the next synchronized repository version.
2. Add a new top entry to the root `CHANGELOG.md`.
3. Make sure the top changelog entry version matches the synchronized repository version.
4. Make sure the top changelog entry includes a `### CLI` section with at least one user-facing bullet.
5. Run:

```bash
npm run version:sync -- 2.0.12
npm run version:check
npm run --workspace @tokamak-zk-evm/cli release:check
npm run --workspace @tokamak-zk-evm/cli release:runtime:check
```

## Runtime Installation Invariants

The runtime cache is an implementation artifact of the exact published CLI
version, not an independent compatibility authority. A CLI upgrade requires a
new `--install` run before commands may use the cached backend runtime.

Native installation stages backend binaries, ICICLE resources, and CRS data
outside the active runtime directory. It promotes the staged runtime only after
all preparation succeeds, and restores the prior runtime and installation state
if promotion or state persistence fails. Maintain regression coverage for the
following cases:

```bash
npm run --workspace @tokamak-zk-evm/cli test
```

`installation.json` is the sole selector between native and Docker execution.
Docker's `bootstrap.json` is a subordinate descriptor: the selected Docker
state, descriptor package version, Docker environment, and deterministic image
name must agree before a backend command can run in Docker. A native state must
ignore residual Docker descriptors. Docker installation writes the descriptor
before committing Docker state, so an interrupted install cannot select an
unwritten descriptor. On Linux only, a valid Docker selection may run the
installed native Linux runtime when the Docker daemon is unavailable; malformed
or mismatched Docker descriptors and missing Docker images remain errors.

The CRS installer may replace only its legacy setup directory or an active
symbolic link whose target is under its `generations/` directory. An unmanaged
symbolic link is an installation error and must remain unchanged.

## What Happens On `main`

When a commit reaches `main`,
`.github/workflows/publish-tokamak-zk-evm.yml`:

1. Reads `packages/cli/package.json`
2. Compares the local version with the version already published on npm
3. Validates the root `CHANGELOG.md`
4. Builds the CLI package
5. Runs `npm publish --dry-run`
6. Publishes to npm if the local version is newer

If the local version is equal to the npm version, the workflow does not publish.

## Manual Publishing

Use the manual path only when publishing the current checkout directly is
intentional:

```bash
npm run --workspace @tokamak-zk-evm/cli release:publish
```

The command validates release readiness, verifies the packed runtime's
production backend build and installer contracts, and runs
`npm publish --access public --ignore-scripts`. It requires an npm identity
authorized to publish `@tokamak-zk-evm/cli`. Additional npm publish arguments
may be passed after `--`, for example:

```bash
npm run --workspace @tokamak-zk-evm/cli release:publish -- --dry-run
```

Unlike the normal workflow, this command publishes from the local checkout
rather than the synchronized release tarball produced by GitHub Actions. The
maintainer is responsible for confirming that the checkout, package version,
root changelog, and intended commit are aligned before using it.

## Changelog Format

Use this format:

```md
## [2.0.12] - 2026-04-29

### CLI

- Short user-facing change
- Another user-facing change
```

Keep changelog entries short and written for package consumers. Record only changes that affect npm-published package artifacts or their consumer-facing behavior. Package artifacts do not include changelog files; package READMEs link to the root changelog instead.
