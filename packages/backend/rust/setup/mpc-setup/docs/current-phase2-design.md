# Current-protocol phase 2: construction and contribution format

## Audience and status

For engineers and cryptographic reviewers of the implemented Filecoin-backed
Tokamak MPC phase 2. This records its construction and trust boundary, not an
executable ceremony specification or a security certification. The final CRS
is defined by the current Tokamak manuscript and backend/common contracts.
References are maintained in the [MPC README](../README.md).

The implemented group-linear engine, share evidence and resumable commands
follow the construction below. Extra intermediate public encodings are
permitted; their security analysis remains deferred, not an implementation
gate. The previous ceremony implementation has been removed. There is no
repository phase 1 or standalone import command.

One repository-built release executable provides `init`, `init-dev`,
`contribute`, `verify`, `finalize` and `upload`. `init` selects an exact
compatible npm library with `--library-version` or, when omitted, the latest
published patch in the backend's compatible major-minor line. `init-dev` uses
a local QAP build. The transcript records the selected npm version for `init`
and no npm version for `init-dev`; subsequent operations infer the mode and
npm version from that record. Development operations require the local QAP
path. `verify` checks a transcript independently without creating keys.
`finalize` performs the same transcript verification whether or not `verify`
was run separately, requires at least one verified contribution and writes
the local CRS. Only a publish-origin transcript can produce
release-eligible keys. The separate `upload` operation transfers an already
finalized CRS without replaying the ceremony, as described in the
[operator guide](../README.md#upload-a-finalized-crs).

Local tests exercise the implementation but do not certify the
Tokamak-specific security extension or independently qualify a live ceremony.
Finalizing an `init-dev` transcript remains ineligible for upload.

## Filecoin source mapping

The official [Filecoin ceremony overview](https://github.com/filecoin-project/phase2-attestations#description-of-trusted-setup-phases)
identifies `phase1/challenge_19`. Its upstream implementation is
`arielgabizon/powersoftau` at
`2bd49903bac07485fe23e5ef1a2d5fa19561977b`, also named by the final
participant's [attestation](https://github.com/arielgabizon/perpetualpowersoftau/blob/b6c79904b0e8d535df6410027bc7ed7daf9f441b/0018_GolemFactory_response/README.md).
These are source pins for the derivation, not evidence that the entire
historical ceremony has been independently verified here.

The actual [verification binary](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/bin/verify_transform_constrained.rs)
selects `small_bls12_381::Bls12CeremonyParameters`. Despite that module's
name and stale comment, its [configured power is 27](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/small_bls12_381/mod.rs).
Let L = 2^27. The target uses xi = alpha and psi = beta.

| Filecoin family | Available exponents | Current target | Required exponents |
| --- | --- | --- | --- |
| Ordinary G1 powers | 0 through 2L-2 | `s0_g1` | 0 through 2P |
| Alpha-tagged G1 powers | 0 through L-1 | `sxi_g1` | 0 through P |
| Beta-tagged G1 powers | 0 through L-1 | `spsi_g1` | 0 through P |
| Ordinary G2 powers | 0 through L-1 | `tau_powers_g2` | 0 through P |
| Beta in G2 | One element | `psi_g2` | One element |

The upstream [layout implementation](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/batched_accumulator.rs)
orders the file as: 64-byte hash, ordinary G1, ordinary G2, alpha G1, beta
G1, then beta G2. Challenge points are uncompressed. G1/G2 sizes are 96/192
bytes. The total is 576L+160 = 77,309,411,488 bytes. This is the upstream
source size, not the size of the converted Tokamak CRS. The current library's
P=524,291 fits all these ranges; production capacity must still be derived
from the selected npm library rather than this example.

The attestation declares the decompressed challenge's BLAKE2b-512 digest:

```text
5a26015ba27d8164152407da8f9b87e47593f17ae4c260e467bac2ba9dda6f66c15fa352487604d1350ef33a3bfedb0d99e37b619161e27545017366274df76b
```

A bounded live probe on 2026-09-12 observed that exact file size and fetched
only bytes 0..159. Its first 64 bytes matched the attested preceding response
digest; the next 96 bytes matched the standard uncompressed G1 generator.
That probe checked only the header/layout candidate. The current participant
implementation instead hashes the entire pinned original and validates the
retained point encodings and power relations on each ceremony operation
(`init`, `init-dev`, `contribute`, `verify`, `finalize`). These runtime
checks do not independently verify the historical Filecoin contribution chain.

Internal participant source preparation uses that pinned layout. Its decoder follows the
upstream lockfile's [pairing revision c2af46ca](https://github.com/matterinc/pairing/blob/c2af46cac3e6ebc8e1e1f37bb993e5e6c7f689d1/src/bls12_381/ec.rs):
uncompressed big-endian x/y for G1; x.c1, x.c0, y.c1, y.c0 for G2. A second
bounded probe fetched the 192-byte G2 generator at offset 25,769,803,744 on
2026-09-12; the decoder maps it to the arkworks generator. The probe alone did
not perform the full-source BLAKE2b validation required by current ceremony
operations.
Synthetic source-format fixtures exercise the same parser and common archive
conversion without accepting configurable pins in the production API.

### Participant trust boundary

Each participant independently obtains the original Filecoin source and
checks its complete Filecoin-published pinned digest before accepting incoming
ceremony state or generating a secret contribution. The implementation retains
required ranges during that same authenticated read, then converts them locally.
The existing library-shape calculation determines P from the selected circuit
metadata; neither the initializer nor an import command supplies P. The
participant workflow prepares its own snapshot and binds the initialization
and incoming chain to the execution mode, package version, circuit content
and locally derived tau. Development reads the local QAP build; publish
acquires the exact npm version at runtime. No Cargo feature switches modes,
and no development transcript can be promoted to a publish transcript.

A coordinator's converted subset, matching subset digest or receipt cannot
replace original-source authentication. A directly acquired local original
avoids another download, not the full digest check. Source preparation returns
the common in-memory tau record without writing a standalone receipt or payload.
Its source pins remain internal constants: the share challenge binds the pinned
source digest, the transcript binds the locally derived tau digest, and final
provenance records the source identity. Final artifact ownership stays in
backend/common. The previous standalone phase 1 import architecture is
superseded, not another supported trust mode. Public relation-check randomness
is not a participant secret share.

## Reference construction and its limit

Use *Snarky Ceremonies*, ePrint 2021/219, revision dated 2021-09-21 on the
ePrint record. Section 5.2, Figure 6 (printed p. 17) gives initialization,
specialization and updates; Figure 7 (p. 18) gives SRS verification. Its
phase 2 samples a nonzero delta share, scales role elements forward and
specialized queries inversely, and proves knowledge of the share. Its update
receipt and specialized SRS include delta encodings in both source groups.
Its formal security result concerns its own Groth16 construction and public
view, not arbitrary extra secret parameters in Tokamak queries.

The Tokamak manuscript's U21 and complete-public-view discussion explicitly
exclude a positive-role first-source encoding. Copying Figure 6's delta
receipt therefore adds `[delta]_1` outside the current Tokamak view. Merely
omitting that element does not implement Figure 7 or inherit its security
argument. The intermediate extension is now permitted; its security analysis
remains future work. Keep these extra encodings out of the final CRS. This
approval does not change the manuscript or establish a security theorem.

## Packed-query update calculation

Use additive group notation. For a retained coordinate p=(i,k,j), write

```text
A_p = xi (U_p(tau) + tau^K V_p(tau))
    + psi (W_p(tau) + tau^K B_p(tau))
T_p = tau^S L_(i,k)(tau)
J_p = [(A_p + r_j T_p) / delta]_1
```

Here T_p names the selection factor; B_p(tau) inside A_p is the protocol's
interface image. For a free public query,
include its public interpolation term M in A_p. Fixed public queries contain
`[A_p + r_j T_p]_1` without division by delta.

Suppose one contribution uses delta' = u delta and r'_j = v_j r_j. The exact
identity is

```text
J'_p = u^-1 J_p + u^-1 (v_j - 1) [r_j T_p / delta]_1.
```

Consequently:

- Scaling J_p by u^-1 leaves the old weight in the numerator.
- Scaling all of J_p by v_j/u incorrectly changes the arithmetic/interface
  term A_p as well.
- A straightforward correction needs the separately encoded selection
  summand `[r_j T_p / delta]_1`. The current final CRS does not store it.
  If made public, subtracting it from J_p also exposes `[A_p/delta]_1`.
  This changes the public view; it is not just extra serialization metadata.
- Current weighted helpers contain two short ranges of r_j powers. They do
  not directly supply this inverse-delta selection summand. A pairing value
  is not a replacement for the missing source-group point.

This identifies why the existing family-scaling kernel is insufficient. It
does not prove that no secure alternative MPC construction can exist, or
that exposing the candidate summand alone is a demonstrated attack.

| Current family | Required behavior under (u, v_j) | Derivation status |
| --- | --- | --- |
| Imported tau/tagged sequences and ordinary preprocess powers | Unchanged | Authenticated source mapping |
| Weighted helper for wire j | Multiply by v_j | Direct identity |
| Inverse-delta masking queries | Multiply by u^-1 | Reference-style identity |
| `[delta]_2` | Multiply by u | Direct identity; share and chain checked separately |
| Packed nonpublic and free-public queries | Inverse-delta scaling plus selection correction | Implemented with the intermediate equations below |
| Unscaled fixed-public queries | Add `(v_j-1)[r_j T_p]_1` | Implemented with the intermediate equations below |

Choosing all r_j publicly or leaving them under one initializer's control
would violate the stated independent-secret requirement; neither is supported
by the implementation.

## Intermediate state and public consistency equations

This is a Tokamak-specific algebraic extension of the reference update, not
a claim that its proof covers Tokamak. Let G and H be the generators of G1
and G2, and let e be their pairing. Retain each final query plus only the
selection summand needed to update it:

- For each retained inverse-delta query J_p, store
  `C_p = [r_j T_p / delta]_1` alongside it. No separate storage of
  `[A_p / delta]_1` is needed: it is J_p - C_p.
- For each retained fixed-public query F_p, store
  `B_p = [r_j T_p]_1` alongside it. Here B_p names a ceremony correction
  point, not the interface polynomial B inside A_p.
- Maintain cumulative `D1 = [delta]_1`, `D2 = [delta]_2` and
  `R_j = [r_j]_2`. D2 is already a final verifier element. D1 and R_j are
  intermediate verification elements. Use one shared delta for all families
  and an independently contributed weight for each retained local-wire row.

The j in p=(i,k,j) is a normalized local-wire coordinate. The implementation
stores retained rows compactly: first the wiring prefix up to the maximum real
wiring length, then the internal range from `m_b` up to `m_b` plus the maximum
real internal length. Let c(j) be the compact index of a retained local wire j.
The stored weight, share and proof at c(j) implement the corresponding r_j;
proof role indices use c(j). Padding rows in `0..m` have no stored weighted
query, cumulative weight or share proof. The selected library, not the
transcript, determines this mapping and the record lengths.

Reconstruct the fixed images `[A_p]_1`, `[T_p]_1` and masking numerators by
group-linear combination of the imported powers and the selected circuit
polynomials. Initialize delta and all r_j to one. This requires no recovery
of tau, xi or psi; the known initializer is not counted as a contribution.
Public-query coordinates still use i=k only for public buffer wires. Retain
the existing omission of implicit-zero witness queries, without omitting
their selection-domain blocks or changing the polynomial domain.

For one participant's nonzero shares u and v_j, publish their encodings in
both source groups and the reference proof of knowledge for each share.
Write `U1=[u]_1`, `U2=[u]_2`, `V1_j=[v_j]_1`, `V2_j=[v_j]_2`.
Only the participant knows u and v_j; cumulative delta and r_j are not inputs
to the update routine.

| Family | Update | Public transition equation |
| --- | --- | --- |
| Inverse-delta selection correction | C'_p = (v_j/u) C_p | e(C'_p, U2) = e(C_p, V2_j) |
| Packed query | J'_p = (J_p + (v_j-1) C_p)/u | e(J'_p-C'_p, U2) = e(J_p-C_p, H) |
| Fixed-public selection correction | B'_p = v_j B_p | e(B'_p, H) = e(B_p, V2_j) |
| Fixed-public query | F'_p = F_p + (v_j-1) B_p | F'_p-B'_p = F_p-B_p |
| Both weighted-helper ranges for j | Q'_j = v_j Q_j | e(Q'_j, H) = e(Q_j, V2_j) |
| Each of eight tag masks and the selection mask | M' = M/u | e(M', U2) = e(M, H) |
| Cumulative role | D1'=u D1; D2'=u D2 | e(D1',H)=e(D1,U2)=e(G,D2') |
| Cumulative wire weight | R'_j=v_j R_j | e(V1_j,R_j)=e(G,R'_j) |

Check e(U1,H)=e(G,U2) and e(V1_j,H)=e(G,V2_j). Reject identity
share and cumulative-role/weight points. Query points themselves may be
identity. Pairing equations do not establish knowledge of a share: each
share must also pass the reference `Verify_dl` operation. Contribution
evidence must identify its previous/current states, circuit snapshot, source
and compact wire-row index; a receipt for another transition or wire must not
be reused.
The record encoding and participant integration are implemented in `phase2_transcript.rs` and `phase2_cli.rs`.
The isolated proof implementation is specified below; it is not supplied by
the algebra model. Do not reuse the old gamma/delta/eta proof
profile or treat a digest chain as a proof of knowledge.

Check initialization against the imported group-linear images. At any later
state, the following give independent final-family consistency equations:

```text
e(J_p-C_p, D2) = e([A_p]_1, H)
e(C_p, D2)     = e([T_p]_1, R_j)
F_p-B_p        = [A_p]_1
e(B_p, H)      = e([T_p]_1, R_j)
e(Q_j, H)     = e(unweighted helper, R_j)
e(M, D2)      = e(mask numerator, H)
```

The free-public interpolation term belongs to A_p. Fixed-public A_p omits
that term. Never use the free-public image for a fixed-public query. Imported
tau/tagged families, ordinary preprocess G1 powers, shifted selection G2
powers and every verifier element other than D2 stay unchanged; validate
their correspondence to the pinned source rather than contributing to them.
The source must also place tau outside all required evaluation domains, as
trusted setup requires; this can be checked through encoded vanishing values.

Finalization copies J_p, F_p, weighted helpers, masks and D2 into their
existing common artifact fields. C_p, B_p, D1, R_j and share evidence belong
only to the ceremony state/transcript, not to the four final RKYV payloads.
Omitting them from those payloads does not erase their public exposure.

`finalize` first re-authenticates the Filecoin original, reconstructs the
library-bound initial state and verifies every contribution record. It requires
at least one verified contribution. The four CRS payloads are accompanied by
`crs_provenance.json`. Its `subcircuitLibrary` and `phase1SourceProvenance`
identify the selected library and pinned Filecoin source;
`ceremonyProtocolVersion`, `ceremonyTranscriptSha256` and
`phase2ContributionCount` bind the verified ceremony;
`compatibleBackendVersion`, `releaseEligible` and the `artifacts` SHA-256 map
define the consumer and publication boundary. `upload` checks this finalized
output and its eligibility. It neither verifies the transcript again nor
derives keys.

## Contribution proof profile

`src/contribution_proof.rs` follows the engineering choices in Filecoin's
[SnapDeals phase 2 revision 934fe8c6d2df2589644302579838976d070c48a7](https://github.com/filecoin-project/filecoin-phase2/blob/934fe8c6d2df2589644302579838976d070c48a7/src/lib.rs)
(`keypair`, `hash_to_g2`, `HashWriter`). It does not implement a Filecoin
receipt or claim byte compatibility with Filecoin's Groth16 transcripts.
Tokamak adds the already-required source/library, state and wire bindings.
No random beacon, new phase 1, SNARK challenge change or release authority
is introduced by this choice.

For each nonzero share u (delta or one wire weight), sample a nonidentity G1
base s and form s_u=u*s. Hash the bound public message with BLAKE2b-512,
seed ChaCha20 with its first 32 bytes, and obtain r in G2 using Filecoin's
point sampler. Publish r_u=u*r alongside s, s_u and the approved U1=uG,
U2=uH. Verify nonidentity subgroup points and the three equations:

```text
e(U1, H) = e(G, U2)
e(s_u, H) = e(s, U2)
e(s_u, r) = e(s, r_u)
```

The first two connect the proof's share to the public transition equations;
the last is the reference-style share-knowledge check. Ratios alone do not
replace it. Whole-ceremony security analysis remains future work.

The BLAKE2b input is the following concatenation, in order:

1. ASCII `TOKAMAK_MPC_PHASE2_SHARE` and the 128 ASCII hex characters of the
   pinned original Filecoin BLAKE2b digest.
2. The UTF-8 library package version (npm for publish, local QAP for
   development), prefixed by its byte length as u64 big endian.
3. Library-content SHA-256, derived-tau SHA-256, previous-record chain SHA-256 and
   next-state SHA-256, each exactly 32 bytes.
4. Role byte 0 for delta, or role byte 1 followed by the compact wire-row
   index as u64 big endian for a wire weight.
5. U1, U2, s and s_u, in that order, as uncompressed big-endian affine
   coordinates: G1 x/y (96 bytes); G2 x.c1/x.c0/y.c1/y.c0 (192 bytes).

The next-state digest excludes the current proof, avoiding a circular hash.
The predecessor digest is the accumulated record chain, including earlier
proofs, not merely the preceding state's point values; otherwise an update
with shares equal to one could replay a receipt.

The transcript starts with the ASCII magic
`TOKAMAK_MPC_PHASE2_TRANSCRIPT_V1` and a zero byte, followed by a one-byte
format version (`1`) and a one-byte npm-version marker. Marker `0` means a
development transcript with no npm version in the header. Marker `1` is
followed by a u16 big-endian byte length and the UTF-8 npm library version
selected at `init`. A 32-byte initialization-context SHA-256 follows. Its
input is the complete preceding header, then the byte-length-prefixed mode
name and actual library version (each length is u64 big endian),
library-content SHA-256, derived-tau SHA-256 and the locally derived initial
state encoding. Even for development, the context binds the actual local QAP
package version; only the npm-version header field is absent. The initial
record-chain digest hashes the full header and initialization-context digest.
Each subsequent chain digest hashes its previous value followed by the
complete state/proof record.

Records encode the six G1 vectors in State field order, nine masks, D1, D2 and wire-weight G2 points, followed by the delta proof and each wire proof. Counts come from the local engine. Points use arkworks canonical uncompressed encoding to avoid square-root decompression; proofs order U1, U2, s, s_u, r_u. Every record is retained and checked. A caller-supplied binding alone is not evidence of source authentication.
These are intermediate transcript encodings, not new final artifact fields;
the final common CRS encoding and SNARK's Keccak transcript are unchanged.

Filecoin pins `rand_chacha 0.3.1` and `blstrs 0.4.1`; that blstrs release
pins `blst 0.3.6`. Its [G2 sampler](https://github.com/filecoin-project/blstrs/blob/v0.4.1/src/g2.rs#L598-L617)
draws 64 message bytes from the RNG and calls `blst_encode_to_g2` with 16
zero DST bytes and 16 zero augmentation bytes. The G1 sampler uses the same
pattern with `blst_encode_to_g1`. This implementation pins ChaCha20 and blst
to those versions and directly invokes those primitives. Resolving the old
blstrs dependency tree failed because its ff/bitvec chain requires yanked
`funty 1.2.0`; using the underlying primitive preserves the selected mapping
without restoring that obsolete dependency tree. The small FFI boundary
converts the resulting affine coordinates into arkworks; it does not
implement its own curve map. Dependency changes must preserve the replay
vectors, not silently alter the ceremony hash profile.

Do not substitute `hash-derived scalar * G2 generator`. The share U2 is
public, so that substitution would allow r_u to be computed as the public
scalar times U2 without knowing u. The negative regression test demonstrates
this failing construction and rejects its evidence under the actual mapper.

Fixed vectors were generated in a separate replay program using Filecoin's
BLAKE2b implementation (`blake2b_simd 0.5.11`), `rand 0.8.4`, ChaCha and
the exact blst calls above. Inputs are the empty string, ASCII
`Filecoin phase 2`, and 1,024 bytes of 0xa5. The production code uses the
existing `blake2 0.8.1`; tests compare both the full digest and all 192 output
bytes with the replay results. This checks integration and byte order against
a reference replay sharing blst, not an independent implementation of the
curve map, an official published vector set or a real contribution.

## Evidence and implementation status

The repository now defines an `mpc` executable with the six operations described
above. `tests/current_phase2_derivation.rs` covers source capacity and the
algebraic update identities. Package tests cover source-format rejection,
share evidence, transcript-chain and state verification, final-key projection,
and publication retry and conflict behavior. These are tests of the implemented
construction; the known test scalars and synthetic source fixtures are not
contributions to a live ceremony.

The development-only native fixture generates keys from a local QAP build,
then exercises native preprocess, prove and verify, including tamper rejection.
It does not authenticate a live Filecoin original and cannot produce a
release-eligible CRS. The [qualification guide](qualification.md) defines the
current test commands and their limits; the
[MPC optimization report](../../../../docs/optimization/current-univariate-mpc.md)
records the measured local E2E. Neither local correctness tests nor a
release-eligibility flag constitute a security proof or independent audit of
the historical Filecoin ceremony.

## Future work: cryptographic security analysis

Analyze the complete exposure from the original Filecoin ceremony, the
separated correction points, cumulative encodings and contribution proofs.
Establish which assumptions and extraction arguments apply to this Tokamak
extension. That analysis is explicitly deferred and does not block current
implementation. Do not report equation tests, native E2E, source-hash
verification, a release-eligibility flag or the Groth16 citation as completing
it. Operational publication and cryptographic assurance remain distinct.
