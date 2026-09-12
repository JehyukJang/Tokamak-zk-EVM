# Tokamak zk-EVM MPC Setup

This guide is for developers implementing and reviewing the MPC setup and
operators who prepare, verify, or finalize its artifacts.

## Replacement status

The target workflow is a Filecoin phase 1 import adapter followed by a
Tokamak phase 2 ceremony using the `@tokamak-zk-evm/subcircuit-library` npm
snapshot. Phase 1 conversion does not run a new MPC ceremony. Dusk and the
previous MPC protocol are retired design targets; their implementation is
scheduled for removal, without backward compatibility.

Phase 1 is implemented as `mpc phase1`. Phase 2 and final CRS generation are
not implemented yet. The old native/Dusk binaries are no longer Cargo targets,
and their modules are not part of the compiled library. Remaining legacy
source/integration files are awaiting removal, not supported entry points.
The existing
[two-phase output contract](docs/phase2-output-contract.md) and
[MPC protocol document](../../../docs/publication/tokamak-mpc-protocol.md)
also describe that old construction and are not specifications for the new
phase 2. The references and implementation requirements below apply to the
replacement.

## Phase 1 import

Use the Rust backend's build prerequisites and run commands from
`packages/backend`. Phase 1 accepts an exponent capacity, not a circuit
library; the default build does not read local QAP artifacts or resolve an
npm snapshot for this command. Production npm selection belongs to phase 2.
Use `cargo run` below so Cargo supplies native dependency search paths.

Import an existing, uncompressed Filecoin `challenge_19` file:

```bash
cargo run --locked --release -p mpc-setup --bin mpc -- phase1 \
  --source /path/to/challenge_19 \
  --capacity 524291 \
  --output /path/to/new-phase1-import
```

Alternatively, replace `--source /path/to/challenge_19` with `--download`.
Select exactly one source mode. Both modes require the same pinned source;
there is no URL, source-digest or verification-bypass option.

The example capacity is not a default or a circuit-independent requirement.
`P` is the maximum tagged/G2 exponent, not a point count. Output contains
ordinary G1 exponents 0 through 2P, xi/psi G1 and ordinary G2 exponents 0
through P, and psi in G2. Valid standalone P is 1 through 134217727. Phase 2
must check its selected library's demand against that capacity.

The complete source is 77,309,411,488 bytes (about 72 GiB). Even a small P
requires reading that entire stream to check its pinned BLAKE2b-512 digest.
The download path retains only the selected ranges in memory and does not
write a 72-GiB source copy. It neither resumes an interrupted download nor
falls back to another source. Rerun an interrupted import from the start.

The parent output directory must exist and the output path must not exist.
After all validation succeeds, a sibling staging directory is renamed into
place with two files:

- `tau_sequence.rkyv`: the common, little-endian affine-coordinate archive.
- `import_receipt.json`: source pin, capacity, output SHA-256 and the checks
  performed by this import. This is an intermediate import receipt, not
  `crs_provenance.json` or a phase 2 contribution receipt.

No prover, preprocess or verifier keys are produced. No release eligibility
is granted. Failure leaves no active import directory and does not overwrite
an existing import. Operators must not concurrently write the same output
path.

### Validation and qualification

The adapter checks the full source digest and preceding-response header,
canonical uncompressed point encodings, nonzero subgroup membership,
generators, selected adjacent-power relations, and the beta G1/G2 pairing.
Power checks use independent random nonzero scalar coefficients after source
capture, with every adjacent pair included across batch boundaries. The
source and decoder revisions are recorded in the
[design checkpoint](docs/current-phase2-design.md#filecoin-source-mapping).

These checks do not replay the historical Filecoin contribution chain or
verify its participant signatures. The receipt lists only performed checks.
Circuit-specific evaluation-domain checks belong to phase 2, which knows
the circuit dimensions.

On 2026-09-12, the release package tests passed: eight adapter tests, one
command-line test and six phase 2 algebra tests. They cover synthetic
upstream-format streams, source corruption, invalid points, power/tag
inconsistency, output failure/overwrite handling and common archive equality.
A bounded real-source G2 generator probe also matches the pinned encoding.
The full 72-GiB source has **not** been imported in this qualification run;
neither production phase 2 nor MPC SNARK E2E has been qualified.

```bash
cargo test --locked --release -p mpc-setup
```

## Phase 2 references

1. **Primary security and contribution reference: Snarky Ceremonies.**
   Markulf Kohlweiss, Mary Maller, Janno Siim, and Mikhail Volkhov.
   *Advances in Cryptology — ASIACRYPT 2021*, Part III, pp. 98–127.
   [Publication](https://doi.org/10.1007/978-3-030-92078-4_4);
   [ePrint 2021/219](https://eprint.iacr.org/2021/219).
   Use its ceremony framework, `Update` and `VerifySRS` algorithms, and
   proof-of-knowledge construction to derive participant updates and public
   verification. It revisits the BGM Groth16 ceremony and analyzes security
   without a random beacon, under its stated algebraic-group, random-oracle
   and hardness assumptions. Those assumptions are part of the reference,
   not an unconditional guarantee for a different CRS.
2. **Foundational construction: Scalable Multi-party Computation for
   zk-SNARK Parameters in the Random Beacon Model.**
   Sean Bowe, Ariel Gabizon, and Ian Miers. Cryptology ePrint Archive,
   Report 2017/1050 (BGM).
   [Paper](https://eprint.iacr.org/2017/1050).
   Use its two-phase structure, circuit specialization from encoded powers,
   sequential contribution construction, and consistency checks. Read its
   random-beacon security model together with the later analysis in
   *Snarky Ceremonies*; do not mix their assumptions or proof systems
   without establishing the resulting construction's requirements.
3. **Supporting implementation reference: Filecoin Phase2.**
   [Official source](https://github.com/filecoin-project/filecoin-phase2).
   This implements Groth16 phase 2 for Filecoin circuits. Use it to inspect
   engineering choices and the producer ecosystem, not as a specification
   for Tokamak's different queries or as evidence of their security.

### Applying the references to Tokamak

Derive phase 2 from these references rather than porting the previous
Tokamak MPC kernels. The current Tokamak protocol and common artifact
contracts determine the final CRS; the references determine the starting
point for the contribution and verification design. Before implementing a
kernel, map its state, update equation, verification equation and public
evidence to the cited construction, identifying every Tokamak-specific
extension. In particular, cover the wire weights, weighted-selection queries,
inverse-delta queries and unscaled fixed-public queries.

Neither paper automatically proves security for those extensions or for the
complete public Filecoin history plus Tokamak contribution transcript. The
intermediate public-view extension is permitted; its cryptographic security
analysis is [future work](docs/current-phase2-design.md#future-work-cryptographic-security-analysis),
not a prerequisite for the current implementation. Point consistency,
file hashes and an accepting SNARK proof do not replace proof-of-knowledge
checks or the security argument for the contribution construction.

The [current phase 2 derivation checkpoint](docs/current-phase2-design.md)
records the pinned Filecoin family mapping, intermediate state, packed-weight
updates and public consistency equations. It is not a completed ceremony
implementation or a security certification. Contribution proof-of-knowledge
verification remains required even though the broader analysis is deferred.

## License

The MPC setup implementation and documentation are dual-licensed under
`MIT OR Apache-2.0`.
