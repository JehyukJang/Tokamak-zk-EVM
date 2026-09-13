# Tokamak zk-EVM MPC setup

For phase 2 contributors, operators and backend implementers. Filecoin supplies the externally completed phase 1; this repository implements only Tokamak phase 2. There is no standalone phase 1 adapter or trusted import receipt.

## Prerequisites and commands

Use the repository's native build prerequisites and a compatible published `@tokamak-zk-evm/subcircuit-library` snapshot. Every operation uses the participant's own build-resolved npm snapshot, extracted into a private temporary directory. Local QAP inputs are rejected. All examples use release optimization.

Obtain `challenge_19` directly from the pinned [Filecoin source](https://trusted-setup.filecoin.io/phase1/challenge_19), or omit `--filecoin-source` to download it during the operation. The source is 77,309,411,488 bytes (about 72 GiB). Every invocation, including verification and finalization, reads and hashes the complete original before accepting incoming state or sampling secret shares. Keeping your own raw copy avoids a download, not the digest check. A coordinator's converted tau, matching subset digest or previous receipt grants no authority.

From `packages/backend`:

```sh
cargo run --locked --release -p mpc-setup --no-default-features \
  --features production-npm-subcircuit-library --bin mpc -- \
  init --filecoin-source /path/to/challenge_19 --output ./initial.mpc

cargo run --locked --release -p mpc-setup --no-default-features \\
  --features production-npm-subcircuit-library --bin mpc -- \\
  contribute --filecoin-source /path/to/challenge_19 --input ./initial.mpc --output ./alice.mpc

cargo run --locked --release -p mpc-setup --no-default-features \\
  --features production-npm-subcircuit-library --bin mpc -- \\
  contribute --filecoin-source /path/to/challenge_19 --input ./alice.mpc --output ./bob.mpc

cargo run --locked --release -p mpc-setup --no-default-features \\
  --features production-npm-subcircuit-library --bin mpc -- \\
  verify --filecoin-source /path/to/challenge_19 --input ./bob.mpc

cargo run --locked --release -p mpc-setup --no-default-features \\
  --features production-npm-subcircuit-library --bin mpc -- \\
  finalize --filecoin-source /path/to/challenge_19 --input ./bob.mpc --output ./final-keys
```

Run contributor commands in each contributor's own environment, not by sharing a trusted executable or source-verification cache. Initialization is deterministic and is not counted as a contribution. Transcript outputs must be new paths; failed operations preserve existing files. Resuming means using the last completed public transcript as the next input. There is no source-check bypass, source-pin override or converted-tau input option.

## Checks and outputs

Original-source preparation verifies the pinned BLAKE2b-512 digest, file length and preceding-response header, then checks canonical subgroup points, generators, adjacent powers and tagged families in the retained ranges. It cannot replay historical Filecoin attestations. Source pins and exact encoding are in the [design record](docs/current-phase2-design.md#filecoin-source-mapping).

Initialization uses group IFFTs and sparse R1CS combinations of encoded powers, never a recovered tau or tag scalar. Each contribution updates delta and independent wire weights and supplies the [Filecoin-profile share-knowledge evidence](docs/current-phase2-design.md#contribution-proof-profile). Verification rederives initialization, checks every record, validates its share proofs and cumulative roles, and checks all final-family equations. Public-buffer placement specialization and implicit-zero query omission match trusted setup.

The public transcript has a context-bound header followed by full state/proof records. Its counts come from the selected library. Each proof binds the preceding record chain, the new state, source/library identity and share role. Even an identity update cannot replay the previous receipt. The correctness baseline retains all public states and verifies the full chain; this is not yet a measured or optimized large-ceremony storage/verification design. Shares are never serialized and their owned buffers are cleared after use; this is not a guarantee against host compromise or all compiler-generated copies.

Finalization requires at least one verified contribution. It uses the same serializers and atomic generation activation as trusted setup:

- `tau_sequence.rkyv`: unchanged, locally derived Filecoin powers.
- `prover_keys.rkyv`: compressed prover queries and helpers.
- `preprocess_keys.rkyv`: self-contained preprocessing keys, including fixed-public queries.
- `verifier_keys.rkyv`: online-only verifier elements.
- `crs_provenance.json`: the common backend-owned document, with Filecoin source evidence, the full transcript SHA-256 and all four payload digests.

There is no JSON point projection. Intermediate correction/role points and share proofs are not added to the final CRS. Filecoin results write `releaseEligible: false`; publication is disabled pending an authorized Filecoin publication policy. No Drive upload, ZIP packaging or publisher command is provided. Ordinary prover users may consume distributed tau files; contributors must still authenticate the original Filecoin source themselves.

## Qualification and limits

Run local release checks with:

```sh
cargo test --locked --release -p mpc-setup
```

Synthetic tests compare all four finalized archive byte streams to trusted setup under identical effective test scalars after two sequential updates. They exercise public/free/fixed specialization, omitted queries, every updated family, share evidence, replay, context substitution, truncation and non-overwriting output. These are correctness tests, not a security proof or real Filecoin/npm E2E qualification.

The live 72-GiB source and a compatible published current-protocol npm library must pass multi-contributor finalization and native preprocess/prove/verify before release timing is recorded as a qualified baseline. No successful live ceremony, native MPC E2E or timing baseline is claimed here. The broader security analysis of the extra intermediate public encodings is deferred; do not treat the reference paper's Groth16 theorem as a theorem for this Tokamak extension. Publication authorization is a separate future task.

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
   [SnapDeals revision 934fe8c6d2df2589644302579838976d070c48a7](https://github.com/filecoin-project/filecoin-phase2/tree/934fe8c6d2df2589644302579838976d070c48a7),
   identified in the [official ceremony record](https://github.com/filecoin-project/phase2-attestations).
   This implements Groth16 phase 2 for Filecoin circuits. Use it to inspect
   engineering choices and the producer ecosystem. The contribution proof
   adopts its BLAKE2b-512, ChaCha20 and G2 point-sampling choices, not the
   previously proposed direct RFC 9380 suite. This reference does not specify
   Tokamak's different queries or establish their security.

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
