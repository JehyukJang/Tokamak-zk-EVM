# Releasing `@tokamak-zk-evm/cli`

The fixed release controller on `main` is the only publication path. A push to
`main` is verification-only; the bootstrap or final-release operation is
explicitly dispatched with frozen commit identities.

## Before You Merge

1. Synchronize the repository version and add the corresponding dated entry to
   the root `CHANGELOG.md`.
2. Run:

```bash
npm run version:sync -- X.Y.Z
npm run version:check
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

1. Validates the frozen candidate head, frozen `main` base, and any approved
   foundation bootstrap identity.
2. Builds the candidate without npm or Drive mutation credentials.
3. Resolves and hash-checks the public CRS through read-only Drive access.
4. Validates the production lock and source-built tarball identities.
5. Publishes the foundation package during the bootstrap operation, then the
   Synthesizer packages, CLI, and browser package during final release. An
   already-published identical tarball is verified and skipped.

Registry failures other than an exact `E404` stop the operation. The root
[version and release rules](../../docs/version-rules.md) define the Changelog
date and staged foundation exception.
