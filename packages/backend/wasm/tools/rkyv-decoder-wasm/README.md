# Legacy combined-Sigma decoder

This crate is retained only as an internal decoder for historical test material
that contains a `combined_sigma.rkyv` archive. It is not part of the current
Tokamak zk-EVM CRS interface and is not imported by the browser prover,
preprocess, verifier, or public converter API.

Current CRS conversion is performed by the release-built native
`univariate-crs:convert` command. It reads the four role-separated backend
files (`tau_sequence.rkyv`, `prover_keys.rkyv`, `preprocess_keys.rkyv`, and
`verifier_keys.rkyv`) and emits a manifest with bounded browser chunks. See the
[backend-wasm README](../../README.md#artifact-model) for the supported
interface.

`decode_combined_sigma` and its wasm-bindgen export intentionally remain narrow:
they decode only the legacy `SigmaRkyv` archive shape and return an internal
section-payload container. They do not define a generic rkyv decoder, a
persisted browser artifact format, or a replacement for the current CRS
converter.

## Maintenance

Do not add new production callers to this crate. A current-artifact change
belongs in the backend common contract and the native chunk converter, not in
this compatibility tool. Generated `pkg/` and `target/` outputs are untracked.
This crate has no npm publication status: it is not a published package or a
supported application dependency.

## License

This decoder tool is dual-licensed under `MIT OR Apache-2.0`. Dependencies
retain their own licenses.
