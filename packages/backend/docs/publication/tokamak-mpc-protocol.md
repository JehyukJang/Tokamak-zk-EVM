# The Tokamak Two-Phase MPC Protocol

## Abstract

Preprocessing succinct non-interactive arguments of knowledge (SNARKs) obtain
small proofs and efficient verification from a structured reference string
(SRS), but the hidden values used to construct that string create a trusted-setup
problem. This document defines the multi-party computation (MPC) implemented by
the Tokamak zk-EVM backend for the setup of Jang's SNARK. The design separates a
reusable monomial setup from circuit-dependent specialization so that no single
setup process must disclose all of the hidden values.

Tokamak provides two ways to prepare the reusable material. The native route
constructs it through sequential contributions to `alpha`, `x`, and `y`. The
Dusk-backed route verifies and reindexes a completed BLS12-381 powers-of-tau
artifact, then adds sequential contributions to the missing `y` dimension. Both
routes converge on one Phase 1 SRS shape. Public circuit specialization follows,
and Phase 2 contributors update `gamma`, `delta`, and `eta` in the resulting
circuit-dependent material.

The implementation verifies sources, algebraic update consistency, immutable
families, circuit identity, state chaining, and final artifact provenance. Those
checks do not prove entropy quality or deletion of participant secrets. The
standard two-phase literature requires an honest erased contribution in every
phase for its knowledge-soundness claims. Tokamak follows that trust objective,
but no cited result proves the exact six-parameter construction or the
algebraically related `alpha` and `x` used by the Dusk-backed route. The security
claims below are limited accordingly.

## 1. Introduction

A succinct non-interactive argument of knowledge allows a prover to convince a
verifier that a computation has a valid witness while sending a proof much
smaller than the computation itself. Preprocessing SNARKs such as Groth16 obtain
particularly small proofs and efficient verification by generating a reference
string before proving begins [1]. Correct setup is therefore part of the system's
security and efficiency foundation, rather than an incidental deployment step.

The trusted-setup challenge is that reference-string generation may evaluate
structured expressions at hidden values. Malicious selection or later recovery
of those values can place the resulting string outside the distribution assumed
by the proof system. Public artifacts may be internally well formed while the
party that generated them still retains information that verification cannot
detect. Deletion of ordinary digital data is not generally publicly provable
[20].

Two-phase MPC replaces one setup party with sequential public updates. A reusable
first phase produces universal powers, public computation specializes them to a
circuit, and a second phase updates the specialized parameters [3, 5]. Each
participant multiplies the preceding hidden value by a private share while
publishing evidence that the public state was updated consistently. The standard
security objective requires at least one honest participant in each phase to use
unpredictable randomness and erase the corresponding share; the phases may have
different contributors.

Jang and Judd's *An Efficient SNARK for Field-Programmable and RAM Circuits*,
called Jang's SNARK hereafter, commits a library of subcircuits while allowing
larger circuits to be derived by placement and wiring [6]. Its setup samples six
hidden scalars and produces a CRS containing univariate, bivariate, mixed, and
circuit-dependent encodings. The library-level reuse is valuable for changing
computations, but the setup described in the paper is not updatable and assumes
the six scalars are sampled by the setup algorithm.

Several established constructions and public ceremonies appear to offer a
reusable trust basis. The scalable two-phase construction of Bowe, Gabizon, and
Miers separates powers of tau from circuit specialization [3], while *Snarky
Ceremonies* formalizes universal and specialized ceremony states [5]. Public
artifacts include the Zcash Powers of Tau, the Dusk extension over BLS12-381,
the Ethereum KZG ceremony, and PSE's Perpetual Powers of Tau [9–12]. These
ceremonies demonstrate that large reusable SRS material can be generated and
independently checked by a broad participant set.

Completed ceremony artifacts nevertheless cannot generally be consumed
unchanged by Jang's SNARK. The source and target may use different pairing
curves, the published tau sequence may not cover the required degree in both
groups, and a conventional powers-of-tau string does not supply the fuller SRS
structure required by Jang's setup. These are compatibility boundaries even
when the source ceremony itself is valid.

The problem is therefore to preserve the reusable trust basis of a compatible
completed ceremony where possible while completing the setup structure required
by Jang's SNARK without publishing the missing hidden values. The same protocol
must also support an independently generated route when no external source is
used.

Tokamak addresses the problem with a native route and an external-source route.
The first builds the reusable material through Tokamak contributions; the second
verifies and adapts a compatible ceremony result before adding the missing
contribution dimension. Both then enter the same two-phase protocol: one common
Phase 1 result, deterministic circuit specialization, shared Phase 2
contributions, and a final CRS bound to the verified transcript.

## 2. Background

### 2.1 Structured setup and powers of tau

Let `G1` and `G2` be prime-order groups with a non-degenerate bilinear pairing,
and write `[z]_j` for an encoding of scalar expression `z` in group `Gj`.
Powers-of-tau ceremonies publish sequences such as
`[1], [tau], [tau^2], ...` without publishing `tau`. A contributor with secret
share `r` transforms the sequence so that its hidden scalar becomes `tau*r`,
and pairing relations make consistent updates publicly checkable [2, 3]. These
sequences underlie KZG polynomial commitments and several SNARK setup systems
[7].

In the two-phase construction lineage, the first sequence is reusable up to a
degree bound. Public specialization maps it and a circuit description into
circuit-dependent material, after which a second contribution sequence updates
the remaining trapdoor-dependent terms [3]. *Snarky Ceremonies* expresses this
as universal and specialized SRS state, with `Update` and `VerifySRS` algorithms
and an honest-update requirement for each phase [5]. Tokamak reuses this
vocabulary but does not claim an identical SRS construction.

### 2.2 Jang's setup

Jang's setup samples

```text
(alpha, x, y, gamma, delta, eta)
```

and encodes expressions needed to commit a subcircuit library, placement in a
`y` domain, wire polynomials in `x`, and the proof system's public,
intermediate, private, and vanishing-polynomial relations [6]. The implementation
retains those meanings. In particular, `gamma`, `delta`, and `eta` are scalars
with both direct encodings and circuit families divided by the corresponding
scalar; they are not “inverse-only” parameters.

The paper proves properties of the SNARK when its setup algorithm samples the
trapdoors, using the generic group model [6]. It does not specify or prove the
Tokamak MPC. This distinction determines the claim boundary throughout this
document.

## 3. System Model and Notation

Tokamak follows the established reusable-then-specialized setup structure
[3, 5]. Its two source routes differ in how universal material is prepared and
which Phase 1 scalars receive Tokamak contributions. They converge on one common
Phase 1 output, after which the same deterministic circuit specialization and
Phase 2 contribution protocol are used. This is a correspondence to the cited
two-phase structure, not a new setup model or a formal equivalence claim.

### 3.1 Roles and authority

The roles correspond to the coordinator, participant, and public verifier used
by prior ceremonies [3, 5, 11]. The **operator** schedules deterministic
transformations and passes states between contributors. A **contributor** applies
a private multiplicative share. A **verifier** checks sources, transitions,
selection, and the transcript. A downstream **CRS consumer** accepts the final
Jang CRS and its provenance. The Dusk ceremony is an external SRS source rather
than a Tokamak participant.

Workflow control and cryptographic authority are separate. An operator can
censor a contributor, delay a ceremony, or withhold an artifact, but cannot make
an inconsistent transition satisfy the implemented public checks. Conversely,
those checks cannot establish that a contributor used unpredictable entropy,
kept it private, or erased it. Contributor names and device metadata are social
records, not cryptographic authority.

### 3.2 Algebraic setting and notation

For a checked finite layout `L`, let `U_L(alpha,x,y)` abbreviate the required
G1/G2 encodings of the following pure and mixed monomials:

```text
[alpha^k], [x^a], [y^b],
[alpha^k x^a], [alpha^k y^b], [x^a y^b],
[alpha^k x^a y^b].
```

The index ranges are those required by Jang's CRS and the repository's
authoritative monomial layout. The abbreviation does not imply that every group
contains every monomial or define a serialized point array. The detailed ranges
remain an implementation contract [14].

A participant's share for scalar `z` is written `r_z`. Sequential contributions
replace `z` by `z * product_i r_z,i`. Public group elements are updated directly;
the scalar is never serialized. `R` denotes the committed subcircuit-library
description, and `Specialize_R` denotes the deterministic group computation that
constructs circuit-dependent points from a selected Phase 1 output.

### 3.3 Setup parameters and stages

The reusable/circuit-dependent distinction follows the two-phase literature;
the exact six-parameter assignment follows Jang's CRS and the implemented
dependency paths [3, 5, 6, 14].

| Parameter | Role in Jang's setup | Tokamak stage | Required erasure boundary |
|---|---|---|---|
| `alpha` | Powers mixed with wire and correction encodings | Native Phase 1, or Dusk-derived alpha/X basis | After a native Phase 1 contribution; for Dusk-backed setup, at least one source contributor's share must remain unknown and erased |
| `x` | Evaluation dimension for subcircuit and wire polynomials | Native Phase 1, or Dusk-derived alpha/X basis | Same boundary as `alpha` for the selected route |
| `y` | Placement dimension and bivariate mixing | Phase 1 on both routes | After each qualifying Phase 1 contribution |
| `gamma` | Direct encodings and inverse-scaled public-instance family | Phase 2 | After each qualifying Phase 2 contribution |
| `delta` | Direct encodings and inverse-scaled private/correction families | Phase 2 | After each qualifying Phase 2 contribution |
| `eta` | Direct encodings and inverse-scaled intermediate family | Phase 2 | After each qualifying Phase 2 contribution |

Phase 1 finishes the reusable monomial basis. `Specialize_R` is the first step
that reads the concrete QAP/R1CS coefficients and binds the canonical library
source digest. Phase 2 then updates only the three scalars used by the specialized
families. Reading capacity bounds before this point does not fix a circuit.

### 3.4 Ceremony states and contributions

Each accepted contribution is sequential: it is proved against one preceding
state, yields one successor, and is recorded in an ordered transcript. Tokamak
persists this boundary as an **authenticated ceremony state**, meaning the
immutable public payload and metadata whose canonical digest is bound by the
next transition. This short implementation-specific term corresponds to the
public SRS state in the anchor models while making the repository's recovery
boundary explicit.

A phase output is selectable only after its complete chain verifies and contains
at least one contribution using participant/system randomness. Deterministic
beacon updates may be checked and recorded, but do not supply an unknown share;
testing updates are ineligible. Selection adds no signer or secret: the next
stage records the digest of the selected state.

### 3.5 Security assumptions and properties

The conventional ceremony goal is that at least one independently unpredictable
share affecting each protected parameter remains unknown and is erased [3, 5].
Tokamak permits one contributor and permits the same person in both phases. Such
an execution can meet the algebraic unknown-share condition, but it has no
redundancy against that person's compromise or failed erasure. Identity diversity
is defense in depth rather than a verifier-enforced theorem condition.

The analysis distinguishes setup secrecy, transition integrity, source
authenticity, circuit commitment, transcript and artifact integrity, and
availability. The implementation directly checks the integrity properties. Its
setup-secrecy conclusions depend on entropy, non-disclosure, erasure, discrete
logarithm hardness, and the external source assumptions. Exact knowledge
soundness for this MPC and distributional equivalence of the Dusk-backed setup
are not established by the cited papers.

## 4. Existing Ceremony Compatibility and Reuse Boundary

An existing powers-of-tau result is a usable input only when it employs the
target groups, supplies both group sequences through every exponent consumed by
the public transformation, and has enough structure to derive the target basis.
These are factual SRS properties from the source specifications [3, 7, 9–12],
not a new compatibility model.

For the current tracked setup, `l=396`, `l_D=1420`, `n=1024`, and `s_max=256`,
so `m_i=l_D-l=1024` and `N=max(n,m_i)=1024` [15]. The checked Dusk mapping
requires source G1 exponents through 10,240 and G2 exponents through 8,192 [14].
These are formula-derived repository values, not performance measurements.

| Public artifact | Curve | Published capacity relevant here | Practical conclusion |
|---|---|---|---|
| PSE Perpetual Powers of Tau [12] | BN254 | Up to `2^28` constraints and `2 * 2^28 - 1` powers | Degree is ample, but the curve is incompatible. |
| Ethereum KZG ceremony [11] | BLS12-381 | Largest sequence ends at G1 exponent `2^15-1`; every G2 sequence ends at exponent 64 | The curve and G1 capacity fit, but the G2 sequence is too short for the current mapping. |
| Dusk trusted setup [9] | BLS12-381 | Documents powers through `2^21`, extending the verified Zcash result with 15 listed contributions | The pinned artifact supplies the curve and degree needed as an input basis. |

Curve mismatch prevents reuse because encodings cannot be transferred between
different prime-order pairing groups. Degree must be checked independently in
G1 and G2: a long G1 sequence does not compensate for missing G2 powers. The
Dusk range covers the current checked bounds, whereas the Ethereum G2 sequence
does not.

Capacity alone is insufficient. A conventional powers-of-tau string provides
univariate encodings of one hidden scalar. Jang's setup requires several hidden
scalars, mixed `x`/`y` monomials, and circuit-dependent families [6]. Public
linear combinations can derive encodings from available powers, but cannot
manufacture an independent missing secret.

The selected Dusk result is therefore usable only as an input basis. Its
published sequence and ceremony assumption carry source authenticity and the
unknown-source-scalar objective into the verified powers. Tokamak then derives
`x=t` and `alpha=t^(2N)` from the same Dusk scalar `t`; this public relationship
is not the independent sampling used by Jang's setup and has no cited
equivalence proof. The source also contains no Tokamak `y`, `gamma`, `delta`, or
`eta` contribution. Phase 1 and Phase 2 remain necessary.

## 5. Protocol Overview

### 5.1 Route preparation

The native route initializes every required Phase 1 encoding at conceptual
`alpha=x=y=1`. The Dusk-backed route authenticates and verifies the pinned
powers-of-tau artifact, reindexes its powers into the alpha/X basis, and expands
the Y-dependent families at conceptual `y=1`. These are genesis/preparation
operations, not entropy-bearing participant contributions.

### 5.2 Phase 1 and convergence

Native Phase 1 contributors update `alpha`, `x`, and `y` and every affected
mixed monomial. Dusk-backed Phase 1 contributors update `y` and every
Y-dependent family while leaving the adapted alpha/X material immutable. Each
route requires at least one qualifying contribution. Both yield the same
`U_L(alpha,x,y)` shape, so later cryptographic computation is source-neutral.

### 5.3 Circuit commitment and Phase 2

Public deterministic specialization commits `R` by evaluating its polynomial
coefficients through group multi-scalar multiplication over the selected Phase 1
basis; it never recovers `alpha`, `x`, or `y`. It initializes the direct
`gamma`, `delta`, and `eta` encodings and their unscaled circuit-dependent
families. Phase 2 contributors then multiply direct encodings by their shares
and inverse-dependent families by the inverse shares. The selected result is
projected into the unchanged Jang CRS layout.

### 5.4 Verification and trust boundary

Proofs, pairing checks, immutable-family checks, canonical digests, and the
complete transcript establish that an accepted final artifact follows the
recorded source, layout, circuit, and contribution chain. They do not establish
secret deletion. If every share protecting one phase is known, the standard
honest-update premise for that phase is absent; this removes the cited
knowledge-soundness guarantee without retroactively erasing independently
verifiable integrity or disclosing the other phase's scalars.

### 5.5 Correspondence to established two-phase MPC

| Established approach [3, 5] | Tokamak realization | Relationship |
|---|---|---|
| Reusable universal phase | Phase 1 universal `alpha`/`x`/`y` monomial basis | Consistent stage boundary; specialized parameter families differ. |
| Public relation specialization | Deterministic QAP/R1CS commitment from selected Phase 1 points | Consistent public specialization role. |
| Specialized update phase | Phase 2 `gamma`/`delta`/`eta` direct and inverse updates | Consistent purpose; Tokamak-specific parameter set and equations. |
| Sequential `Update` and public verification | State-bound share proofs, pairing checks, immutable families, and transcript replay | Consistent verification objective; implementation-specific persistence. |
| Honest erased update in every phase | At least one qualifying entropy-bearing Tokamak contribution per phase, plus the external source assumption for Dusk alpha/X | Same high-level trust objective; no exact Tokamak security reduction. |
| One universal source construction | Native initialization or a verified Dusk input basis | Different: source-route plurality and public reindexing are Tokamak-specific. |

Thus an expert can infer the remainder: the protocol specializes an authenticated
universal SRS, updates only the trapdoor families assigned to each stage, and
derives the final CRS from selected verified states. Its integrity mechanisms are
implemented and testable; its secrecy and knowledge-soundness claims remain
bounded by honest erasure and the explicit proof gaps.

## 6. Route Preparation

### 6.1 Native initialization

Native initialization constructs the complete monomial layout with each hidden
scalar conceptually equal to one. The resulting genesis contains no participant
entropy and cannot be selected. Its purpose is to give the first contributor a
well-formed base whose every pure and mixed family can be updated and checked.

### 6.2 Dusk adaptation

Let `t` be the hidden scalar behind the pinned Dusk sequence and
`N=max(n,m_i)`. Mapping version 1 uses

```text
x                 = t
alpha             = t^(2N)
alpha^k x^a       = t^(2Nk+a)
```

for the checked exponent ranges. The adaptor validates the exact source digest,
encoding, canonical generators, required G1/G2 ranges, and adjacent-power
pairing consistency before applying this public index map. It consumes only the
plain Dusk tau sequences, not Dusk's Groth16 alpha or beta families.

The adapted output is not a Tokamak ceremony state and carries no Tokamak
receipt. Dusk-backed preparation expands it across the Y dimension at
conceptual `y=1`. This prepared state is also unselectable until a Tokamak
contributor changes the Y-dependent material.

## 7. Phase 1: Universal Monomial Contributions

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
corresponding shares. Pure powers, mixed tensors, and boundary slices are checked
together so that a participant cannot update one dependent family while leaving
another inconsistent.

For Dusk-backed contribution `i`, the only new share is `r_y,i`. Every monomial
with exponent `b` in Y is multiplied by `r_y,i^b`; all alpha/X-only material
must remain byte-for-byte unchanged. The implementation rejects a contributed
state whose `y^s` encoding still equals the conceptual genesis value. The scalar
`y` is neither generated by an operator nor disclosed in a state.

The selected Phase 1 state must terminate a complete verified chain and include
at least one qualifying update. Native and Dusk-backed states then expose the
same mathematical point families to specialization, while provenance retains
which source route produced them.

## 8. Phase 2: Circuit Specialization and Contributions

Given the selected Phase 1 points and circuit description `R`, deterministic
specialization constructs circuit-dependent encodings by linear group
operations. For a wire polynomial `o_j(X)`, helper polynomial `K_j(X)`, and
Y-domain Lagrange polynomial `L_i(Y)`, representative identities are

```text
[L_i(y)o_j(x)]_1
  = sum_(a,b) l_(i,b)o_(j,a)[x^a y^b]_1,

[L_i(y)alpha^4 K_j(x)]_1
  = sum_(a,b) l_(i,b)k_(j,a)[alpha^4 x^a y^b]_1,

[alpha^k y^i(y^s-1)]_1
  = [alpha^k y^(i+s)]_1 - [alpha^k y^i]_1.
```

Because all coefficients are public, these computations need no scalar
trapdoor. The prepared Phase 2 state binds the selected Phase 1 digest and the
canonical subcircuit-library source digest. It initializes direct encodings at
`gamma=delta=eta=1` and leaves inverse-dependent circuit families unscaled.

Each Phase 2 contributor samples independent nonzero shares
`r_gamma,i`, `r_delta,i`, and `r_eta,i`. A direct encoding `[z]` is multiplied
by `r_z,i`, while every encoding of the form `[F/z]` is multiplied by
`r_z,i^-1`. Phase 1 and circuit-fixed material is immutable. After the sequence,
each Phase 2 scalar is the product of its accepted shares.

## 9. Verification, Transcript, and Final CRS

Each secret share has public G1/G2 encodings and a transcript-bound proof of
knowledge. Direct update checks tie first powers to those encodings. Batched
pairing relations check the remaining power axes and mixed tensors. The Dusk
profile additionally checks exact alpha/X immutability; Phase 2 checks both
positive direct updates and inverse-family updates.

The proof domain binds protocol and contract versions, ceremony identifier,
phase, contribution profile, sequence, predecessor and successor state digests,
capacity and layout identities, the circuit identity when present, and the
parameter label. These bindings prevent an otherwise valid proof from being
replayed across another state, route, profile, phase, or circuit.

The append-only workspace reloads immutable, content-addressed states and
re-verifies every transition and phase boundary. Its index is not an independent
authority. The canonical transcript records both selected chains, receipt
digests, entropy modes, qualifying counts, source provenance, and circuit
identity. Finalization reconstructs that transcript, accepts only a qualifying
selected Phase 2 state, and binds the transcript SHA-256 and final artifact
digests into provenance [14].

Hashes and pairing checks establish integrity within their assumptions. They do
not show that a participant's local entropy was unpredictable, that no copy of a
share exists, or that an artifact will remain available.

## 10. Trust and Security Analysis

### 10.1 What an honest contribution provides

At the algebraic level, a product remains unknown to observers who know every
other factor when at least one nonzero factor is independently unpredictable and
not disclosed, assuming discrete logarithms remain hard. This is the purpose of
sequential contribution. The stronger statement that this condition proves
knowledge soundness for the exact Tokamak/Jang construction is not available:
the anchor theorems apply to their specified constructions [3, 5], and Jang's
analysis begins with a setup-generated six-secret CRS [6].

One contributor in a phase can supply its unknown factors if that person uses
strong entropy, discloses nothing, and erases every share. Multiple contributors
provide redundancy against compromise. The same person may contribute to both
phases and meet both algebraic conditions, but compromise or failed erasure by
that person can then remove the condition from both phases.

### 10.2 Parameter-specific boundary

| Protected values | Unknown-share requirement | Consequence supported by current evidence if exposed |
|---|---|---|
| Native `alpha`, `x`, `y` | At least one undisclosed and erased corresponding share in native Phase 1 | The affected scalar is known and Jang's independent hidden-scalar setup premise no longer applies to encodings that use it. Exposure of one scalar is not shown to reveal the others. |
| Dusk-backed `alpha`, `x` | At least one qualifying Dusk/Zcash source share remains unknown and erased | Exposure of source `t` reveals both `x=t` and `alpha=t^(2N)`. Even without exposure, equivalence of this related pair to independent sampling is unproved. |
| Dusk-backed `y` | At least one undisclosed and erased Tokamak Y share | Exposure reveals `y` but does not by itself reveal Dusk `t`. The source ceremony never replaces this contribution. |
| `gamma`, `delta`, `eta` | At least one undisclosed and erased corresponding Phase 2 share | The affected direct/inverse setup scalar is known and the CRS is outside the six-secret setup distribution analyzed by Jang. The literature does not prove the exact parameter-by-parameter forgery consequence. |

The Phase 2 boundary is consequently narrower than either common extreme.
Disclosure of `gamma`, `delta`, and `eta` does not compute `alpha`, `x`, or `y`
through the implemented update and does not change whether the source, circuit,
transitions, transcript, or artifact digests verify. It does remove the unknown
Phase 2 contribution premise. The cited two-phase knowledge-soundness guarantee
and Jang's six-secret setup analysis therefore cannot be asserted for that CRS.
Current evidence does not justify saying either that such disclosure is harmless
or that it automatically compromises every property of the CRS.

### 10.3 Malicious behavior and operational limits

Malformed points, inconsistent powers, partial updates, inverse-direction
errors, replay, cross-profile substitution, mutation of fixed families, source
replacement, circuit substitution, and post-acceptance artifact changes are
within the implemented validation boundary. A successfully verified transcript
is evidence that those public relations and identities hold.

A contributor can still choose predictable nonzero randomness or retain a
secret. An operator can censor, delay, withhold, or choose among otherwise valid
qualifying chains. Contributors and the operator can collude. These actions are
not disproved by identity metadata or algebraic checks. If a coalition learns
every share protecting a phase, the honest-update premise for that phase is
absent.

Source authenticity is also distinct from source secrecy. The Dusk adaptor
checks the pinned artifact and its mathematical power structure, while the
claim that the hidden Dusk scalar remains unknown depends on the Zcash/Dusk
ceremony and at least one source contributor's non-disclosure and erasure [9,
10].

## 11. Limitations

No formal reduction currently proves that the Tokamak contribution equations
produce the exact setup distribution required by Jang's knowledge-soundness
analysis. The largest explicit gap is the Dusk mapping: `alpha=t^(2N)` and
`x=t` are algebraically related, whereas Jang's setup samples them independently.
The mapping is finite-degree correct and publicly verifiable, but those facts do
not establish distributional equivalence.

The available literature also does not isolate the precise forgery power gained
by learning only one of `alpha`, `x`, `y`, `gamma`, `delta`, or `eta` in Jang's
SNARK. This document therefore reports which secrecy premise is lost and which
independent integrity properties remain; it does not invent a parameter-specific
attack or preservation theorem.

Tokamak enforces at least one entropy-bearing contribution per phase but not
multiple identities, independent organizations, hardware isolation, or public
attestations. The native route is implemented and algebraically validated, but
the current artifact policy marks only the Dusk-backed provenance as release
eligible [14]. That operational flag is not a comparative security proof.

Finally, SHA-256 content addressing, canonical serialization, pairing checks,
and transcript replay depend on their cryptographic primitives and correct
implementation. They protect integrity and provenance, not confidentiality,
erasure, fairness, censorship resistance, or long-term artifact availability.

## 12. Implementation Correspondence

The protocol is identified as `tokamak-mpc-2phase-v1`. Phase 1 has two
state-bound contribution profiles: native `alpha`/`x`/`y`, and Dusk-backed `y`.
Phase 2 has one shared `gamma`/`delta`/`eta` profile. Both Phase 1 routes produce
the same typed universal payload, and both call the same circuit-specialization
and Phase 2 implementation [14].

The participant lifecycle is consistent across profiles: verify the predecessor,
display the phase and bound profile, generate entropy, apply the update, create
proofs, self-verify, erase temporary share material, and emit an immutable state
and receipt [16]. Preparation steps do not create participant secrets or
receipts. Interrupted deterministic specialization is rerun from the last
verified selected Phase 1 state rather than resumed from an unauthenticated
partial result.

Finalization projects the selected circuit-specific state into the existing Jang
consumer structure and produces exactly four root artifacts: the combined CRS,
preprocess CRS, verifier CRS, and provenance document. The complete ceremony
states and receipts remain in the separate transcript bundle; provenance carries
their transcript root. Operational commands and byte-level schemas remain
authoritative in the implementation contract and operator guide, not in this
abstract publication [14, 16].

## 13. Related Work

The Pinocchio MPC provided an early practical sequential ceremony for
circuit-specific SNARK parameters [2]. Bowe, Gabizon, and Miers then separated a
scalable powers-of-tau phase from circuit specialization and a second update
phase [3]. *Snarky Ceremonies* gives a general framework for update and
verification algorithms, universal and specialized SRS components, and
subversion properties under explicit per-phase honest-update conditions [5].
These are the closest construction and model anchors for Tokamak.

Universal and updatable CRS research takes a different route by designing the
proof system and SRS for later updates across a class of relations [4]. Sonic is
a representative practical universal/updatable SNARK [8]. Jang's SNARK instead
commits a subcircuit library and supports circuits derived from that library,
while its paper explicitly does not provide an updatable setup [6]. Tokamak's
MPC is a setup procedure for that existing CRS structure, not a conversion of
the proof system into Sonic or another universal-updatable construction.

Deployed ceremonies show several operational models. Zcash produced a reusable
BLS12-381 Phase 1 result with 87 participant contributions and a final beacon
[10]. Dusk started from the verified 87th Zcash contribution, before that final
beacon, and added 15 contributions [9]. Filecoin reused a BLS12-381 Phase 1 and
ran circuit-specific Phase 2 ceremonies [13]. Ethereum
generated four BLS12-381 KZG sequences through a public sequencer [11], while
PSE's Perpetual Powers of Tau targets a much larger BN254 degree [12]. More
recent research explores decentralized, asynchronous, and lower-cost powers-of-
tau execution [17–19]. These works improve participation and ceremony operation;
they do not by themselves solve the Jang-specific parameter and compatibility
problem.

## 14. Conclusion

Tokamak implements a two-phase MPC for Jang's SNARK with two source routes. The
native route contributes `alpha`, `x`, and `y`; the Dusk-backed route verifies
and reindexes an external BLS12-381 powers-of-tau basis and contributes the
missing `y`. Both converge before deterministic circuit specialization and the
shared `gamma`/`delta`/`eta` contribution phase.

The implementation provides strong, independently repeatable evidence about
source identity, algebraic transition consistency, circuit commitment, state
chaining, and artifact provenance. Its secrecy boundary remains conventional:
at least one suitable share for each protected phase must remain unknown and be
erased. Failure of that condition removes the applicable setup-security premise
but does not erase unrelated integrity facts or automatically reveal every other
trapdoor.

The remaining cryptographic research question is formal rather than operational:
prove the exact six-parameter MPC for Jang's SNARK, including the Dusk-backed
alpha/X relation, or replace the relation with a construction covered by such a
proof. Until then, the protocol should be evaluated through the explicit
integrity guarantees, trust assumptions, and limitations stated here rather than
through a claim of full equivalence to an existing ceremony theorem.

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
