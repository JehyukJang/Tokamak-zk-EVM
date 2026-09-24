# Releasing `@tokamak-zk-evm/cli`

The normal release path uses the fixed release controller from `main`. A push
to `main` is verification-only; an authorized owner explicitly dispatches the
bootstrap or final-release operation with frozen commit identities. A manual
maintainer command remains available for an intentional direct publication or
recovery.

## Before You Merge

1. Run the root version sync script with the next synchronized repository version.
2. Add a new top entry to the root `CHANGELOG.md`.
3. Make sure the top changelog entry version matches the synchronized repository version.
4. Make sure the top changelog entry includes a `### CLI` section with at least one user-facing bullet.
5. Run:

```bash
npm run version:sync -- X.Y.Z
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
`.github/workflows/publish-tokamak-zk-evm.yml` verifies the resulting release
tree only. The explicit controller dispatch then:

1. Validates the owner, frozen candidate head, frozen `main` base, and any
   approved foundation bootstrap identity.
2. Builds the candidate without npm or Drive mutation credentials.
3. Resolves and hash-checks the public CRS through read-only Drive access.
4. Validates the production lock and source-built tarball identities.
5. Publishes the foundation package during the bootstrap operation, then the
   Synthesizer packages, CLI, and browser package during final release. An
   already-published identical tarball is verified and skipped.

The staged controller is the selected path for the `3.0.0` release. Registry
failures other than an exact `E404` stop the operation. The separately
maintained manual publishing command remains available outside that controller;
it is not part of the normal frozen-tree release path.

## Manual Publishing

Use the manual path only when publishing the current checkout directly is
intentional:

```bash
npm run --workspace @tokamak-zk-evm/cli release:publish
```

The command first runs the root repository version-policy check, then validates
CLI release readiness, verifies the packed runtime's production backend build
and installer contracts, and runs `npm publish --access public
--ignore-scripts`. It requires an npm identity authorized to publish
`@tokamak-zk-evm/cli`. Additional npm publish arguments may be passed after
`--`, for example:

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
## [MAJOR.MINOR.PATCH] - YYYY-MM-DD

### CLI

- Short user-facing change
- Another user-facing change
```

For a real release, replace the placeholders with the synchronized release
version and the local calendar date on which the release pull request is
prepared offline. That date may differ from the npm publication date and the
GitHub merge date. The release entry must be dated; do not leave an
`Unreleased` heading in the release pull request.

Keep changelog entries short and written for package consumers. Record only changes that affect npm-published package artifacts or their consumer-facing behavior. Package artifacts do not include changelog files; package READMEs link to the root changelog instead.
