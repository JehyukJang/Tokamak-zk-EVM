# Tokamak zk-EVM MPC setup

For phase 2 contributors, operators and backend implementers. Filecoin supplies the externally completed phase 1; this repository implements only Tokamak phase 2. There is no standalone phase 1 adapter or trusted import receipt.

## Prerequisites and commands

Follow the [native build prerequisites](../../../README.md#prerequisites).
The executable still links ICICLE through the shared native library. When
running `target/release/mpc` directly, include your ICICLE library directory
in `DYLD_LIBRARY_PATH` on macOS or `LD_LIBRARY_PATH` on Linux. The local
macOS build uses `external-lib/mac/lib` relative to `packages/backend`;
the VS Code launcher already sets that environment.

MPC runs only from a local repository checkout; it is not an installed CLI component or a distributed production binary. Build one release-optimized executable for both execution modes:

- `--mode development` copies the existing local `frontend/qap-compiler/subcircuits` build into a private temporary snapshot. Build QAP first. This mode does not access npm and cannot authorize publication.
- `--mode publish --library-version MAJOR.MINOR.PATCH` acquires that exact `@tokamak-zk-evm/subcircuit-library` version through npm at runtime into a private temporary installation. Node.js and npm are required. Lifecycle scripts are disabled, and repository manifests and dependencies are not modified. The package must match the backend compatibility class and current circuit format; there is no local-QAP fallback.

Specify the mode before the operation on every invocation. Publish mode selects the circuit input for **CRS output publication to Google Drive**, not binary distribution. Only the explicit `publish` operation uploads; `finalize` remains offline in either mode. Neither optimization profile nor Cargo feature selects the MPC circuit source.

Obtain `challenge_19` directly from the pinned [Filecoin source](https://trusted-setup.filecoin.io/phase1/challenge_19), or omit `--filecoin-source` to download it during the operation. The source is 77,309,411,488 bytes (about 72 GiB). Every invocation, including verification and finalization, reads and hashes the complete original before accepting incoming state or sampling secret shares. Keeping your own raw copy avoids a download, not the digest check. A coordinator's converted tau, matching subset digest or previous receipt grants no authority.

From `packages/backend`:

```sh
cargo build --locked --release -p mpc-setup --bin mpc

target/release/mpc --mode development \
  init --filecoin-source /path/to/challenge_19 --output ./initial.mpc

target/release/mpc --mode development \
  contribute --filecoin-source /path/to/challenge_19 --input ./initial.mpc --output ./alice.mpc

target/release/mpc --mode development \
  contribute --filecoin-source /path/to/challenge_19 --input ./alice.mpc --output ./bob.mpc

target/release/mpc --mode development \
  verify --filecoin-source /path/to/challenge_19 --input ./bob.mpc

target/release/mpc --mode development \
  finalize --filecoin-source /path/to/challenge_19 --input ./bob.mpc --output ./final-keys
```

For a publish ceremony, replace `--mode development` in every command with `--mode publish --library-version <exact-compatible-version>`; replace the placeholder with an available package version. Do not rebuild the executable to change modes. A published library without the new m/t fields cannot run the current protocol. This does not block development-mode input preparation.

Run contributor commands in each contributor's own environment, not by sharing a trusted executable or source-verification cache. Initialization is deterministic and is not counted as a contribution. Transcript outputs must be new paths; failed operations preserve existing files. Resuming means using the last completed public transcript as the next input. There is no source-check bypass, source-pin override or converted-tau input option.

## Checks and outputs

Original-source preparation verifies the pinned BLAKE2b-512 digest, file length and preceding-response header, then checks canonical subgroup points, generators, adjacent powers and tagged families in the retained ranges. It cannot replay historical Filecoin attestations. Source pins and exact encoding are in the [design record](docs/current-phase2-design.md#filecoin-source-mapping).

Initialization uses group IFFTs and sparse R1CS combinations of encoded powers, never a recovered tau or tag scalar. Each contribution updates delta and independent wire weights and supplies the [Filecoin-profile share-knowledge evidence](docs/current-phase2-design.md#contribution-proof-profile). Verification rederives initialization, checks every record, validates its share proofs and cumulative roles, and checks all final-family equations. Public-buffer placement specialization and implicit-zero query omission match trusted setup.

The public transcript has a context-bound header followed by full state/proof records. Its counts come from the selected library. The header binds the execution mode, exact package version, circuit content digest and locally derived tau; later records inherit this binding. A development transcript cannot be continued or finalized in publish mode, even with byte-identical circuits. Each proof binds the preceding record chain, the new state, source/library identity and share role. Even an identity update cannot replay the previous receipt. The correctness baseline retains all public states and verifies the full chain; this is not yet a measured or optimized large-ceremony storage/verification design. Shares are never serialized and their owned buffers are cleared after use; this is not a guarantee against host compromise or all compiler-generated copies.

Finalization requires at least one verified contribution. It uses the same serializers and atomic generation activation as trusted setup:

- `tau_sequence.rkyv`: unchanged, locally derived Filecoin powers.
- `prover_keys.rkyv`: compressed prover queries and helpers.
- `preprocess_keys.rkyv`: self-contained preprocessing keys, including fixed-public queries.
- `verifier_keys.rkyv`: online-only verifier elements.
- `crs_provenance.json`: the common backend-owned document, with Filecoin source evidence, the full transcript SHA-256 and all four payload digests.

There is no JSON point projection. Intermediate correction/role points and share proofs are not added to the final CRS. Offline `finalize` writes `releaseEligible: false`, including in publish mode. Ordinary prover users may consume distributed tau files; contributors must still authenticate the original Filecoin source themselves.

## Publish a completed ceremony

After participants have independently completed a publish-mode transcript, one operator command verifies it, derives the final CRS and uploads it. It does not create contributions or coordinate participants:

```sh
target/release/mpc --mode publish --library-version <exact-compatible-version> \
  publish --input /path/to/final.mpc --output ./publication-keys \
  --filecoin-source /path/to/challenge_19
```

The command authenticates the complete original Filecoin source, acquires the exact npm snapshot, verifies initialization and every contribution, and requires at least one contribution. Only this verified publish-mode result receives `releaseEligible: true`. Common metadata and all four payload hashes are checked before transfer. The standalone `check_crs_publication` tool checks metadata and payloads only: it does not verify a ceremony or authorize upload. Runtime prove, preprocess and verify do not acquire publication-eligibility gates.

Configure these environment variables in the operator's environment:

| Variable | Value |
| --- | --- |
| `TOKAMAK_MPC_DRIVE_FOLDER_ID` | Writable CRS root folder used by consumers; provision anonymous folder listing in advance. |
| `TOKAMAK_MPC_DRIVE_OAUTH_CLIENT_JSON_PATH` | Installed-app OAuth client configuration file. |
| `TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH` | Token cache path; an existing cache must be a regular owner-only file (`chmod 600` on Unix). |

The installed OAuth flow may request browser authorization. Keep credential files outside Git. Credentials are accessed only after successful local finalization. The command checks root access without changing root permissions; it grants and tests public read access only for the version/tau folders and their publication files. Organizational restrictions on public sharing cause failure, not a private release reported as public.

The Drive layout matches the current full and verifier-only installers:

```text
<configured CRS root>/
  tau_sequence/
    <tau SHA-256>.rkyv
  <compatibleBackendVersion>/
    prover_keys.rkyv
    preprocess_keys.rkyv
    verifier_keys.rkyv
    crs_provenance.json
```

The version directory is the compatibility class (major.minor); the exact npm package version remains in provenance. Tau is shared independently of that directory. There is no ZIP or legacy layout. The remote provenance is byte-for-byte identical to the frozen local document; upload status and links are printed in the terminal, never written back to it.

Large payloads use 8-MiB chunks and [Drive resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads). Completion requires size and server-computed SHA-256 agreement; if Drive omits its optional [checksum field](https://developers.google.com/workspace/drive/api/reference/rest/v3/files), the command reads and hashes the remote bytes. A matching filename alone is insufficient. Existing conflicting tau, duplicate matches or a different release in the same version directory are rejected without overwriting published payloads.

Keys and provenance are prepared under a non-release staging name. The version name becomes visible only after all referenced files are complete and publicly readable. This is a staged activation, not a multi-file Drive transaction; do not run concurrent publishers for the same version.

On failure, the command exits unsuccessfully, preserves local output and reports the failed stage or remote staging object. Rerun the same command with the same transcript, library and output path: source and transcript are checked again, keys are rederived and compared, and the original provenance timestamp and bytes are preserved. A resumable session can recover uncertain chunk responses within an invocation; a later invocation restarts an unfinished staging file and reuses verified completed files. An already published identical result is verified without creating another release. To publish a different result, do not reuse a version directory containing an existing release.

## Qualification and limits

### Native E2E with test MPC output

This path is for repository developers testing native consumers without a live
Filecoin ceremony. It is an ignored Rust test, not an operator command or a
source-authentication override. It uses the local QAP build, a generated
standard-generator development tau, two deterministic test contributions, complete contribution
verification and the production MPC final-key projection. Trusted-setup final
prover/preprocess/verifier keys are not reused. The full local library can make
key preparation expensive even without the original Filecoin download.

Within one invocation, the transcript retains immutable, engine-bound verified
state. Each append checks its new serialized record, share proofs, predecessor
binding and full state equations once; it does not reverify the unchanged
prefix. Key projection reuses that state. Thus two continuous test contributions
perform two full state checks, not six. A separate participant or finalizer
still verifies every record read from an external transcript; this reuse is
not an on-disk verification receipt or a substitute for source authentication.

From `packages/backend`, with current local QAP and matching synthesizer outputs:

```sh
MPC_TEST_OUTPUT=/absolute/path/to/new-test-crs \
cargo test --locked --release -p mpc-setup --lib \
  native_fixture::prepare_native_e2e_keys -- --ignored --exact --nocapture
```

The output uses the four common archives and common provenance, with
`generationMethod: "mpc"`, local-QAP input, `releaseEligible: false` and
`phase1SourceProvenance: null`. The null source records that no Filecoin original
was authenticated. Deterministic contributions and development tau make these
keys unsuitable for release; the test never invokes OAuth or publication.
It uses the shared trusted-setup API to obtain test tau only and discards its
other keys. Arbitrary trusted-setup tau files are not interchangeable here:
they may use nonstandard G1/G2 bases, whereas the MPC kernel expects the
standard bases of its pinned Filecoin input.

Use the generated directory for native preprocess and prove. Build verify with
`TOKAMAK_VERIFIER_KEYS` pointing to its `verifier_keys.rkyv`; verifier parameters
must come from the same local QAP build. Run the resulting verifier on the newly
generated preprocess/proof and the matching synthesizer instance. Then run
`verify`'s ignored `local_fixture` test with `VERIFY_TEST_PREPROCESS`,
`VERIFY_TEST_PROOF` and `VERIFY_TEST_INSTANCE` pointing to those files, preserving
`TOKAMAK_VERIFIER_KEYS` during that test build:

```sh
export TOKAMAK_VERIFIER_KEYS=/absolute/path/to/new-test-crs/verifier_keys.rkyv
cargo build --locked --release -p verify --features local-development-subcircuit-library
VERIFY_TEST_PREPROCESS=/absolute/path/to/preprocess/univariate_verifier_preprocess.bin \
VERIFY_TEST_PROOF=/absolute/path/to/prove/univariate_proof.bin \
VERIFY_TEST_INSTANCE=/absolute/path/to/synthesizer/outputs/instance.json \
cargo test --locked --release -p verify --features local-development-subcircuit-library \
  --test local_fixture -- --ignored --exact accepts_real_proof_and_rejects_tampering --nocapture
```

Do not proceed to native consumers if key preparation fails. An accepting proof and tamper
rejection qualify this native test flow only, not live ceremony or publication.

### Test suites and live qualification

Run local release checks with:

```sh
cargo test --locked --release -p mpc-setup
```

Synthetic tests compare all four finalized archive byte streams to trusted setup under identical effective test scalars after two sequential updates. They exercise public/free/fixed specialization, omitted queries, every updated family, share evidence, replay, context substitution, truncation and non-overwriting output. Fake-Drive tests cover publication layout, tau reuse, failures during staging, permission/checksum rejection, conflicting versions, retries and identical provenance bytes. These are correctness tests, not a security proof or real Filecoin/npm/Drive E2E qualification.

Development qualification can use the local QAP build with the live 72-GiB source for multi-contributor finalization and native preprocess/prove/verify. Publish qualification additionally requires a compatible published current-protocol npm library, a completed publish transcript, configured OAuth/destination access and authorization to upload. Record the mode and input identity with any qualified release timing; development results do not qualify the publish path. No successful live ceremony, native MPC E2E, Drive release or timing baseline is claimed here. The broader security analysis of the extra intermediate public encodings is deferred; do not treat the reference paper's Groth16 theorem as a theorem for this Tokamak extension. Additional cryptographic release attestations and separation of release authorities remain future work; the current publication guard is operational.

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
updates and public consistency equations. It is not a live-ceremony
qualification or a security certification. Contribution proof-of-knowledge
verification remains required even though the broader analysis is deferred.

## License

The MPC setup implementation and documentation are dual-licensed under
`MIT OR Apache-2.0`.
