# The Tokamak Two-Phase Multi-Party Computation Protocol

## Abstract

Preprocessing succinct non-interactive arguments of knowledge (SNARK) systems
obtain small proofs and efficient verification from a structured reference string
(SRS), but the hidden values used to construct that string must remain unknown.
This document defines the multi-party computation (MPC) implemented by
the Tokamak zk-EVM backend for the setup of Tokamak's SNARK, the construction
proposed in [6]. The design separates circuit-independent setup material from
the material derived for a particular subcircuit library and allows contributors
to update the hidden values in two stages. This document uses SRS for generic
structured setup material and common reference string (CRS) for the output
specific to Tokamak's SNARK.

Tokamak provides two ways to prepare the circuit-independent material. The
native route constructs it through sequential contributions to `alpha`, `x`,
and `y`. The Dusk-backed route verifies and reindexes a completed BLS12-381
powers-of-tau artifact, then adds sequential contributions to the missing `y`
dimension. Both routes expose the same public-data layout and monomial families
to the next computation. After a public computation binds that material to the
canonical subcircuit library, contributors update `gamma`, `delta`, and `eta`.

The implementation verifies source artifacts, contribution equations, data
that a contribution must not change, the canonical subcircuit library, links
between successive states, and final artifacts. Those checks do not prove the
quality of participant randomness or deletion of participant secrets. The
security analyses in [3, 5] require at least one contributor in each phase to
choose an unpredictable secret and erase it. Those analyses do not cover
Tokamak's exact six-parameter construction or the algebraically related
`alpha` and `x` used by the Dusk-backed route, so the security claims below are
limited accordingly.

## 1. Introduction

A succinct non-interactive argument of knowledge (SNARK) allows a prover to
convince a verifier that the prover knows a witness that, together with the
public input, satisfies a circuit relation, with a proof that is small relative
to checking the relation directly. A preprocessing SNARK runs a setup before
proofs are generated and uses the resulting reference string for later proving
and verification. This structure supports small proofs and efficient
verification across repeated uses of the setup. Examples include Pinocchio [30],
Groth16 [1], and later constructions such as Sonic [8] and PLONK [21]; further
examples, including Tokamak's SNARK, appear in [4, 6, 22–29, 31, 32].

Jang and Judd have proposed Tokamak's SNARK [6], which combines Groth16's
arithmetic argument with PLONK's use of a permutation argument [1, 21]. In their
construction, each supported circuit relation is defined by placing and wiring
copies from a subcircuit library committed by the setup, while the proof checks
their internal computation and interconnections. Compared with Groth16, one
common reference string (CRS) therefore supports a specific family of circuit
relations rather than one circuit relation fixed during setup. Compared with
PLONK, verifier preprocessing for a new circuit relation describes only
connections between already committed subcircuits rather than the constraints
and wiring of the entire circuit; the reduction is greatest when the subcircuits
contain substantially more internal computation than interface wiring. This
reduction may also lower the cost for verifiers and users to audit that
preprocessing information.

For preprocessing SNARKs that use secret-dependent structured reference
strings, including Tokamak's SNARK, the setup computes the reference string from
secret values conventionally called trapdoors [1, 2, 6]. In a single-party
setup, the generator must sample those trapdoors as specified and delete every
copy after generating the reference string. If sufficient trapdoor information
is retained or exposed, its holder may be able to generate an accepting proof
for a public input for which no valid witness exists, breaking soundness [2, 20].
A structurally well-formed reference string alone does not show that either
condition was met. Because public verification cannot determine whether the
trapdoors were sampled unpredictably or erased, users must trust the generator
[20].

One way to avoid relying on a single trusted generator is multi-party
computation (MPC), which distributes setup generation across a sequence of
contributors. Each participant uses a private share to update the public data
and publishes evidence that the update is consistent. In the two-phase setup
protocols of [3, 5], the first phase generates material that can be reused for
multiple circuits. After a public computation derives the material for one
circuit, the second phase updates the remaining circuit-dependent parameters.
The security analyses require at least one participant in each phase to use
unpredictable randomness and erase the corresponding share; the phases may have
different contributors.

Related MPC ceremonies have produced public powers-of-tau artifacts, including
the Zcash Powers of Tau, the Dusk extension over BLS12-381, the Ethereum
ceremony for Kate-Zaverucha-Goldberg (KZG) polynomial commitments, and Privacy &
Scaling Explorations' Perpetual Powers of Tau [9–12]. These ceremonies show that
large structured reference strings can be generated and independently checked
by many participants.

In this document, we focus on the MPC implemented by the Tokamak zk-EVM backend
to generate the CRS for Tokamak's SNARK, either independently or by reusing
compatible material from a completed ceremony. Our purpose is to define the
protocol, identify the conditions for such reuse, and make its verification
guarantees and trust assumptions explicit. The scope is limited to CRS
preparation, sequential contributions, verification of contributions and
artifacts, and correspondence with the implementation; it does not analyze the
SNARK protocol itself, provide a formal security proof for Tokamak's exact setup
construction, or claim that public checks establish contributor randomness or
secret erasure.

Completed ceremony artifacts nevertheless cannot generally be used unchanged
by Tokamak's SNARK. The source and target may use different pairing curves, the
published tau sequence may not cover the required degree in both groups, and a
conventional powers-of-tau string does not supply all of the elements required
by the setup of Tokamak's SNARK. Any one of these differences can prevent direct
reuse even when the source ceremony itself is valid.

The problem is therefore to retain the protection supplied by a compatible
completed ceremony where possible while constructing the additional elements
required by Tokamak's SNARK without publishing the missing hidden values. The
same protocol must also support independent generation when no external
ceremony is used.

Tokamak addresses the problem with a native route and a Dusk-backed route. The
native route constructs all circuit-independent material through Tokamak
contributions. The Dusk-backed route verifies and adapts a compatible Dusk
ceremony result before contributors add the missing `y` dimension. In both
routes, the first phase exposes the same public-data layout and monomial
families, a deterministic public computation binds that material to the
canonical subcircuit library, and the second phase updates the remaining
parameters. The final CRS is bound to the verified record of those steps.

## 2. Background

### 2.1 Structured setup and powers of tau

This document uses SRS for structured setup material in the general protocols
and ceremonies discussed below, and CRS for the setup output specific to
Tokamak's SNARK.
Let `G1` and `G2` be prime-order groups with a non-degenerate bilinear pairing,
and write `[z]_1` and `[z]_2` for encodings of scalar expression `z` in `G1`
and `G2`, respectively.
Powers-of-tau ceremonies publish sequences such as
`[1], [tau], [tau^2], ...` without publishing `tau`. A contributor with secret
share `r` transforms the sequence so that its hidden scalar becomes `tau*r`,
and pairing relations make consistent updates publicly checkable [2, 3]. These
sequences underlie KZG polynomial commitments and several SNARK setup systems
[7].

In the construction of Bowe, Gabizon, and Miers, the output of the first phase
can be reused up to a degree bound. A public computation combines it with a
circuit description, after which contributors in the second phase update the
remaining terms that depend on hidden values [3]. *Snarky Ceremonies* analyzes
the update and verification algorithms for both phases and requires an honest
update in each [5]. Tokamak follows this order but does not claim an identical
SRS construction.

### 2.2 Setup of Tokamak's SNARK

Tokamak's SNARK for arithmetic constraints is based on Groth's 2016
pairing-based SNARK, commonly called Groth16 [1, 6]. Its setup samples

```text
(alpha, x, y, gamma, delta, eta)
```

and encodes expressions needed to commit a subcircuit library, placement in a
`y` domain, wire polynomials in `x`, and the proof system's public,
intermediate, private, and vanishing-polynomial relations [6]. The implementation
retains those meanings. In particular, `gamma`, `delta`, and `eta` are scalars
with both direct encodings and circuit-dependent elements divided by the
corresponding scalar; they are not “inverse-only” parameters.

The paper proves knowledge soundness when its setup algorithm samples the
trapdoors, using the generic group model [6]. Knowledge soundness means,
informally, that producing an accepting proof requires knowledge of a valid
witness. The paper does not specify or prove the Tokamak MPC. This distinction
limits the security claims made in this document.

## 3. System Model and Notation

Tokamak follows the order described in [3, 5]: contributions before circuit
specialization, public specialization, and contributions after specialization.
When comparing the protocol with that literature, this document calls the two
contribution periods the first and second phases. The serialized implementation
uses a slightly different boundary: `Phase 1` contains the first contribution
period, while `Phase 2` begins with deterministic circuit preparation and
continues through the second contribution period. The native and Dusk-backed
routes differ before and during `Phase 1`, but expose the same public-data layout
and accessors to `Phase 2`. Both then use the same circuit-preparation and
contribution implementation. This comparison does not assert that Tokamak has
the same SRS or inherits the security proofs in [3, 5].

### 3.1 Roles and verification responsibilities

The roles correspond to the coordinator, participant, and public verifier used
by prior ceremonies [3, 5, 11]. The **operator** schedules deterministic
transformations and passes states between contributors. A **contributor** applies
a private multiplicative share. A **verifier** checks sources, transitions,
selection, and the ordered ceremony record, called the transcript. Downstream
proving and verification tools consume the final CRS for Tokamak's SNARK and its
recorded origin. The final CRS commits the canonical subcircuit library from
which later circuits are derived. The Dusk ceremony is an external SRS source
rather than a Tokamak participant.

An operator controls the workflow and can censor a contributor, delay a
ceremony, or withhold an artifact, but cannot make an inconsistent transition
satisfy the implemented public checks. Conversely, those checks cannot establish
that a contributor used unpredictable randomness, kept it private, or erased
it. Contributor names and device metadata do not make a contribution valid.

### 3.2 Algebraic setting and notation

The circuit-independent setup material contains the required G1 and G2
encodings of the following pure and mixed monomials:

```text
[alpha^k], [x^a], [y^b],
[alpha^k x^a], [alpha^k y^b], [x^a y^b],
[alpha^k x^a y^b].
```

The index ranges are those required by the CRS for Tokamak's SNARK and the
monomial layout specified by the implementation contract. Not every group
contains every monomial. The detailed ranges and serialized order remain in
that contract [14].

A participant's share for scalar `z` is written `r_z`. Sequential contributions
replace `z` by `z * product_i r_z,i`. Public group elements are updated directly;
the scalar is never serialized. Circuit specialization is the deterministic
group computation that combines the selected `Phase 1` output with the
canonical subcircuit-library description to construct circuit-dependent group
elements. It fixes that library, not one circuit later derived from the library.

### 3.3 Setup parameters and stages

The division shown below follows the order in [3, 5]; the assignment of the six
parameters follows the CRS defined in [6] and the implementation [14].

| Parameter | Role in the setup of Tokamak's SNARK | Tokamak stage | Participant procedure | Security assumption |
|---|---|---|---|---|
| `alpha` | Powers mixed with wire and correction encodings | Native `Phase 1`, or Dusk-derived encodings involving `alpha` and `x` | A native contributor erases its `alpha` share after contributing; the Dusk adaptor creates no new `alpha` share | At least one native `alpha` share, or one source share protecting Dusk scalar `t`, was unpredictable, remained undisclosed, and was erased |
| `x` | Evaluation dimension for subcircuit and wire polynomials | Native `Phase 1`, or Dusk-derived encodings involving `alpha` and `x` | A native contributor erases its `x` share after contributing; the Dusk adaptor creates no new `x` share | The corresponding native or Dusk-source condition stated for `alpha` holds |
| `y` | Placement dimension and bivariate mixing | `Phase 1` on both routes | Each contributor erases its `y` share after completing the contribution | At least one accepted `y` share was unpredictable, remained undisclosed, and was erased |
| `gamma` | Direct encodings and public-instance elements divided by `gamma` | `Phase 2` | Each contributor erases its `gamma` share after completing the contribution | At least one accepted `gamma` share was unpredictable, remained undisclosed, and was erased |
| `delta` | Direct encodings and private and correction elements divided by `delta` | `Phase 2` | Each contributor erases its `delta` share after completing the contribution | At least one accepted `delta` share was unpredictable, remained undisclosed, and was erased |
| `eta` | Direct encodings and intermediate elements divided by `eta` | `Phase 2` | Each contributor erases its `eta` share after completing the contribution | At least one accepted `eta` share was unpredictable, remained undisclosed, and was erased |

`Phase 1` finishes the circuit-independent monomial encodings. `Phase 2`
preparation is the first step that reads the concrete rank-1 constraint system
(R1CS) and quadratic arithmetic program (QAP) coefficients and binds the
canonical digest of the subcircuit library. Contributions in `Phase 2` then
update only the three scalars used by the circuit-dependent elements. Reading
only the degree and placement limits before this point does not fix the
subcircuit library.

### 3.4 Ceremony states and contributions

Each accepted contribution is sequential: it is proved against one preceding
state, yields one successor, and is recorded in order. The implementation stores
each set of public data and its metadata as an immutable state. The next
contribution includes the canonical digest of that state, which links the two
states and allows verification to resume from the last accepted state. The
public metadata and proof for an accepted contribution are stored in a receipt.

A phase output can be selected only after its complete chain verifies and
contains at least one receipt marked `random` or `hybrid`, the two implementation
labels accepted by the selection policy. This requirement does not establish
that the contribution used unpredictable secret randomness or that its share was
erased. An update derived only from a public deterministic value may be checked
and recorded, but does not satisfy the selection requirement or supply an
unknown share. Updates made only for testing also cannot satisfy the requirement.
Selection designates one verified final state as the input to the next stage and
records its digest; it adds no signer or secret.

### 3.5 Security assumptions and properties

The conventional ceremony goal is that at least one independently unpredictable
share affecting each protected parameter remains unknown and is erased [3, 5].
Tokamak permits one contributor and permits the same person in both phases. Such
an execution can leave an unknown share in each parameter, but it has no
redundancy against that person's compromise or failure to erase the shares.
Using multiple independent contributors provides that redundancy; it is not a
condition that the verifier can establish from participant identities.

The implementation directly checks source artifacts, subcircuit-library
binding, contribution equations, links between states, transcripts, and final
artifact digests. Security additionally depends on unpredictable secrets,
non-disclosure, erasure, discrete logarithm hardness, and the external ceremony.
References [3, 5] do not prove knowledge soundness for this exact MPC, and the
analysis in [6] does not cover the parameter mapping used by the Dusk-backed
setup.

## 4. Requirements for Reusing Existing Ceremony Results

An existing powers-of-tau result can be used only when it employs the target
groups, supplies both group sequences through every exponent consumed by the
public transformation, and contains enough information to derive the required
elements. These requirements follow directly from the source specifications
[3, 7, 9–12].

For the current tracked setup, the public-wire count is `l=396`, the
interface-wire count is `l_D=1420`, the number of constraints per subcircuit is
`n=1024`, and the maximum placement count is `s=s_max=256`. The resulting
intermediate-wire count is `m_i=l_D-l=1024`, and `N=max(n,m_i)=1024` [15]. The
checked Dusk mapping requires source G1 exponents through 10,240 and G2
exponents through 8,192 [14].
These are formula-derived repository values, not performance measurements.

| Public artifact | Curve | Published capacity relevant here | Practical conclusion |
|---|---|---|---|
| Privacy & Scaling Explorations' Perpetual Powers of Tau [12] | BN254 | Up to `2^28` constraints and `2 * 2^28 - 1` powers | Degree is ample, but the curve is incompatible. |
| Ethereum KZG ceremony [11] | BLS12-381 | Largest sequence ends at G1 exponent `2^15-1`; every G2 sequence ends at exponent 64 | The curve and G1 capacity fit, but the G2 sequence is too short for the current mapping. |
| Dusk trusted setup [9] | BLS12-381 | Documents powers through `2^21`, extending the verified Zcash result with 15 listed contributions | The pinned artifact supplies the curve and degree required as input. |

Curve mismatch prevents reuse because encodings cannot be transferred between
different prime-order pairing groups. Degree must be checked independently in
G1 and G2: a long G1 sequence does not compensate for missing G2 powers. The
Dusk range covers the current checked bounds, whereas the Ethereum G2 sequence
does not.

Capacity alone is insufficient. A conventional powers-of-tau string provides
univariate encodings of one hidden scalar. The setup of Tokamak's SNARK requires
several hidden scalars, mixed `x`/`y` monomials, and circuit-dependent families
[6]. Public linear combinations can derive encodings from available powers, but
cannot manufacture an independent missing secret.

The selected Dusk result is therefore usable only as input to the Tokamak
transformation. Its published sequence and ceremony records identify the source
and support verification of its powers. The secrecy of the Dusk scalar still
depends on at least one Dusk or Zcash contributor having kept and erased an
unpredictable share. Tokamak derives `x=t` and `alpha=t^(2N)` from that same
scalar `t`; this relationship differs from the independent sampling used by
the setup in [6]. The security analyses in [3, 5, 6] do not cover this mapping.
The source also contains no Tokamak contribution to `y`, `gamma`, `delta`, or
`eta`, so both Tokamak phases remain necessary.

## 5. Protocol Overview

### 5.1 Route preparation

The native route initializes every encoding required before circuit
specialization at conceptual `alpha=x=y=1`. The Dusk-backed route authenticates
and verifies the pinned powers-of-tau artifact, reindexes its powers into the
required encodings involving `alpha` and `x`, and expands the encodings that
involve `y` at conceptual `y=1`. These deterministic preparation operations do
not add a participant's secret randomness.

### 5.2 The first phase

Native contributors in the first phase update `alpha`, `x`, and `y` and every
affected mixed monomial. Dusk-backed contributors update `y` and every encoding
that contains it while leaving the adapted `alpha` and `x` elements unchanged.
Selection on each route requires at least one receipt marked `random` or
`hybrid`. Security separately assumes that at least one accepted share was
unpredictable, remained undisclosed, and was erased. Both routes expose the same
required monomial families through the same public-data interface, so the
subsequent computation is identical even though the group-element values depend
on the accepted contributions.

### 5.3 Circuit specialization and the second phase

Public deterministic specialization binds the canonical subcircuit library by
forming public linear combinations of the group elements produced in the first
phase; it never recovers `alpha`, `x`, or `y`. It initializes direct encodings
of `gamma`, `delta`, and `eta` and
the circuit-dependent elements that will be divided by those scalars.
Contributors in the second phase multiply the direct encodings by their shares
and the divided elements by the inverse shares. The selected result is converted
to the unchanged CRS layout of Tokamak's SNARK.

### 5.4 What verification establishes

Proofs, pairing equations, checks that fixed elements remain unchanged,
canonical digests, and the complete transcript establish that an accepted final
artifact follows the recorded source, layout, canonical subcircuit library, and
contribution sequence. The checks do not establish secret deletion. If every
share protecting one phase is known, the requirement that at least one
contributor kept and erased an unpredictable share is not satisfied. The
security proofs in [3, 5] then do not apply to that execution. This does not
invalidate evidence that the public computations were performed consistently or
by itself disclose the scalars updated in the other phase.

### 5.5 Comparison with prior two-phase protocols

| Prior protocols [3, 5] | Tokamak implementation | Comparison |
|---|---|---|
| Circuit-independent setup in the first phase | `Phase 1` constructs the required `alpha`, `x`, and `y` monomials | The order is the same, but the parameters and group elements differ. |
| Public specialization to one circuit | Deterministic specialization from selected `Phase 1` points and the canonical subcircuit-library QAP/R1CS description | The public computation has the same role, but Tokamak fixes a reusable subcircuit library rather than one later-derived circuit. |
| Circuit-dependent updates in the second phase | `Phase 2` updates direct and divided elements involving `gamma`, `delta`, and `eta` | The purpose is the same, but Tokamak uses different parameters and equations. |
| Sequential updates and public verification | Proofs of the contributor's shares, pairing checks, checks that fixed elements did not change, and verification of the complete sequence | The verification purpose is the same; Tokamak defines its own stored states and receipts. |
| At least one honest contribution in each phase | Selection requires a `random` or `hybrid` receipt in each Tokamak phase; security additionally assumes an unpredictable, undisclosed, and erased share in each phase, and a corresponding Dusk or Zcash source share for Dusk-derived `alpha` and `x` | The trust structure is analogous at a high level, but the verifier cannot establish these secrecy assumptions and the proofs in [3, 5] do not cover Tokamak's exact construction. |
| One method for producing the first-phase input | Native initialization or a verified and reindexed Dusk artifact | Tokamak adds two input paths and public reindexing. |

In both Tokamak routes, the verified output of the first phase is specialized to
the canonical subcircuit library, only the remaining hidden parameters are
updated in the second phase, and the final CRS is derived from the selected
states. The implementation checks the public computations and stored data. Its
security still depends on secret erasure and is limited by the proof gaps stated
above.

## 6. Route Preparation

### 6.1 Native initialization

Native initialization constructs the complete monomial layout with each hidden
scalar conceptually equal to one. The resulting initial state contains no
participant randomness and cannot be selected. Its purpose is to give the first
contributor a well-formed input whose pure and mixed elements can all be updated
and checked.

### 6.2 Dusk adaptation

Let `t` be the hidden scalar behind the pinned Dusk sequence and
`N=max(n,m_i)`. Mapping version 1 uses

```text
x                 = t
alpha             = t^(2N)
alpha^k x^a       = t^(2Nk+a)
```

for the checked exponent ranges. The implementation calls this transformation
the Dusk adaptor. Before applying the public index map, the adaptor validates the
exact source digest and encoding, the standard group generators, the required
G1 and G2 ranges, and the pairing equations between consecutive powers. It
consumes only the Dusk tau sequences, not Dusk's Groth16 alpha or beta elements.

The adapted output is not a Tokamak ceremony state and has no Tokamak
contribution receipt. Dusk-backed preparation adds the required elements
containing powers of `y`, initially with `y=1`. This state also cannot be
selected until a Tokamak contributor changes those elements.

## 7. The First Phase: Contributions Before Circuit Specialization

For native contribution `i`, the contributor samples independent nonzero shares
`r_alpha,i`, `r_x,i`, and `r_y,i`. Every point is multiplied by the powers
implied by its monomial. Representative updates are

```text
[alpha^k]             <- r_alpha,i^k [alpha^k]
[x^a y^b]             <- r_x,i^a r_y,i^b [x^a y^b]
[alpha^k x^a y^b]     <- r_alpha,i^k r_x,i^a r_y,i^b
                          [alpha^k x^a y^b].
```

After accepted native contributions, each hidden scalar is the product of its
corresponding shares. Pure powers, products involving multiple scalars, and the
elements at the edges of the required exponent ranges are checked together so
that a participant cannot update one dependent element while leaving another
inconsistent.

For Dusk-backed contribution `i`, the only new share is `r_y,i`. Every monomial
with exponent `b` in `y` is multiplied by `r_y,i^b`; all elements containing
only `alpha` and `x` must remain byte-for-byte unchanged. The implementation
rejects a contributed state whose `y^s` encoding still equals its initial value.
The scalar `y` is neither generated by an operator nor disclosed in a state.

The selected state from the first phase must terminate a complete verified chain
and include at least one receipt marked `random` or `hybrid`. Native and
Dusk-backed states then provide the same required monomial families through the
same interface to the specialization computation, while their group-element
values and the final record retain the effects and origin of the accepted
contributions.

## 8. Circuit Specialization and the Second Phase

Given the selected points from the first phase and the canonical subcircuit-
library description, deterministic specialization constructs circuit-dependent
encodings by linear group operations. For a wire polynomial `o_j(X)`, the
polynomial `K_j(X)` from the intermediate-wire construction in [6], and a
Lagrange polynomial `L_i(Y)` over the placement variable, representative
identities are

```text
[L_i(y)o_j(x)]_1
  = sum_(a,b) l_(i,b)o_(j,a)[x^a y^b]_1,

[L_i(y)alpha^4 K_j(x)]_1
  = sum_(a,b) l_(i,b)k_(j,a)[alpha^4 x^a y^b]_1,

[alpha^k y^i(y^s-1)]_1
  = [alpha^k y^(i+s)]_1 - [alpha^k y^i]_1.
```

Because all coefficients are public, these computations need no scalar
trapdoor. The initial state for contributions in the second phase binds the
digest of the selected first-phase state and the canonical digest of the
subcircuit library. It initializes direct encodings at
`gamma=delta=eta=1` and leaves the circuit-dependent elements that contain
their inverses unscaled.

Each contributor in the second phase samples independent nonzero shares
`r_gamma,i`, `r_delta,i`, and `r_eta,i`. A direct encoding `[z]` is multiplied
by `r_z,i`, while every encoding of the form `[F/z]` is multiplied by
`r_z,i^-1`. Elements fixed in the first phase or by circuit specialization must
not change. After the sequence, each hidden scalar updated in the second phase
is the product of its accepted shares.

## 9. Verification, Transcript, and Final CRS

Each secret share has public G1 and G2 encodings and a proof, bound to the
transcript, that the contributor knows the share. Direct checks tie the first
powers to those encodings. Batched pairing equations check the remaining powers
and elements that contain multiple scalars. The Dusk-backed check also verifies
that every element containing only `alpha` and `x` remains unchanged. The
second-phase check verifies both direct multiplication by a share and
multiplication by its inverse where required.

Each proof is bound to the protocol and contract versions, ceremony identifier,
phase, required parameter updates, sequence number, previous and new state
digests, capacity and layout identifiers, the subcircuit-library digest when
present, and the parameter label. These bindings prevent an otherwise valid
proof from being replayed for another state, route, phase, parameter set, or
subcircuit library.

The workspace stores immutable states under digests of their contents and
re-verifies every transition and the selected output of each phase when it
reloads them. Its index does not determine whether a state is valid. The
transcript records the selected sequence from each phase, receipt digests, each
contribution's recorded randomness label, the number of `random` or `hybrid`
receipts, the source artifact, and the canonical subcircuit library.
Finalization reconstructs that transcript, accepts only a selected second-phase
state with a `random` or `hybrid` receipt, and records the SHA-256 digests of the
transcript and final artifacts [14].

Hashes and pairing checks establish integrity within their assumptions. They do
not show that a participant's local entropy was unpredictable, that no copy of a
share exists, or that an artifact will remain available.

## 10. Trust and Security Analysis

### 10.1 What an honest contribution provides

At the algebraic level, a product remains unknown to observers who know every
other factor when at least one nonzero factor is independently unpredictable and
not disclosed, assuming discrete logarithms remain hard. This is the purpose of
sequential contribution. The stronger statement that this condition proves
knowledge soundness for the exact combination of Tokamak's SNARK and this MPC is
not available: the proofs in [3, 5] apply to the constructions specified in
those papers, and the analysis in [6] begins with a CRS generated from six
independently sampled secrets.

One contributor in a phase can supply its unknown factors if that person uses
unpredictable randomness, discloses nothing, and erases every share. Multiple
contributors provide redundancy against compromise. The same person may
contribute to both phases and leave an unknown share in both, but compromise or
failed erasure by that person can remove this protection from both phases.

### 10.2 Effect of disclosed parameters

| Protected values | Required secrecy | What current evidence supports if the values are exposed |
|---|---|---|
| Native `alpha`, `x`, `y` | At least one corresponding share from the native first phase remains unknown and was erased | The affected scalar is known and the independent-sampling assumption in [6] no longer applies to encodings that use it. Exposure of one scalar is not shown to reveal the others. |
| Dusk-backed `alpha`, `x` | At least one Dusk or Zcash source share remains unknown and was erased | Exposure of source `t` reveals both `x=t` and `alpha=t^(2N)`. Even without exposure, this related pair is not proved to have the same security as independent sampling. |
| Dusk-backed `y` | At least one Tokamak share for `y` remains unknown and was erased | Exposure reveals `y` but does not by itself reveal Dusk `t`. The source ceremony never replaces this contribution. |
| `gamma`, `delta`, `eta` | At least one corresponding share from the second phase remains unknown and was erased | The affected scalar is known and the CRS no longer satisfies the independent-sampling assumption in [6]. The literature does not prove the exact forgery consequence of exposing each parameter separately. |

Disclosure of `gamma`, `delta`, and `eta` does not compute `alpha`, `x`, or `y`
through the implemented update and does not change whether the source,
subcircuit library, transitions, transcript, or artifact digests verify. It does
mean that the second phase no longer contains an unknown contribution. The
security proofs in [3, 5] and the analysis in [6] of a setup with six hidden
scalars therefore cannot be applied to that CRS. Current evidence does not
justify saying either that such disclosure is harmless or that it automatically
compromises every property of the CRS.

### 10.3 Malicious behavior and operational limits

The implementation detects malformed points, inconsistent powers, partial
updates, multiplication in the wrong direction, replay for a different type of
contribution, changes to fixed elements, replacement of the source or
subcircuit library, and changes to accepted artifacts. A successfully verified
transcript is evidence that those public equations and identifiers are
consistent.

A contributor can still choose predictable nonzero randomness or retain a
secret. An operator can censor, delay, withhold, or choose among otherwise valid
chains that contain a `random` or `hybrid` receipt. Contributors and the operator
can collude. Identity metadata, the receipt label, and algebraic checks cannot
disprove these actions. If a coalition learns every share protecting a phase,
that phase has no unknown contribution.

Verifying the Dusk source artifact does not establish that its hidden scalar
remains unknown. The adaptor checks the pinned artifact and its powers, while
secrecy of the scalar depends on the Zcash and Dusk ceremonies and at least one
source contributor's non-disclosure and erasure [9, 10].

## 11. Limitations

References [3, 5, 6] do not provide a formal reduction showing that the Tokamak
contribution equations produce the exact setup distribution required by the
knowledge-soundness analysis in [6]. The largest explicit gap is the Dusk
mapping: `alpha=t^(2N)` and `x=t` are algebraically related, whereas the setup in
[6] samples them independently. The mapping provides and verifies all powers
through the required finite degree, but those facts do not show that its
parameters have the same distribution as independent samples.

References [3, 5, 6] also do not isolate the precise forgery power gained by
learning only one of `alpha`, `x`, `y`, `gamma`, `delta`, or `eta` in Tokamak's
SNARK. This document therefore reports which assumption about hidden values
fails and which public checks still pass. It does not claim a specific attack or
claim that any remaining security property is preserved.

Tokamak requires at least one `random` or `hybrid` receipt in each phase before
selection. Security separately assumes that at least one accepted share in each
phase was unpredictable, remained undisclosed, and was erased. The protocol does
not require multiple identities, independent organizations, hardware isolation,
or public attestations. The native route is implemented and algebraically
validated, but the current release policy permits only artifacts produced
through the Dusk-backed route [14]. That policy is not a comparative security
proof.

Finally, storing data under SHA-256 digests of its contents, using a specified
byte encoding, checking pairing equations, and rechecking the transcript all
depend on correct cryptographic primitives and implementation. They protect the
integrity and recorded origin of the artifacts, not confidentiality, erasure,
fairness, censorship resistance, or long-term availability.

## 12. Implementation Correspondence

The protocol is identified as `tokamak-mpc-2phase-v1`. The implementation uses
`Phase 1` and `Phase 2` as serialized phase identifiers. `Phase 2` covers both
deterministic circuit preparation and the contribution period that follows it.
The implementation records the parameters that each contribution must update as
a contribution profile: `NativeAlphaXY` for native `Phase 1`, `DuskY` for
Dusk-backed `Phase 1`, and `CircuitGammaDeltaEta` for the shared `Phase 2`.
Both first-phase routes produce the same `UniversalTau` data structure, and both
call the same specialization and second-phase contribution implementation [14].

The participant follows the same steps for every contribution profile: verify
the previous state, display the phase and required parameter updates, generate
randomness, apply the update, create proofs, verify the result locally, erase
temporary share material, and emit an immutable state and receipt [16].
Preparation steps do not create participant secrets or receipts. If deterministic
specialization is interrupted, it is rerun from the last verified and selected
first-phase state instead of being resumed from an unverified partial result.

Finalization converts the selected second-phase state into the existing data
structure for Tokamak's SNARK and produces exactly four top-level files: the
combined CRS, preprocessing CRS, verifier CRS, and a provenance document that
records the source and processing history. The complete ceremony states and
receipts remain in a separate collection with the transcript; the provenance
document records the digest of that transcript. The implementation contract and
operator guide, rather than this abstract publication, specify the commands and
byte-level formats [14, 16].

## 13. Related Work

The Pinocchio MPC provided an early practical sequential ceremony for
circuit-specific SNARK parameters [2]. Bowe, Gabizon, and Miers then separated a
scalable powers-of-tau phase from circuit specialization and a second update
phase [3]. *Snarky Ceremonies* gives a general framework for update and
verification algorithms before and after circuit specialization and analyzes
security against malicious setup algorithms when each phase has at least one
honest contribution [5]. These works provide the closest prior constructions
and security analyses for comparison with Tokamak.

Other work designs a CRS that supports a class of circuits and can be updated
after its initial generation; these properties are called universal and
updatable [4]. Sonic is a practical SNARK with both properties [8]. Tokamak's
SNARK instead commits a subcircuit library and supports circuits derived from
that library, while [6] explicitly does not provide an updatable setup. Tokamak's
MPC is a setup procedure for that existing CRS structure. It does not change the
proof system into Sonic or another universal and updatable SNARK.

Completed ceremonies differ in how they were organized. Zcash produced a
reusable BLS12-381 result from 87 participant contributions and a final beacon
[10]. Dusk started from the verified 87th Zcash contribution, before that final
beacon, and added 15 contributions [9]. Filecoin reused BLS12-381 output from a
first phase and ran circuit-specific ceremonies for the second phase [13].
Ethereum generated four BLS12-381 KZG sequences through a public sequencer [11], while
Privacy & Scaling Explorations' Perpetual Powers of Tau targets a much larger
BN254 degree [12]. More recent research explores decentralized, asynchronous,
and lower-cost powers-of-tau execution [17–19]. These works improve participation
and ceremony operation; they do not by themselves supply the parameters required
by the setup of Tokamak's SNARK or resolve the curve and degree differences
described in Section 4.

## 14. Conclusion

Tokamak implements a two-phase MPC for Tokamak's SNARK with two input routes.
The native route contributes `alpha`, `x`, and `y`; the Dusk-backed route
verifies and reindexes an external BLS12-381 powers-of-tau sequence before
contributors add the missing `y`. Both routes expose the same public-data layout
and required monomial families before deterministic specialization to the
canonical subcircuit library, and use the same second phase for contributions to
`gamma`, `delta`, and `eta`.

The implementation provides independently repeatable evidence about the source
artifact, contribution equations, the canonical subcircuit library, links between
states, and final artifacts. Security still requires at least one unpredictable
share in each phase to remain unknown and be erased. Failure of that condition
means that the security proofs in [3, 5] do not apply, but it does not invalidate
verification of unrelated public data or automatically reveal every other
trapdoor.

The remaining cryptographic research question is formal rather than operational:
prove the exact six-parameter MPC for Tokamak's SNARK, including the Dusk-backed
relationship between `alpha` and `x`, or replace it with a construction covered
by such a proof. Until then, the protocol should be evaluated through the
explicit integrity guarantees, trust assumptions, and limitations stated here
rather than by assuming that an existing ceremony proof applies unchanged.

## 15. References

1. Jens Groth, [*On the Size of Pairing-Based Non-interactive Arguments*](https://doi.org/10.1007/978-3-662-49896-5_11), EUROCRYPT 2016.
2. Sean Bowe, Ariel Gabizon, and Matthew Green, [*A Multi-party Protocol for Constructing the Public Parameters of the Pinocchio zk-SNARK*](https://doi.org/10.1007/978-3-662-58820-8_5), Financial Cryptography Workshops 2018 proceedings.
3. Sean Bowe, Ariel Gabizon, and Ian Miers, [*Scalable Multi-party Computation for zk-SNARK Parameters in the Random Beacon Model*](https://eprint.iacr.org/2017/1050), IACR ePrint 2017/1050.
4. Jens Groth, Markulf Kohlweiss, Mary Maller, Sarah Meiklejohn, and Ian Miers, [*Updatable and Universal Common Reference Strings with Applications to zk-SNARKs*](https://doi.org/10.1007/978-3-319-96878-0_24), CRYPTO 2018.
5. Markulf Kohlweiss, Mary Maller, Janno Siim, and Mikhail Volkhov, [*Snarky Ceremonies*](https://doi.org/10.1007/978-3-030-92078-4_4), ASIACRYPT 2021.
6. Jehyuk Jang and Jamie Judd, [*An Efficient SNARK for Field-Programmable and RAM Circuits*](https://eprint.iacr.org/2024/507), IACR ePrint 2024/507, revised 2025.
7. Aniket Kate, Gregory M. Zaverucha, and Ian Goldberg, [*Constant-Size Commitments to Polynomials and Their Applications*](https://doi.org/10.1007/978-3-642-17373-8_11), ASIACRYPT 2010.
8. Mary Maller, Sean Bowe, Markulf Kohlweiss, and Sarah Meiklejohn, [*Sonic: Zero-Knowledge SNARKs from Linear-Size Universal and Updateable Structured Reference Strings*](https://doi.org/10.1145/3319535.3339817), ACM CCS 2019.
9. Dusk Network, [*Trusted setup for BLS12-381*](https://github.com/dusk-network/trusted-setup), official ceremony repository.
10. Zcash Foundation, [*Powers of Tau attestations*](https://github.com/ZcashFoundation/powersoftau-attestations), official ceremony repository.
11. Ethereum Foundation, [*KZG Powers of Tau ceremony specifications*](https://github.com/ethereum/kzg-ceremony-specs) and [public transcript](https://github.com/ethereum/kzg-ceremony), official repositories.
12. Privacy & Scaling Explorations, [*Perpetual Powers of Tau*](https://github.com/privacy-ethereum/perpetualpowersoftau), official ceremony repository.
13. Filecoin Project, [*Phase 2 attestations*](https://github.com/filecoin-project/phase2-attestations), official ceremony repository.
14. Tokamak zk-EVM, [*Two-Phase MPC Protocol Contract*](../../rust/setup/mpc-setup/docs/phase2-output-contract.md), normative implementation contract.
15. Tokamak zk-EVM, [tracked setup parameters](../../../frontend/qap-compiler/subcircuits/library/setupParams.json), repository record.
16. Tokamak zk-EVM, [*MPC Setup Guide*](../../rust/setup/mpc-setup/README.md), participant and operator guide.
17. Valeria Nikolaenko, Sam Ragsdale, Joseph Bonneau, and Dan Boneh, [*Powers-of-Tau to the People: Decentralizing Setup Ceremonies*](https://doi.org/10.1007/978-3-031-54776-8_5), ACNS 2024.
18. Sourav Das, Zhuolun Xiang, and Ling Ren, [*Powers of Tau in Asynchrony*](https://doi.org/10.14722/ndss.2024.24733), NDSS 2024.
19. Lucien K. L. Ng, Pedro Moreno-Sanchez, Mohsen Minaei, Panagiotis Chatzigiannis, Adithya Bhat, and Duc V. Le, [*Lite-PoT: Practical Powers-of-Tau Setup Ceremony*](https://doi.org/10.1145/3719027.3765182), ACM CCS 2025.
20. Faxing Wang, Shaanan Cohney, and Joseph Bonneau, [*SoK: Trusted Setups for Powers-of-Tau Strings*](https://doi.org/10.1007/978-3-032-07024-1_12), presented at Financial Cryptography 2025 and published in its proceedings.
21. Ariel Gabizon, Zachary J. Williamson, and Oana Ciobotaru, [*PLONK: Permutations over Lagrange-bases for Oecumenical Noninteractive Arguments of Knowledge*](https://eprint.iacr.org/2019/953), IACR ePrint 2019/953.
22. Matteo Campanelli, Dario Fiore, and Anaïs Querol, [*LegoSNARK: Modular Design and Composition of Succinct Zero-Knowledge Proofs*](https://doi.org/10.1145/3319535.3339820), ACM CCS 2019.
23. Alessandro Chiesa, Yuncong Hu, Mary Maller, Pratyush Mishra, Psi Vesely, and Nicholas P. Ward, [*Marlin: Preprocessing zkSNARKs with Universal and Updatable SRS*](https://doi.org/10.1007/978-3-030-45721-1_26), EUROCRYPT 2020.
24. Ahmed Kosba, Dimitrios Papadopoulos, Charalampos Papamanthou, and Dawn Song, [*MIRAGE: Succinct Arguments for Randomized Algorithms with Applications to Universal zk-SNARKs*](https://www.usenix.org/conference/usenixsecurity20/presentation/kosba), USENIX Security 2020.
25. Matteo Campanelli, Antonio Faonio, Dario Fiore, Anaïs Querol, and Hadrián Rodríguez, [*Lunar: A Toolbox for More Efficient Universal and Updatable zkSNARKs and Commit-and-Prove Extensions*](https://doi.org/10.1007/978-3-030-92078-4_1), ASIACRYPT 2021.
26. Carla Ràfols and Arantxa Zapico, [*An Algebraic Framework for Universal and Updatable SNARKs*](https://doi.org/10.1007/978-3-030-84242-0_27), CRYPTO 2021. The paper calls its most efficient construction Basilisk.
27. Ariel Gabizon and Zachary J. Williamson, [*FFLONK: a Fast-Fourier Inspired Verifier Efficient Version of PLONK*](https://eprint.iacr.org/2021/1167), IACR ePrint 2021/1167.
28. Yuncong Zhang, Alan Szepieniec, Ren Zhang, Shi-Feng Sun, Geng Wang, and Dawu Gu, [*VOProof: Efficient zkSNARKs from Vector Oracle Compilers*](https://doi.org/10.1145/3548606.3559387), ACM CCS 2022.
29. Binyi Chen, Benedikt Bünz, Dan Boneh, and Zhenfei Zhang, [*HyperPlonk: Plonk with Linear-Time Prover and High-Degree Custom Gates*](https://doi.org/10.1007/978-3-031-30617-4_17), EUROCRYPT 2023.
30. Bryan Parno, Jon Howell, Craig Gentry, and Mariana Raykova, [*Pinocchio: Nearly Practical Verifiable Computation*](https://doi.org/10.1109/SP.2013.47), IEEE Symposium on Security and Privacy 2013.
31. Shumo Chu, Brandon H. Gomes, Francisco Hernández Iglesias, Todd Norton, and Duncan Tebbs, [*UniPlonK: PlonK with Universal Verifier*](https://eprint.iacr.org/2023/869), IACR ePrint 2023/869.
32. Arka Rai Choudhuri, Sanjam Garg, Aarushi Goel, Sruthi Sekar, and Rohit Sinha, [*SublonK: Sublinear Prover PlonK*](https://doi.org/10.56553/popets-2024-0080), Proceedings on Privacy Enhancing Technologies 2024(3).
