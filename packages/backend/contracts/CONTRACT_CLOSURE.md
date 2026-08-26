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
| CRS provenance                  | `contracts/crs-provenance-contract.json`                              | `libs/src/crs_provenance.rs`; final MPC writer `setup/mpc-setup/src/flows/phase2_gen_files.rs`; algorithm ingress `libs/src/subcircuit_library.rs`; publisher ingress `setup/mpc-setup/src/drive_upload.rs` | `contracts/typescript/crs-provenance-validator.ts`; copied to CLI `src/runtime/setup.ts` and backend-wasm `src/artifacts/binary/compatibility.ts` | `contracts/fixtures/final-mpc-crs-provenance*.json`; `README.md`; `setup/mpc-setup/README.md` |
| Backend build metadata          | `contracts/backend-build-metadata-contract.json`                      | `contracts/rust/backend_build_metadata.rs`; production writer `build-support/subcircuit_library/cargo_env.rs`                                                                                               | `contracts/typescript/backend-build-metadata-validator.ts`; copied to CLI `src/runtime/setup.ts`                                                  | `contracts/fixtures/backend-build-metadata*.json`; CLI installation tests                     |
| Subcircuit-library input origin | `contracts/crs-provenance-contract.json` (`subcircuitLibrary.origin`) | `contracts/rust/input_origin.rs`; build selection `build-support/subcircuit_library/source_selection.rs`; serde ingress `libs/src/input_origin_serde.rs`                                                    | CRS provenance validator's origin type; copied CLI and backend-wasm provenance validators                                                         | Provenance fixtures; backend and MPC setup documentation                                      |

## Change Gate

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
