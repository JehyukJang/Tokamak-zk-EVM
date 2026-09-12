# Tokamak zk-EVM MPC Setup

This guide is for developers implementing and reviewing MPC setup and for
prospective phase 2 contributors assessing its source-authentication boundary.

## Implementation status

Filecoin supplies the externally completed phase 1. This repository implements
Tokamak phase 2, not a new phase 1 or a standalone adapter replacing it. Each
contributor must obtain the original Filecoin source, authenticate its full
pinned digest, and derive the required tau subset locally. A coordinator's
converted tau, subset digest or import receipt is not an authentication source.

Internal source preparation is implemented in
[`filecoin_source.rs`](src/filecoin_source.rs). The independent `mpc phase1`
command and its `import_receipt.json` output have been removed; there is
currently no MPC binary target. Initialization, contribution, contribution
verification and finalization commands are not implemented yet. They will
connect this internal preparation to every participant operation and resolve
the identical `@tokamak-zk-evm/subcircuit-library` npm snapshot independently
for each participant.

Old native/Dusk binaries are not Cargo targets and their modules are excluded
from the library. Residual Dusk source/integration files await the separate
retirement step; they are not supported commands. The old
[two-phase output contract](docs/phase2-output-contract.md) and
[MPC protocol document](../../../docs/publication/tokamak-mpc-protocol.md)
describe the retired construction, not specifications for its replacement.

## Contributor-local source preparation

Internal local-file and download functions take the selected library's
`SetupParams`, not a caller-selected exponent capacity. They reuse
`UnivariateCrsShape::from_setup_params`, as trusted setup does, to derive the
minimum required P and reject an invalid shape or insufficient source capacity
before source I/O. npm resolution and the binding to incoming phase 2 state
belong to the pending participant workflow; isolated source preparation does
not authenticate the origin of an arbitrary metadata object by itself.

The expected source URL, producer revision, full BLAKE2b-512 digest and
preceding-response header are pinned from Filecoin. There is no public
source-pin, capacity or verification-bypass option. The two internal paths are:

- Read a contributor's own original `challenge_19` obtained from Filecoin.
  Check its full byte length and digest on each preparation, even after a
  previous successful run.
- Download the pinned original directly from Filecoin and authenticate the
  complete stream. Do not accept an independently prepared tau file.

The source contains 77,309,411,488 bytes (about 72 GiB). Every preparation
reads that entire stream to verify the pinned digest. The same pass retains
only the selected ranges; no complete source copy needs to be written to disk.
After authentication, validate and convert those retained bytes. They cannot
be replaced between hashing and decoding by changing a local source file.
An interrupted download restarts from the original source; there is no
alternate-source fallback or trusted converted-subset cache.

P is the maximum tagged/G2 exponent, not a point count. The in-memory result
uses the existing common `TauSequenceRkyv` representation: ordinary G1
exponents 0..2P, xi/psi G1 and ordinary G2 exponents 0..P, and psi in G2.
Bounds are inclusive. No new archive, receipt or final provenance is written
by source preparation. It samples no secret tau or tag and grants no release
eligibility. Necessary source identity and check evidence will be bound to
the phase 2 transcript and final common provenance, not a new import manifest.

The eventual finalized `tau_sequence.rkyv` remains an ordinary prover input.
Its distribution does not authorize a contributor to trust it instead of the
original Filecoin source. Trusted setup remains a separate one-command
development path.

### Validation and qualification

Preparation checks the complete source digest and preceding-response header,
canonical uncompressed coordinates, nonzero subgroup membership, generators,
selected adjacent-power relations and the beta G1/G2 pairing. Power checks
sample independent nonzero random coefficients after source authentication;
every adjacent pair is included across batch boundaries. These are public
check coefficients, not participant secret shares. The source and decoder
revisions are recorded in the
[design checkpoint](docs/current-phase2-design.md#filecoin-source-mapping).

These checks do not replay Filecoin's historical contributions or verify its
participant signatures. The full 72-GiB source has not been processed in this
qualification; the earlier bounded G1/G2 probes are encoding examples, not
full-source authentication. Synthetic fixtures use private test-only pins and
known scalar oracles. They cannot enable a runtime source override.

From `packages/backend`, with the native build prerequisites installed:

```sh
cargo test --locked --release -p mpc-setup
```

The source tests cover full-stream corruption (including unretained bytes),
short reads, invalid points, power/tag inconsistency, common archive equality,
library-derived capacity and early input rejection. They are independent of
the unfinished phase 2 engine. Successful source tests do not establish
participant workflow enforcement, contribution proofs or MPC/native SNARK E2E.

On 2026-09-12, all 16 release tests passed: ten internal source tests and six
phase 2 algebra-model tests. Cargo metadata confirms that the package exposes
no binary target. No full-source download or production npm resolution was
performed for this checkpoint.

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
