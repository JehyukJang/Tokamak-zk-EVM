# Current phase 2: construction and trust boundary

## Audience and status

For engineers and cryptographic reviewers of the implemented Filecoin-backed
Tokamak MPC phase 2. This records its construction and trust boundary, not an
executable ceremony specification or a security certification. The
[backend/common artifact contract](../../../../common/contracts/univariate-artifact-contract.json)
defines the final CRS fields; the setup formulas below describe the current
[CRS construction](../../../libs/src/univariate_setup.rs) and
[phase 2 engine](../src/phase2_engine.rs). External security references are
listed in the [MPC security references](security-references.md).

Initialization binds a selected circuit library to independently authenticated
Filecoin powers and derives a deterministic initial state. Each participant
updates that state with secret multiplicative shares and publishes evidence of
the update. Verification reconstructs initialization and checks the complete
contribution chain. Finalization requires at least one verified contribution
and projects the final CRS from the verified state.

The construction exposes additional intermediate group elements whose
Tokamak-specific security analysis remains future work. The
[operator guide](../README.md) defines commands, library selection and upload
requirements; this document explains the algebra and the information that
participants must authenticate and bind.

## Filecoin source mapping

The official [Filecoin ceremony overview](https://github.com/filecoin-project/phase2-attestations#description-of-trusted-setup-phases)
identifies `phase1/challenge_19`. Its upstream implementation is
`arielgabizon/powersoftau` at
`2bd49903bac07485fe23e5ef1a2d5fa19561977b`, also named by the final
participant's [attestation](https://github.com/arielgabizon/perpetualpowersoftau/blob/b6c79904b0e8d535df6410027bc7ed7daf9f441b/0018_GolemFactory_response/README.md).
These are source pins for the derivation, not evidence that the entire
historical ceremony has been independently verified here.

The pinned upstream [ceremony parameters](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/small_bls12_381/mod.rs)
use L = 2^27. Let P be the power capacity derived from the selected library,
as defined [below](#packed-query-update-calculation). Filecoin's alpha-tagged
powers supply xi; its beta-tagged powers supply psi.

| Filecoin family | Available exponents | Tokamak family | Required exponents |
| --- | --- | --- | --- |
| Ordinary G1 powers | 0 through 2L-2 | `[tau^a]_1` | 0 through 2P |
| Alpha-tagged G1 powers | 0 through L-1 | `[xi tau^a]_1` | 0 through P |
| Beta-tagged G1 powers | 0 through L-1 | `[psi tau^a]_1` | 0 through P |
| Ordinary G2 powers | 0 through L-1 | `[tau^a]_2` | 0 through P |
| Beta in G2 | One element | `[psi]_2` | One element |

The upstream [layout implementation](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/batched_accumulator.rs)
orders the file as: 64-byte hash, ordinary G1, ordinary G2, alpha G1, beta
G1, then beta G2. Challenge points are uncompressed. G1/G2 sizes are 96/192
bytes. The total is 576L+160 = 77,309,411,488 bytes. This is the upstream
source size, not the size of the converted Tokamak CRS. The participant derives
P from the selected library and rejects P outside 1 through L-1; no example
package's capacity is a production constant.

The attestation declares the decompressed challenge's BLAKE2b-512 digest:

```text
5a26015ba27d8164152407da8f9b87e47593f17ae4c260e467bac2ba9dda6f66c15fa352487604d1350ef33a3bfedb0d99e37b619161e27545017366274df76b
```

Source authentication checks the entire pinned original, then admits the
required points and power relations. The pinned upstream
[point encoding](https://github.com/matterinc/pairing/blob/c2af46cac3e6ebc8e1e1f37bb993e5e6c7f689d1/src/bls12_381/ec.rs)
defines the source representation. These checks authenticate the selected
Filecoin output; they do not independently verify its historical contribution
chain.

### Participant trust boundary

Each participant independently obtains the original Filecoin source and
checks its complete Filecoin-published pinned digest before accepting incoming
ceremony state or generating a secret contribution. The bytes used to derive
the retained powers must be the bytes authenticated by that check. Circuit
metadata determines P. Initialization and each incoming chain are bound to
the source mode, library version and content, and locally derived tau.
Development and publication inputs have distinct provenance; a development
transcript cannot authorize publication.

A coordinator's converted subset, matching subset digest or receipt cannot
replace original-source authentication. A directly acquired local original
avoids another download, not the full digest check. The share challenge binds
the pinned source digest, the transcript binds the locally derived tau digest,
and final provenance records the source identity. Public relation-check
randomness is not a participant secret share.

## Reference construction and its limit

Use [*Snarky Ceremonies*](https://eprint.iacr.org/2021/219), ePrint 2021/219,
revision dated 2021-09-21 on the ePrint record. Section 5.2, Figure 6
(printed p. 17) gives initialization, specialization and updates; Figure 7
(p. 18) gives SRS verification. Its phase 2 samples a nonzero delta share,
scales role elements forward and
specialized queries inversely, and proves knowledge of the share. Its update
receipt and specialized SRS include delta encodings in both source groups.
Its formal security result concerns its own Groth16 construction and public
view, not arbitrary extra secret parameters in Tokamak queries.

The final CRS contains `[delta]_2` but no separate `[delta]_1` element, as
specified by its [artifact contract](../../../../common/contracts/univariate-artifact-contract.json).
Figure 6's delta receipt exposes the latter encoding; this construction
retains it only in the public intermediate transcript. Its absence from the
final CRS does not remove that exposure. Tokamak's contribution evidence does not
implement Figure 7 unchanged or inherit its security argument. The security
analysis of this Tokamak-specific intermediate view remains future work; the
implementation does not establish a new security theorem.

## Packed-query update calculation

Use additive group notation: `[x]_1 = xG` and `[x]_2 = xH`, where G and H
generate G1 and G2. Let n be the arithmetic row capacity, m_b the
wiring width, t the subcircuit capacity, s the placement capacity and f the
free-public interpolation-domain size. The library fixes the domain sizes and
power shifts:

```text
N_A = n s; N_C = m_b s; N_S = t s
d = max(N_A, N_C) + 1
P = max(2d + 1, N_S + 1, d + 1 + s(t - 1), f - 1)
K = P - d; S = P + 1
```

The [library geometry calculation](../../../libs/src/univariate_crs.rs)
implements these definitions. A retained coordinate p=(i,k,j) identifies
placement i, subcircuit k and normalized local wire j. U_p, V_p and W_p are
that wire's polynomial images of the three arithmetic R1CS matrices (A, B and
C, respectively); B_p is its separate connection image, zero outside wiring
wires. L_(i,k) is the selection-domain Lagrange polynomial at index i+s*k.
The phase 2 scalars delta and r_j are the cumulative role and local-wire
weight, respectively. The images and power shifts are constructed in
[`univariate_setup.rs`](../../../libs/src/univariate_setup.rs). Write

```text
A_p = xi (U_p(tau) + tau^K V_p(tau))
    + psi (W_p(tau) + tau^K B_p(tau))
T_p = tau^S L_(i,k)(tau)
J_p = [(A_p + r_j T_p) / delta]_1
```

Here T_p names the selection factor. For a free public query, include its
public interpolation term I_p(tau) in A_p. Fixed public queries contain
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

This identifies why uniform scaling of each packed query is insufficient. It
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

Each retained normalized local wire j has one cumulative weight and one share
per contribution. The selected library determines the retained set; padding
wires do not receive weights or share evidence. A deterministic mapping binds
each wire to its proof role identifier. The [weighted-query layout](../../../../common/interface/univariate-crs/src/weighted_queries.rs)
defines that mapping, and the [transcript encoding](../src/phase2_transcript.rs)
defines its serialized representation. Storage compaction does not change the
wire's mathematical role or the requirement to bind evidence to that wire.

Reconstruct the fixed images `[A_p]_1`, `[T_p]_1` and masking numerators by
group-linear combination of the imported powers and the selected circuit
polynomials. Initialize delta and all r_j to one. This requires no recovery
of tau, xi or psi; the known initializer is not counted as a contribution.
Public-query coordinates still use i=k only for public buffer wires. Query
storage must preserve the polynomial domains, including the selection-domain
blocks, and the construction's public group elements. The
[nonpublic-query layout](../../../../common/interface/univariate-crs/src/nonpublic_queries.rs)
defines the current sparse representation.

For one participant's nonzero shares u and v_j, publish their encodings in
both source groups and the bound share evidence described below.
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
identity. These transition equations alone do not establish knowledge of a
share: each share must also pass the bound evidence checks in the
[contribution proof profile](#contribution-proof-profile). Contribution
evidence must identify its previous/current states, circuit snapshot, source
and wire role; a receipt for another transition or wire must not be reused.
A digest chain alone is not evidence of share knowledge.

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

Finalization projects J_p, F_p, weighted helpers, masks and D2 into the final
CRS. C_p, B_p, D1, R_j and share evidence belong only to the ceremony
state/transcript, not to the final CRS payloads.
Omitting them from those payloads does not erase their public exposure.

Finalization authenticates the source, reconstructs initialization and verifies
every contribution before producing keys. The output's provenance binds the
library and phase 1 source to the verified ceremony and final payloads. Its
field definitions belong to the
[CRS provenance contract](../../../../common/contracts/crs-provenance-contract.json).
Uploading that completed output is an operational step described in the
[operator guide](../README.md#upload-a-finalized-crs).

## Contribution proof profile

The contribution evidence follows Filecoin's
[SnapDeals phase 2 revision 934fe8c6d2df2589644302579838976d070c48a7](https://github.com/filecoin-project/filecoin-phase2/blob/934fe8c6d2df2589644302579838976d070c48a7/src/lib.rs)
share-evidence construction. Tokamak adds source/library, state and wire
bindings; its evidence is not byte-compatible with Filecoin's Groth16
transcripts.

For each share proof, let u denote the nonzero delta share or one of the wire
shares v_j above. Sample a nonidentity G1 base s and form s_u=u*s. Hash the bound
public message with BLAKE2b-512, seed ChaCha20 with its first 32 bytes, and obtain r
in G2 using Filecoin's point sampler. Publish r_u=u*r alongside s, s_u and the
approved U1=uG, U2=uH. Verify nonidentity subgroup points and the three
equations:

```text
e(U1, H) = e(G, U2)
e(s_u, H) = e(s, U2)
e(s_u, r) = e(s, r_u)
```

The first two connect the share encodings to the public transition equations;
the last checks their relation to the hash-derived point r. Together with the
message binding, these are the implemented share-evidence checks. The
reference paper's proof-of-knowledge result does not automatically establish
the extraction properties of this Tokamak-bound variant. Whole-ceremony
security analysis remains future work.

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

The initialization context binds the source mode, actual library version and
content, derived tau and locally reconstructed initial state. The initial
SHA-256 record-chain digest binds that context and its header. Each subsequent
SHA-256 chain digest hashes its predecessor followed by the complete
state/proof record. Every contribution is retained and checked. The versioned
[transcript encoding](../src/phase2_transcript.rs) defines the context framing,
record ordering and point serialization. Changes to that encoding affect
transcript compatibility even when the update equations remain unchanged.

The curve mapping is fixed by Filecoin's pinned
[G2 sampler](https://github.com/filecoin-project/blstrs/blob/v0.4.1/src/g2.rs#L598-L617):
the seeded ChaCha20 stream supplies 64 message bytes to the G2 encoding map,
with 16 zero DST bytes and 16 zero augmentation bytes. The random G1 base uses
the corresponding G1 map with 64 fresh message bytes and the same DST and
augmentation lengths. A replacement implementation must preserve this mapping
and the challenge bytes, regardless of its dependency versions or API.

Do not substitute `hash-derived scalar * G2 generator`. The share U2 is
public, so that substitution would allow r_u to be computed as the public
scalar times U2 without knowing u. The
[share-evidence tests](../src/contribution_proof_tests.rs) include replay
vectors for the selected mapping and rejection of this substitution. Those
vectors check compatibility with a reference replay; they are not an
independent curve-map implementation or live-ceremony evidence.

## Validation evidence and limits

The [qualification guide](qualification.md) defines correctness tests and their
scope; the
[MPC optimization report](../../../../docs/optimization/current-univariate-mpc.md)
records measured native end-to-end behavior. Synthetic source fixtures and
known test scalars are not contributions to a live ceremony. Local correctness
tests and publication eligibility do not constitute a security proof or an
independent audit of the historical Filecoin ceremony.

## Future work: cryptographic security analysis

The remaining security analysis must account for the complete exposure from
the original Filecoin ceremony, separated correction points, cumulative
encodings and contribution proofs. It must identify the assumptions and
extraction arguments that apply to this Tokamak extension. Equation tests,
native end-to-end tests, source authentication and publication eligibility do
not establish that result. Operational publication and cryptographic assurance
remain distinct.
