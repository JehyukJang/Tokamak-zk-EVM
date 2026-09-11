# Backend Contract Closure

Audience: maintainers of the backend workflow packages and their direct CLI and
browser consumers.

This document is the ownership inventory for backend contracts. It does not
define a new shared runtime abstraction. Its purpose is to make every contract
change review trace the complete path from the backend-owned JSON authority to
all in-repository producers and consumers.

The repository root owns canonical package-version parsing only. The contracts
listed here remain owned by `packages/backend`.

| Contract                        | JSON authority                                                        | Rust producer and ingress                                                                                                                                                                                   | TypeScript ingress and direct consumers                                                                                                           | Fixtures and documentation                                                                    |
| ------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| CRS provenance                  | `common/contracts/crs-provenance-contract.json`                       | `rust/libs/src/crs_provenance.rs`; final MPC writer `rust/setup/mpc-setup/src/flows/final_artifacts.rs`; algorithm ingress `rust/libs/src/subcircuit_library.rs`; publication admission `rust/libs/src/crs_publication_admission.rs`; workflow command `rust/libs/src/bin/check_crs_publication.rs`; Drive caller `rust/setup/mpc-setup/src/drive_upload.rs` | `common/contracts/typescript/crs-provenance-validator.ts`; copied to CLI `src/runtime/setup.ts` and backend-wasm `src/artifacts/binary/compatibility.ts` | `common/contracts/fixtures/final-mpc-crs-provenance*.json`; `common/contracts/fixtures/publication-admission`; `README.md`; `rust/setup/mpc-setup/README.md` |
| Backend build metadata          | `contracts/backend-build-metadata-contract.json`                      | `contracts/rust/backend_build_metadata.rs`; production writer `build-support/subcircuit_library/cargo_env.rs`                                                                                               | `contracts/typescript/backend-build-metadata-validator.ts`; copied to CLI `src/runtime/setup.ts`                                                  | `contracts/fixtures/backend-build-metadata*.json`; CLI installation tests                     |
| Subcircuit-library input origin | `common/contracts/crs-provenance-contract.json` (`subcircuitLibrary.origin`) | `common/contracts/rust/input_origin.rs`; build selection `rust/build-support/subcircuit_library/source_selection.rs`; serde ingress `rust/libs/src/input_origin_serde.rs` | CRS provenance validator's origin type; copied CLI and backend-wasm provenance validators | Provenance fixtures; backend and MPC setup documentation |
| Subcircuit source digest        | `common/contracts/rust/subcircuit_source_digest.rs` and the framing rule in `docs/version-rules.md` | Build producer `rust/build-support/subcircuit_library/integrity.rs`; CRS provenance and runtime build-metadata writers; publication admission | `common/contracts/typescript/subcircuit-source-digest.ts`; CLI compares CRS provenance with every runtime metadata file | `common/contracts/fixtures/subcircuit-source-digest-vectors.json`; provenance and build-metadata negative fixtures |
| Univariate relation domains     | `common/contracts/univariate-domain-contract.v1.json` | `rust/libs/src/univariate_crs.rs`; migrated trusted setup and protocol relation paths | generated `wasm/src/generated/univariate-domain-contract.generated.ts`; `wasm/src/univariate/domain.ts` | `common/contracts/fixtures/univariate-domain-shape.v1.json`; Rust and WASM domain checks |
| Univariate browser CRS chunks | `common/contracts/univariate-crs-chunk-contract.json` | 64-bit archive schema `common/interface/univariate-crs/src/lib.rs`; native mmap reader `wasm/tools/univariate-crs-chunker` | offline Montgomery converter `wasm/scripts/converter/convert-univariate-crs.ts`; generated contract and lazy runtime `wasm/src/univariate/chunked-crs.ts` | archive-width and native chunker tests; WASM conversion and admission check; `wasm/README.md` |

## Change Gate

### Common binary artifacts

`univariate-artifact-contract.json` owns the canonical coordinate encoding,
current four CRS role records, and proof/preprocess field order. The generated
Rust bindings and Rust/TypeScript codecs live in `common/interface` and have
no arithmetic-runtime dependency. `generate-artifact-codecs.mjs` refreshes
them; `prepare-contract-consumers.mjs --check` checks all generated copies.
The browser artifact JSON is a generated projection into the existing WASM
Montgomery envelope, not a second definition of proof or preprocess contents.

CRS retains its existing rkyv container and omitted-query layout. Proof is a
headerless 1,184-byte binary and preprocess output is a headerless 384-byte
binary; the latter is not `preprocess_keys.rkyv`. Affine coordinates and
scalars are canonical little-endian integers. Infinity has all-zero
coordinates. Codecs reject wrong lengths and noncanonical integers; they do
not replace point validation or protocol verification. File bytes are not F4
transcript bytes. The independently tested transcript encoding is unchanged.

Rust and WASM own arithmetic and their representation conversions. Future
`backend/solidity` owns verifier mathematics and the EVM call ABI, not a new
artifact format. The external private-state CLI consumes the common format
and ABI; application integration stays outside the verifier. Neither a
Solidity rkyv parser nor a duplicate CRS export is required by this boundary.
The contract relocation and external CLI migration have not been performed.

The native proof writer and native/WASM preprocess/verifier readers still
require migration. Generated codec tests alone do not establish runtime
interoperability or full proof verification.

The current univariate protocol contracts also include
`univariate-transcript-contract.json` and `univariate-artifact-contract.json`.
Transcript bytes are covered by
`fixtures/univariate-fiat-shamir.json` and the independent
`tests/univariate-transcript.test.mjs` oracle. The generated TypeScript binding
is `wasm/src/generated/univariate-transcript-contract.generated.ts`.

These updated contracts are the migration target. The existing native and
WASM protocol implementations are not yet evidence of conformance to them.
In particular, updating a generated binding does not complete its runtime
migration. CRS archives must ultimately expose four role-specific files:
`tau_sequence.rkyv`, `prover_keys.rkyv`, `preprocess_keys.rkyv`, and
`verifier_keys.rkyv`. Preprocess keys contain the bases for S_C, E_kappa, and
C_fix; the preprocess output contains the resulting points instead.

For a change to one of these contracts, maintainers must update every affected
cell in its row before treating the change as complete:

1. JSON authority and Rust representation or producer;
2. Rust ingress and TypeScript ingress;
3. every direct consumer identified above;
4. canonical and negative fixtures; and
5. user-facing documentation when the serialized or operational interface
   changes.

The focused closure check verifies that the listed implementation boundaries
remain present and that copied consumer assets are current. It complements,
but does not replace, the contract-specific semantic tests.
