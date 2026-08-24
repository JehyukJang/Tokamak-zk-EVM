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
npm run --workspace @tokamak-zk-evm/cli build
```

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

The command validates release readiness, rebuilds the package, and runs
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
