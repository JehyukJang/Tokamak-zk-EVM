# Tokamak zk-EVM Version and Release Rules

This document is for repository maintainers and the GitHub, npm, and Google
Drive release authorities. It defines the release boundary; it is not a user
installation guide.

## Versioned elements

The public npm packages use one synchronized `MAJOR.MINOR.PATCH` version:

- `@tokamak-zk-evm/subcircuit-library`;
- `@tokamak-zk-evm/synthesizer-node`;
- `@tokamak-zk-evm/synthesizer-web`;
- `@tokamak-zk-evm/cli`; and
- `@tokamak-zk-evm/snark-browser-compat`.

The root `package.json` is authoritative for that version and the backend Rust
workspace inherits it. The Rust backend is installed or built by the CLI; it
is not a standalone npm or crates.io release.

`packages/backend/wasm` intentionally resolves the exact published
`@tokamak-zk-evm/subcircuit-library` version from npm. It is outside the root
workspace so that its tracked lock records the registry tarball and SHA-512
integrity that a published consumer will receive.

The CLI manifest also declares a canonical `compatibleBackendVersion` of
`MAJOR.MINOR`. Package versions, backend metadata, and CRS provenance must
normalize to that same compatibility class. A patch release can reuse a CRS
only when this class and the source digest are unchanged.

## CRS identity and layout

The source digest is a SHA-256 framed digest of the CRS-relevant subcircuit
files, encoded as `sha256:<64 lowercase hexadecimal characters>`. The inputs
are the sorted package-relative paths and contents of the rendered constants,
R1CS, WASM, JSON, frontend configuration, setup parameters, and subcircuit
information. Package metadata, changelogs, witness helpers, and diagnostic
output are excluded. No FNV digest or legacy fallback is a compatibility
identity.

The public Filecoin-backed CRS is identified by `MAJOR.MINOR` and is stored in
Google Drive as:

```text
<root>/tau_sequence/<sha256 of tau_sequence.rkyv>.rkyv
<root>/MAJOR.MINOR/prover_keys.rkyv
<root>/MAJOR.MINOR/preprocess_keys.rkyv
<root>/MAJOR.MINOR/verifier_keys.rkyv
<root>/MAJOR.MINOR/crs_provenance.json
```

The compatibility directory contains the three role-key files and provenance.
Provenance names the digest-addressed shared tau and records the SHA-256 of the
tau and role-key payloads. Readers resolve exactly one compatibility directory,
reject duplicate required objects, download provenance first, then fetch only
the named tau and role-key files. Additional directory objects are ignored.
ZIP archives, timestamp selection, combined sigma files, and legacy archive
names are not release authorities.

CRS reuse requires both the compatibility class and equality of the source
digest in CRS provenance and all backend build metadata. A changed circuit,
public input contract, proving or verification semantics, setup output, or
CRS-required metadata needs a new compatibility class and CRS. A package-only
change can use a patch version only when those identities remain unchanged.

## Candidate and merge rule

One `dev` to `main` pull request carries all release source changes. Its
Changelog date is the local calendar date on which the release PR is drafted
offline. That record may differ from both the npm publication date and the
GitHub merge date.

The normal rule is exact-tree admission: every package and CRS is built from
the frozen final PR head, and `main` receives that same tree by fast-forward
merge. The frozen PR head and `main` base must not change between admission and
merge. A changed head, changed base, non-fast-forward result, identity mismatch,
or source defect stops admission; immutable package versions are never
republished from changed contents.

The sole bootstrap exception is
`@tokamak-zk-evm/subcircuit-library@3.0.0`. It may be published before the
final tree because the npm metadata is required to create the browser
production lock. The bootstrap candidate must be an ancestor of the final
candidate. Re-packing the foundation from the final candidate must reproduce
the published tarball identity. No CRS or other package uses this exception.

## Fixed main release controller

The release controller is a stable workflow already present on `main`; a
controller change is a separate control-plane maintenance pull request, never
part of a candidate that it authorizes. The controller has a fixed inventory
and fixed publication order, so no per-release manifest or mutable release
state file is authoritative.

An authorized repository maintainer dispatches the controller from the frozen
`main` base. It validates the exact candidate and base, and executes candidate
source only in jobs without npm OIDC or Drive mutation credentials.
Fixed-controller jobs receive built tarballs and query npm by exact package
version. They either confirm an existing byte-identical package or publish an
absent one with npm Trusted Publishing and `--ignore-scripts`.

The Google Drive folder owner performs CRS publication locally after ceremony
qualification. The controller has only the existing read-only Drive credential:
it resolves and hash-checks the public layout, then passes the public files to
an uncredentialed candidate validation job. It never uploads, changes a branch,
or creates a pull request.

The bootstrap operation accepts only the current `dev` head. The final-release
operation accepts only an open `dev` to `main` pull request with the supplied
head, base, and approved bootstrap-candidate SHA. The controller requires that
the bootstrap candidate is an ancestor of the final head and that the final
candidate reproduces the published foundation tarball. A retry uses the
same frozen identities, rechecks every published identity, and publishes only
missing packages. It cannot repair a source change or replace an immutable
version.

A `main` push is verification-only. It must not publish npm packages, mutate
Drive, create branches, or create pull requests. A release-relevant direct
push is invalid unless the resulting tree has already completed the same
package and CRS admission checks.

## Operational constraints

- `tokamak-l2js` remains exactly `0.2.0` in manifests and tracked locks.
- The CLI must fail before runtime work when synchronized `3.0.0` packages are
  mixed with `2.x.y` packages.
- Release checks use Node.js `24.20.0`, npm `11.19.0`, Rust `1.95.0`, Circom
  `2.2.3`, and committed locks.
- Only a verified npm `E404` establishes that an exact version is absent.
  Authentication, authorization, malformed metadata, network errors, or an
  existing non-identical tarball stop admission.
- Tokens, OAuth material, private keys, service-account files, and npm
  authentication material remain untracked. GitHub authority is
  `JehyukJang`, npm authority is `jehyuk`, and Drive mutation authority belongs
  to the folder owner.
- The Filecoin-backed phase-2 operational limitation may be described only as
  an implementation fact until the deferred security-boundary research
  supports a security claim.
