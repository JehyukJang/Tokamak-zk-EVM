# The Tokamak Two-Phase Multi-Party Computation Protocol

*Last updated: 2026-09-03*

## Abstract

Preprocessing succinct non-interactive arguments of knowledge (SNARK) systems
obtain small proofs and efficient verification from a structured reference string
(SRS), but the hidden values used to construct that string must remain unknown.
This document defines the multi-party computation (MPC) used to generate the
CRS for Tokamak's SNARK, the construction proposed in [6]. The design separates
circuit-independent setup material from the material derived for a particular
subcircuit library and allows contributors to update the hidden values in two
stages. This document uses SRS for generic
structured setup material and common reference string (CRS) for the output
specific to Tokamak's SNARK.

The protocol starts from a verified BLS12-381 sequence of univariate encoded
powers and selects the powers needed for part of the reusable,
circuit-independent setup. Contributors then independently generate the
remaining parameters required by Tokamak's multivariate relations. After a public computation
binds that material to the canonical subcircuit library, contributors update the
remaining circuit-dependent parameters.

Public verification checks the source, contribution equations, material that an
update must preserve, links between successive states, specialization to the
subcircuit library, and the final CRS. Those checks do not prove the quality of
participant randomness or deletion of participant secrets. The security
analyses in [3, 5] require at least one contributor in each protected component
to choose an unpredictable secret and erase it. They also do not establish
knowledge soundness for the additional public elements needed to update
Tokamak's circuit-independent setup, so the security claim below remains
limited accordingly.

## 1. Introduction

A succinct non-interactive argument of knowledge (SNARK) allows a prover to
convince a verifier that the prover knows a witness that, together with the
public input, satisfies a circuit relation, with a proof that is small relative
to checking the relation directly. A preprocessing SNARK runs a setup before
proofs are generated and uses the resulting reference string for later proving
and verification. The resulting reference string supports small proofs and
efficient verification across repeated uses of the setup. Examples include
Pinocchio [30], Groth16 [1], and later constructions such as Sonic [8] and PLONK
[21]; further examples, including Tokamak's SNARK, appear in [4, 6, 22–29, 31,
32].

Jang and Judd have proposed Tokamak's SNARK [6], which combines Groth16's
arithmetic argument with PLONK's use of a permutation argument [1, 21]. In their
construction, each supported circuit relation is defined by placing and wiring
copies from a subcircuit library committed by the setup, while the proof checks
the internal computation of those copies and the connections between them.
Compared with Groth16, one common reference string (CRS) therefore supports a
specific family of circuit relations rather than one circuit relation fixed
during setup. Compared with PLONK, verifier preprocessing for a new circuit
relation describes only connections between already committed subcircuits
rather than the constraints and wiring of the entire circuit; the reduction is
greatest when the subcircuits contain substantially more internal computation
than interface wiring. This reduction may also lower the cost for verifiers and
users to audit the information supplied during verifier preprocessing.

For preprocessing SNARKs that use secret-dependent structured reference
strings, including Tokamak's SNARK, the setup computes the reference string from
secret values conventionally called trapdoors [1, 2, 6]. In a single-party
setup, the generator must sample those trapdoors as specified and erase every
copy after generating the reference string. If sufficient trapdoor information
is retained or exposed, a party that obtains it may be able to generate an
accepting proof for a public input for which no valid witness exists, breaking
soundness [2, 20]. A structurally well-formed reference string alone does not
show that the trapdoors were sampled as specified and erased. Because public
verification cannot establish that the trapdoors were sampled unpredictably and
erased, users must trust the generator [20].

One way to avoid relying on a single trusted generator is multi-party
computation (MPC), which distributes setup generation across a sequence of
contributors. Each contributor uses private randomness to update the public
setup elements and publishes evidence that the update is consistent. In the
two-phase setup protocols of [3, 5], the first phase generates
circuit-independent elements that can be reused for multiple circuits. A public
computation then derives elements for one circuit, and the second phase updates
the remaining circuit-dependent parameters. The security analyses require at
least one contributor in each phase to use unpredictable randomness and erase
that randomness; the phases may have different contributors.

Running an MPC setup ceremony is operationally demanding because it requires
coordinating multiple contributors and distributing, updating, and verifying
large public data sets. Nevertheless, several ceremonies have published
powers-of-tau sequences as reusable first-phase results [9–13]. By separating
circuit-independent work from circuit-dependent setup, the two-phase setup
protocols allow compatible preprocessing SNARKs to reuse the same ceremony
result instead of conducting a new first phase for each construction [3, 5].

In this document, we focus on reusing a powers-of-tau sequence produced by an
existing ceremony to generate the CRS for Tokamak's SNARK. Our purpose is to
evaluate candidate sequences, identify the challenges that prevent direct reuse
and the conditions under which reuse is possible, define the protocol that
addresses those challenges, and state its verification guarantees and trust
assumptions.

Reusing the output of an existing MPC ceremony requires evaluating candidate
sequences along three dimensions. Exponent capacity asks whether a published
sequence contains the range of powers needed to construct the target setup.
Curve compatibility asks whether the sequence and the target proof system use
the same scalar field and pairing groups, so that the published group elements
can be reused without changing the cryptographic setting. Algebraic
compatibility asks whether the relationships encoded by the sequence match
those required by the target proof system. Capacity and curve compatibility
alone are insufficient: a sequence may be large enough and use the required
curve while still imposing algebraic relationships that are incompatible with
Tokamak's SNARK.

We therefore define a two-phase protocol that begins with a selected univariate
encoded-power sequence satisfying the required curve and exponent conditions.
The first phase independently generates the two remaining parameters of the
reusable circuit-independent setup; after public specialization to the committed
subcircuit library, the second phase completes the CRS. This document analyzes
the protocol's public verification guarantees, trust assumptions, and unresolved
proof limitation; it does not claim knowledge soundness for the complete public
first-phase interface.

## 2. Background

### 2.1 Structured setup and powers of tau

This document uses SRS for structured setup material in the general protocols
and ceremonies discussed below, and CRS for the setup output specific to
Tokamak's SNARK.
Let $G_1$ and $G_2$ be prime-order groups with a non-degenerate bilinear pairing.
For $g\in\{1,2\}$, write $[z]_g$ for the encoding of the scalar expression $z$
in $G_g$.
For a degree bound $d$, powers-of-tau ceremonies publish sequences
$([\tau^i]_g)_{i=0}^{d}$ in $G_g$, for $g\in\{1,2\}$, while the scalar $\tau$
remains hidden. A contributor with secret share $r$ transforms the sequence so
that its hidden scalar becomes $\tau r$,
and pairing relations make consistent updates publicly checkable [2, 3]. These
sequences underlie Kate--Zaverucha--Goldberg (KZG) polynomial commitments and
several SNARK setup systems [7].

In the construction of Bowe, Gabizon, and Miers, the output of the first phase
can be reused up to a degree bound. A public computation combines it with a
circuit description, after which contributors in the second phase update the
remaining terms that depend on hidden values [3]. *Snarky Ceremonies* analyzes
the update and verification algorithms for both phases and requires an honest
update in each [5]. Tokamak follows this order but does not claim an identical
SRS construction.

### 2.2 Setup of Tokamak's SNARK

Tokamak's SNARK combines Groth16's arithmetic argument with PLONK's use of a
permutation argument [1, 6, 21]. Its setup commits a reusable subcircuit
library, and each supported circuit relation is defined by placing and wiring
copies of those subcircuits. The proof checks the internal computation of the
copies and the connections between them [6]. To construct the required CRS, the
setup samples

$$
(\alpha,x,y,\gamma,\delta,\eta)
$$

and encodes expressions needed to commit a subcircuit library, placement in a
$y$ domain, wire polynomials in $x$, and the proof system's public,
intermediate, private, and vanishing-polynomial relations [6, Section 3.3]. In
the CRS of [6, Section 3.3], $\gamma$, $\delta$, and $\eta$ have direct encodings, and the
circuit-dependent families also contain terms divided by the corresponding
scalar. They are therefore setup parameters rather than “inverse-only” values.

The paper proves knowledge soundness when its setup algorithm samples the
trapdoors, using the generic group model [6]. Knowledge soundness means,
informally, that producing an accepting proof requires knowledge of a valid
witness. The paper does not specify or prove the Tokamak MPC. This distinction
limits the security claims made in this document.

## 3. System Model and Notation

Tokamak follows the order described in [3, 5]: contributions complete the
circuit-independent setup material, public computation specializes that
material to the committed subcircuit library, and further contributions
complete the circuit-dependent material. This document calls the two
contribution periods the first and second phases. Before the first phase, powers
from the selected univariate sequence are placed in the public encodings
required by the first contribution.
This comparison does not assert that Tokamak has the same SRS or inherits the
security proofs in [3, 5].

### 3.1 Roles and verification responsibilities

The roles correspond to the coordinator, participant, and public verifier used
by prior ceremonies [3, 5, 11]. The **operator** schedules deterministic
transformations and passes states between contributors. A **contributor** applies
a private multiplicative share. A **verifier** checks sources, transitions,
selection, and the ordered ceremony record, called the transcript. Downstream
proving and verification tools consume the final CRS for Tokamak's SNARK and its
recorded origin. The final CRS commits the canonical subcircuit library from
which later circuits are derived. The ceremony that produced the selected
sequence is an external SRS source rather than a Tokamak participant.

An operator controls the workflow and can censor a contributor, delay a
ceremony, or withhold a result. A verifier accepts a transition only through the
public verification relation defined below. That relation establishes
consistency with the preceding state, but it cannot establish that a
contributor sampled its secret unpredictably, kept it private, or erased it.
Names and other contributor metadata do not affect validity.

### 3.2 Algebraic setting and notation

Let $\lambda$ be the security parameter, let $\mathbb F$ be a prime field, and
let $G_1$ and $G_2$ be prime-order groups equipped with a non-degenerate
bilinear pairing. The notation $[z]_g$ denotes the encoding of
$z\in\mathbb F$ in $G_g$ for $g\in\{1,2\}$.

Let $\Lambda$ contain the public degree and placement bounds for the setup of
Tokamak's SNARK, and let $\mathscr L_\Lambda$ be the set of subcircuit libraries
admitted by those bounds. A particular library $\mathcal L\in\mathscr
L_\Lambda$ is supplied only to public specialization.

For $g\in\{1,2\}$, let $\mathcal J_g(\Lambda)$ be a common finite index set for
the CRS positions permitted by those bounds, with a zero polynomial at a
position unused by a particular library.

For each CRS term $t$ in group $G_g$, write the part fixed before the second
phase as

$$
F_{g,t}(A,X,Y;\mathcal L)
=
\sum_{(k,b)\in\mathcal D_g(\Lambda)}
A^kY^bF_{g,t;k,b}(X;\mathcal L),
$$

where $\mathcal D_g(\Lambda)$ contains exactly the $\alpha$- and $y$-degree
pairs that can occur under the declared bounds. For each $(k,b)$, define the
finite-dimensional polynomial space

$$
\mathcal V_{g,k,b}(\Lambda)
=
\operatorname{span}_{\mathbb F}
\left\{
F_{g,t;k,b}(X;\mathcal L):
\mathcal L\in\mathscr L_\Lambda,
t\in\mathcal J_g(\Lambda)
\right\}.
$$

Fix a basis

$$
\mathcal P_{g,k,b}
=
\left(P_{g,k,b,j}(X)\right)_{j=1}^{r_{g,k,b}}
$$

for every nonzero space $\mathcal V_{g,k,b}$. This decomposition uses the CRS
families of [6, Section 3.3] without requiring a full Cartesian table of all
monomials. Define the source-exponent set

$$
\mathcal A_g(\Lambda)
=
\bigcup_{(k,b),j}
\operatorname{supp} P_{g,k,b,j}
$$

and, when this set is nonempty,

$$
d_g^\star=\max\mathcal A_g(\Lambda).
$$

The source needs only the encodings $([x^a]_g)_{a\in\mathcal A_g(\Lambda)}$.
The spaces $\mathcal V_{g,k,b}$ and their bases determine which homogeneous
$\alpha$- and $y$-components the first phase must make available for later
specialization.

A participant's share for a scalar $z$ is written $r_z$. Sequential
contributions replace $z$ by $z\prod_i r_{z,i}$. Public group elements are
updated directly while the scalar remains private. Circuit specialization is
the deterministic group computation that combines the selected first-phase
output with the canonical subcircuit-library description to construct
circuit-dependent group elements. It fixes that library, not one circuit later
derived from the library.

### 3.3 Setup parameters and stages

The division shown below follows the order in [3, 5], while the roles of the six
parameters follow the CRS defined in [6, Section 3.3].

| Parameter | Role in the setup of Tokamak's SNARK | Stage that fixes the parameter | Update action |
|---|---|---|---|
| $\alpha$ | Powers mixed with wire and correction encodings | First phase | Multiply $\alpha$ by a private nonzero share |
| $x$ | Evaluation dimension for subcircuit and wire polynomials | Source transformation | Set $x=\tau$ |
| $y$ | Placement dimension and bivariate mixing | First phase | Multiply $y$ by a private nonzero share |
| $\gamma$ | Direct encodings and public-instance elements divided by $\gamma$ | Second phase | Multiply $\gamma$ by a private nonzero share |
| $\delta$ | Direct encodings and private and correction elements divided by $\delta$ | Second phase | Multiply $\delta$ by a private nonzero share |
| $\eta$ | Direct encodings and intermediate elements divided by $\eta$ | Second phase | Multiply $\eta$ by a private nonzero share |

The source transformation fixes only $x$. The first phase independently
generates $\alpha$ and $y$ and finishes the circuit-independent encodings.
Public specialization then evaluates the setup polynomials determined by
$\mathcal L$. Contributions in the second phase update the three remaining
parameters and every specialized term in which they occur. The security
assumption for each protected component is stated in Section 10.1 rather than
treated as a publicly verifiable property.

### 3.4 Ceremony states and contributions

Each contribution is sequential: it proves a relation between one preceding
state and one successor state and is appended to an ordered update record. For
phase $j\in\{1,2\}$, let $\mathcal R_j$ be the update relation defined in
Sections 7 and 8, and let $\Pi_j$ be a non-interactive proof of knowledge for
that relation. An update record is

$$
Q_j=\bigl((S_j^{(i-1)},S_j^{(i)},\rho_j^{(i)})\bigr)_{i=1}^{c_j},
$$

where $\rho_j^{(i)}$ verifies for the ordered pair
$(S_j^{(i-1)},S_j^{(i)})$. Including both states in the proved statement binds
the proof to its exact predecessor and successor.

A phase can be finalized only when $c_j\geq1$ and every proof in $Q_j$ verifies.
This public condition shows that the chain is well formed; it does not identify
an honest update. In the security game of Section 3.5, phase finalization
additionally requires that the record contain an update returned by the honest
update oracle, as in [5, Definition 5].

### 3.5 Adversary model and security objective

The security analysis uses the multi-phase ceremony model of *Snarky
Ceremonies* [5, Section 3]. In that model, an adversary may choose a starting
SRS, make malicious updates, request honest updates, and observe all
intermediate states and update proofs. A component of the SRS is finalized only
after its update record contains an honest update. After all components have
been finalized, the adversary attempts to produce an accepted proof for which
no valid witness can be extracted.

For this analysis, the selected source sequence and its update history form an
inherited, already finalized component. The first and second Tokamak phases
form the subsequent components. This analytical decomposition does not rename
source ceremony as a Tokamak phase: the protocol still has the two contribution
periods defined above. The honest-update premise applies to
the inherited source component as well as to each Tokamak component that
introduces hidden values into the final CRS.

The principal security objective is update knowledge soundness as defined in
[5, Definition 5]. Informally, for every efficient adversary in the stated group
model, there must be an efficient extractor that obtains a valid witness from
the adversary's complete view whenever the final SRS and proof verify, except
with negligible probability. Public SRS verification is a premise of that game;
it does not establish that honest randomness was unpredictable, remained
private, or was erased.

The final knowledge-soundness claim is restricted to the generic group model
used by Jang and Judd [6]. All public group elements received from the source,
the update records, and the Tokamak protocol are part of the adversary's view.
The algebraic group model gives a broader standard abstraction in which an
adversary represents each output group element using all group elements it has
previously received [33, Definition 1]; this document does not claim security
against that broader class. In particular, the Groth16 theorem proved in [5,
Theorem 5] does not prove update knowledge soundness for Tokamak's SNARK.

## 4. Requirements for Reusing Existing Ceremony Results

Reusing an existing powers-of-tau result requires three independent checks:
exponent capacity, curve compatibility, and algebraic compatibility. Capacity
and curve compatibility determine whether a sequence can supply encoded source
elements. Algebraic compatibility determines whether those elements can be
used directly or require an additional construction and security analysis. The
criteria below follow from the target setup and the published source
specifications [3, 6, 7, 9–13].

### 4.1 Exponent capacity

Exponent capacity asks whether each source group contains every encoded power
consumed by the target construction. The two groups must be checked separately;
a longer sequence in $G_1$ cannot replace a missing power in $G_2$.

For the protocol parameters $\Lambda$, Section 3.2 defines the source exponent
set $\mathcal A_g(\Lambda)$ and its largest required exponent $d_g^\star$ for
each $g\in\{1,2\}$. A source sequence with consecutive group-specific degree
bounds $D_1$ and $D_2$ passes the capacity check exactly when

$$
D_1\geq d_1^\star
\qquad\text{and}\qquad
D_2\geq d_2^\star.
$$

These conditions are symbolic until $\Lambda$ is fixed. They determine whether
the transformation can select every required encoded power; they do not
establish algebraic compatibility or a security property.

Unlike a construction that derives several trapdoors as powers of the source
scalar, this protocol does not spend source exponent capacity on $\alpha$ or
$y$. Their degrees determine the first-phase decomposition, while source
capacity is determined only by the $x$-polynomial bases
$\mathcal P_{g,k,b}$.

### 4.2 Curve compatibility

Curve compatibility requires the source sequence and Tokamak's SNARK to use the
same scalar field and pairing groups. Encodings over another curve cannot be
transferred into the BLS12-381 groups used here without changing the
cryptographic setting [6]. A curve match does not establish exponent
capacity: both $G_1$ and $G_2$ must still contain the required ranges.

### 4.3 Algebraic compatibility

Algebraic compatibility asks whether the relations exposed by the source
sequence preserve the multivariate relations required by the target proof
system. A conventional powers-of-tau sequence contains univariate encodings of
one hidden scalar, whereas Tokamak's SNARK commits to bivariate polynomials in
independently sampled $x$ and $y$ [6]. Assigning
$x=\tau$ and $y=\tau^{e_y}$ may give every bounded monomial a distinct source
exponent, but it also imposes $y=x^{e_y}$. The substitution therefore changes
the independent-variable structure used by the opening and extraction
arguments. A collision-free exponent map is necessary for representing the
required monomials, but it is not sufficient to preserve those arguments.

Several independent univariate sequences do not solve this problem by
themselves. Without encoded mixed powers across their independent hidden
scalars, they remain separate univariate bases rather than one multivariate
encoded basis.

### 4.4 Ceremony survey

The survey classifies the encoded-power sequence evaluated for reuse, rather
than every auxiliary element that may accompany a complete ceremony artifact.
Passing this source screening is necessary but does not establish update
knowledge soundness for the completed Tokamak construction.

| Public result | Curve | Sequence form | Exponent capacity | Algebraic compatibility | Screening result |
|---|---|---|---|---|---|
| Privacy & Scaling Explorations' Perpetual Powers of Tau [12] | BN254 (`bn128` in its tooling) | Univariate | Not evaluated after the curve mismatch | Not evaluated after the curve mismatch | Excluded because the curve differs from BLS12-381 |
| Ethereum KZG ceremony [11] | BLS12-381 | Four independent univariate sequences | The largest sequence has $D_1=2^{15}-1$ and $D_2=64$; it passes exactly when these values cover $d_1^\star$ and $d_2^\star$ | The selected sequence can supply only the $x$-polynomial basis; the first phase must generate the other dimensions | Capacity conclusion pending under the revised $x$-only requirement; not selected |
| Dusk trusted setup [9] | BLS12-381 | Univariate | $D_1=2^{22}-2$ and $D_2=2^{21}-1$; it passes exactly when these values cover $d_1^\star$ and $d_2^\star$ | The selected sequence can supply the $x$-polynomial basis, while the first phase independently generates $\alpha$ and $y$ | Policy-selected candidate; revised capacity and security admission remain pending |
| Filecoin phase 1 [13] | BLS12-381 | Univariate | $D_1=2^{28}-2$ and $D_2=2^{27}-1$; it passes exactly when these values cover $d_1^\star$ and $d_2^\star$ | Its univariate sequence can supply only the $x$-polynomial basis | Conditionally eligible at the source-screening level; not selected |

Because this document leaves $\Lambda$ symbolic, these are conditional
decisions rather than measurements of one deployed instance. Candidate capacity
must be evaluated against the $x$-only sets $\mathcal A_g(\Lambda)$. The policy
selection of the Dusk result does not imply that every other source-level
candidate fails.
Section 6 defines how the protocol completes the required multivariate
material, and Section 10 evaluates whether the resulting construction meets the
security objective in Section 3.5.

## 5. Protocol Overview

### 5.1 From univariate encoded powers to Tokamak's setup

The protocol takes public parameters $\Lambda$ and a verified source sequence

$$
\mathcal U=
\left(
  ([\tau^d]_1)_{d=0}^{D_1},
  ([\tau^d]_2)_{d=0}^{D_2}
\right),
$$

where $\tau\in\mathbb F^*$ is hidden. The source must use the same field and
groups as Tokamak's SNARK and satisfy $D_g\geq d_g^\star$ for each group.
The deterministic algorithm $\mathsf{Prepare}_x$ uses only the required
$x$-powers to evaluate each basis polynomial $P_{g,k,b,j}(x)$. It initializes
the remaining first-phase parameters as

$$
\alpha_0=y_0=1.
$$

The resulting state contains no new participant randomness and cannot be
finalized as the first-phase output.

### 5.2 The first phase

Contributor $i$ in the first phase samples independent shares

$$
(r_{\alpha,i},r_{y,i})\in(\mathbb F^*)^2
$$

and multiplies a component of $\alpha$-degree $k$ and $y$-degree $b$ by
$r_{\alpha,i}^kr_{y,i}^b$. The contributor proves the update relation
$\mathcal R_1$ defined in Section 7 without publishing either scalar. A
nonempty chain of valid updates produces the circuit-independent encoded setup
material for

$$
\alpha=\prod_i r_{\alpha,i},
\qquad
y=\prod_i r_{y,i}.
$$

The value $x=\tau$ remains unchanged. The security analysis
separately requires an honest update for both contributed parameters.

### 5.3 Circuit specialization and the second phase

The deterministic algorithm $\mathsf{Specialize}$ evaluates the setup
polynomials fixed by $\mathcal L$ as public linear combinations of the
first-phase encodings. It initializes $\gamma=\delta=\eta=1$, including both
direct terms and terms divided by one of those parameters. Contributor $i$ in
the second phase samples nonzero shares
$(r_{\gamma,i},r_{\delta,i},r_{\eta,i})$ and scales each specialized term by the
corresponding direct or inverse powers. The contributor proves the update
relation $\mathcal R_2$ defined in Section 8. A nonempty valid chain completes
the CRS; the security analysis again requires at least one honest update.

### 5.4 What verification establishes

The predicate $\mathsf{VerifySRS}$ first verifies the source sequence and its
capacity, then recomputes $\mathsf{Prepare}_x$ and $\mathsf{Specialize}$, verifies
every proof for $\mathcal R_1$ and $\mathcal R_2$ in order, and checks that the
claimed final CRS is the last second-phase state. It rejects an empty update
chain in either phase. These checks establish a well-formed source,
deterministic public transformations, valid sequential updates, preservation of
unaffected terms, and agreement with the final CRS. They do not establish
unpredictable sampling, secrecy, erasure, or update knowledge soundness.

### 5.5 Comparison with prior two-phase protocols

| Prior protocols [3, 5] | Tokamak protocol | Comparison |
|---|---|---|
| Circuit-independent setup in the first phase | A selected univariate sequence supplies the $x$ encodings, and the first phase independently contributes to $\alpha$ and $y$ | All circuit-independent material is complete before specialization, but Tokamak combines an external result with a Tokamak-specific contribution period. |
| Public specialization to one circuit | Deterministic specialization from selected first-phase points and the canonical subcircuit-library QAP/R1CS description | The public computation has the same role, but Tokamak fixes a reusable subcircuit library rather than one later-derived circuit. |
| Circuit-dependent updates in the second phase | The second phase updates direct and divided elements involving $\gamma$, $\delta$, and $\eta$ | The purpose is the same, but Tokamak uses different parameters and equations. |
| Sequential updates and public verification | Proofs of the contributor's shares, checks that fixed elements did not change, and verification of the complete ordered update record | The verification purpose is the same; Sections 7--9 define Tokamak's update relations and acceptance predicate. |
| At least one honest contribution in each phase | Each finalized Tokamak phase has a nonempty valid update record; security additionally assumes an honest update in each protected component, including the source history | The trust structure is analogous at a high level, but the verifier cannot establish these secrecy assumptions and the proofs in [3, 5] do not cover Tokamak's exact construction. |
| Reusable first-phase material | A verified source sequence supplies the $x$ encodings before Tokamak contributions to $\alpha$ and $y$ | Tokamak reuses one dimension of an external result and independently generates the remaining dimensions required by its setup. |

The verified output of the first phase is specialized to the canonical
subcircuit library, only the remaining hidden parameters are updated in the
second phase, and the final CRS is derived from the selected states. The
predicate $\mathsf{VerifySRS}$ checks the public transformations and update
relations. Security still depends on secret erasure and is limited by the proof
gaps stated above.

## 6. Algebraic Compatibility of Univariate Encoded Powers

For $g\in\{1,2\}$, let

$$
\mathcal U_g=(U_{g,d})_{d=0}^{D_g}
\qquad\text{with}\qquad
U_{g,d}=[\tau^d]_g
$$

for one hidden $\tau\in\mathbb F^*$. The complete public source input consists
of $\mathcal U=(\mathcal U_1,\mathcal U_2)$ and the source ceremony's public
record $Q_{\mathrm{src}}$. The predicate
$\mathsf{VerifySource}(\mathcal U,Q_{\mathrm{src}})$ is the public verification
relation specified by that ceremony. It must establish that the accepted
sequences use the declared groups and have the common-power form above over
their declared ranges. Any additional public elements in the source record
remain part of the adversary's view even when the transformation does not use
them.

The deterministic transformation
$\mathsf{Prepare}_x(\Lambda,\mathcal U)$ first requires

$$
D_g\geq d_g^\star
\qquad\text{for each }g\in\{1,2\}.
$$

It then evaluates every basis polynomial from Section 3.2 using only source
powers:

$$
E_{g,k,b,j}^{(0)}
=
\sum_{a\in\operatorname{supp}P_{g,k,b,j}}
p_{g,k,b,j,a}U_{g,a}
=
[P_{g,k,b,j}(x)]_g,
$$

where

$$
P_{g,k,b,j}(X)
=
\sum_a p_{g,k,b,j,a}X^a
$$

and $x=\tau$. The prepared state assigns no second or third target parameter to
a power of $\tau$; instead it represents

$$
\alpha_0=y_0=1.
$$

For every admitted library and target term, the definition of
$\mathcal V_{g,k,b}$ supplies public coefficients
$c_{g,t,k,b,j}(\mathcal L)$ such that

$$
F_{g,t;k,b}(X;\mathcal L)
=
\sum_{j=1}^{r_{g,k,b}}
c_{g,t,k,b,j}(\mathcal L)P_{g,k,b,j}(X).
$$

After the first phase has independently generated $\alpha$ and $y$, public
specialization can therefore compute

$$
[F_{g,t}(\alpha,x,y;\mathcal L)]_g
=
\sum_{(k,b)\in\mathcal D_g(\Lambda)}
\sum_{j=1}^{r_{g,k,b}}
c_{g,t,k,b,j}(\mathcal L)
[\alpha^ky^bP_{g,k,b,j}(x)]_g.
$$

The source transformation thus uses a univariate sequence only for the
$x$-polynomial dimension. It does not impose a relation between $x$, $\alpha$,
and $y$. Algebraic independence of the three final hidden values does not by
itself prove security, however, because the public states needed to perform the
updates may expose more group elements than the CRS analyzed in [6]. Sections 7
and 10 make that separate issue explicit.

## 7. The First Phase: Contributions Before Circuit Specialization

A first-phase state

$$
S_1=(\Lambda,\mathcal U,\mathbf E)
$$

contains the fixed public parameters, the selected source sequence, and exactly
the specialization-basis elements

$$
\mathbf E=
\left(E_{g,k,b,j}\right)_{
  g\in\{1,2\},
  (k,b)\in\mathcal D_g(\Lambda),
  1\leq j\leq r_{g,k,b}},
$$

where state $i$ has the algebraic meaning

$$
E_{g,k,b,j}^{(i)}
=
[\alpha_i^ky_i^bP_{g,k,b,j}(x)]_g.
$$

The prepared state $S_1^{(0)}$ contains the elements defined in Section 6, with
$\alpha_0=y_0=1$. For two first-phase states with the same $\Lambda$ and
$\mathcal U$, define

$$
\mathcal R_1(S_1,S_1';r_\alpha,r_y)=1
$$

if and only if $(r_\alpha,r_y)\in(\mathbb F^*)^2$ and

$$
E_{g,k,b,j}'
=
r_\alpha^kr_y^bE_{g,k,b,j}
$$

for every indexed element. The source and $x$ remain unchanged.

The public contribution proof fixes the group elements available outside the
states. Let

$$
\mathcal D(\Lambda)
=
\mathcal D_1(\Lambda)\cup\mathcal D_2(\Lambda)
$$

and let its downward closure be

$$
\widehat{\mathcal D}(\Lambda)
=
\left\{
(u,v):
0\leq u\leq k,\ 0\leq v\leq b
\text{ for some }(k,b)\in\mathcal D(\Lambda)
\right\}.
$$

For contribution $i$, the proof publishes the share-factor encodings

$$
W_{g,u,v}^{(i)}
=
[r_{\alpha,i}^ur_{y,i}^v]_g,
\qquad
g\in\{1,2\},
(u,v)\in\widehat{\mathcal D}(\Lambda)\setminus\{(0,0)\},
$$

together with two Schnorr commitments in $G_1$ and their scalar responses [34].
The Fiat--Shamir challenge binds $\Lambda$, the source, the complete ordered
pair of states, every $W_{g,u,v}^{(i)}$, and both commitments [35]. The Schnorr equations
prove knowledge of the scalars represented by $W_{1,1,0}^{(i)}$ and
$W_{1,0,1}^{(i)}$. Cross-group pairing equations bind the corresponding
$G_1$ and $G_2$ encodings.

Concretely, the contributor samples masks
$s_{\alpha,i},s_{y,i}\in\mathbb F$, publishes

$$
C_{\alpha,i}=[s_{\alpha,i}]_1,
\qquad
C_{y,i}=[s_{y,i}]_1,
$$

derives the challenge $c_i$ from the bound transcript, and returns

$$
z_{\alpha,i}=s_{\alpha,i}+c_ir_{\alpha,i},
\qquad
z_{y,i}=s_{y,i}+c_ir_{y,i}.
$$

The verifier checks

$$
\begin{aligned}
[z_{\alpha,i}]_1
&=C_{\alpha,i}+c_iW_{1,1,0}^{(i)},\\
[z_{y,i}]_1
&=C_{y,i}+c_iW_{1,0,1}^{(i)},\\
e(W_{1,u,v}^{(i)},[1]_2)
&=e([1]_1,W_{2,u,v}^{(i)})
\end{aligned}
$$

for every published factor pair. Define
$W_{g,0,0}^{(i)}=[1]_g$ without transmitting another element.
The verifier also rejects $W_{g,1,0}^{(i)}$ or $W_{g,0,1}^{(i)}$ at the group
identity, enforcing nonzero contribution shares.

Starting from the public generators at $(0,0)$, the verifier checks the factor
table by the recurrences

$$
\begin{aligned}
e(W_{1,u,v}^{(i)},W_{2,1,0}^{(i)})
&=e(W_{1,u+1,v}^{(i)},[1]_2),\\
e(W_{1,u,v}^{(i)},W_{2,0,1}^{(i)})
&=e(W_{1,u,v+1}^{(i)},[1]_2),
\end{aligned}
$$

whenever the displayed indices belong to
$\widehat{\mathcal D}(\Lambda)$. It then verifies every state transition with

$$
\begin{aligned}
e(E_{1,k,b,j}',[1]_2)
&=e(E_{1,k,b,j},W_{2,k,b}^{(i)}),\\
e([1]_1,E_{2,k,b,j}')
&=e(W_{1,k,b}^{(i)},E_{2,k,b,j}).
\end{aligned}
$$

These checks give one transparent interface for applying the same two shares to
every affected component. All state elements, factor encodings, Schnorr
commitments, responses, and transcript challenges remain public and are part of
the adversary's input.

After $c_1$ valid updates,

$$
E_{g,k,b,j}^{(c_1)}
=
\left[
\left(\prod_{i=1}^{c_1}r_{\alpha,i}\right)^k
\left(\prod_{i=1}^{c_1}r_{y,i}\right)^b
P_{g,k,b,j}(x)
\right]_g.
$$

The last state is eligible for public finalization of the first phase when
$c_1\geq1$ and every proof in the ordered record $Q_1$ verifies. The aggregate
scalars remain hidden; public validity does not establish their unpredictability
or erasure.

The basis above is the minimum specialization material for this transparent
linear-update interface. To see why, consider the action of an arbitrary share
pair on a polynomial component:

$$
A^kY^bP(X)
\longmapsto
r_\alpha^kr_y^bA^kY^bP(X).
$$

Components with different pairs $(k,b)$ have different update factors. A later
contributor who knows neither $\alpha$ nor $y$ cannot update a sum of such
components for arbitrary independent shares unless the corresponding
homogeneous components are separately available. Within one pair $(k,b)$, all
elements scale by the same factor, so any basis of
$\mathcal V_{g,k,b}(\Lambda)$ is sufficient and fewer than
$r_{g,k,b}$ elements cannot span every required specialization polynomial.
Consequently, the state contains exactly

$$
\sum_{g\in\{1,2\}}
\sum_{(k,b)\in\mathcal D_g(\Lambda)}
r_{g,k,b}
$$

specialization-basis elements, up to an invertible change of basis within each
$(g,k,b)$ block. A full family
$([\alpha^kx^ay^b]_g)_{k,a,b}$ is unnecessary unless the monomials $X^a$
are themselves a basis of the corresponding spaces.

The factor encodings are additional verification material rather than
specialization material. For the recurrence checks fixed above,
$\widehat{\mathcal D}(\Lambda)$ is the smallest downward-closed set containing
every update factor used by a state transition. This is a minimality statement
for the stated transparent verification method, not for every possible
zero-knowledge or secure-computation realization. Section 10 analyzes the
complete public span of both the state basis and this verification material.

## 8. Circuit Specialization and the Second Phase

Let $\mathcal J_g(\Lambda)$ index the CRS terms in $G_g$ specified by the setup
of [6, Section 3.3]. Before encoding, each term can be written as

$$
C_{g,t}(\alpha,x,y,\gamma,\delta,\eta)
=
F_{g,t}(\alpha,x,y;\mathcal L)
\gamma^{u_{\gamma,t}}
\delta^{u_{\delta,t}}
\eta^{u_{\eta,t}},
\qquad t\in\mathcal J_g(\Lambda),
$$

where $F_{g,t}$ is the public polynomial determined by the subcircuit library
and

$$
\mathbf u_t=(u_{\gamma,t},u_{\delta,t},u_{\eta,t})\in\mathbb Z^3
$$

records the direct, inverse, or absent occurrence of each second-phase
parameter in that CRS term. The index sets, polynomials, and exponent labels are
those of the CRS in [6, Section 3.3]. This notation collects those existing
terms; it does not define a different CRS.

The deterministic algorithm
$\mathsf{Specialize}(\Lambda,S_1^{(c_1)})$ evaluates each
$F_{g,t}$ as a linear combination of the encodings in the finalized
first-phase state and initializes

$$
\gamma=\delta=\eta=1.
$$

For example, if $f(X)=\sum_a f_aX^a$ and
$L_i(Y)=\sum_b\ell_{i,b}Y^b$, then [6]

$$
[L_i(y)f(x)]_1
  = \sum_{a,b} \ell_{i,b}f_a[x^a y^b]_1,
$$

where the coefficients are public. Specialization therefore requires no hidden
scalar.

A second-phase state

$$
S_2=(\Lambda,\mathcal U,S_1^{(c_1)},\widehat{\mathbf C})
$$

contains the fixed public inputs, the finalized first-phase state, and the
specialized encodings

$$
\widehat{\mathbf C}=
(\widehat C_{g,t})_{g\in\{1,2\},\,t\in\mathcal J_g(\Lambda)},
\qquad
\widehat C_{g,t}=[C_{g,t}]_g.
$$

For two such states with identical public inputs and identical finalized
first-phase state, define

$$
\mathcal R_2(S_2,S_2';r_\gamma,r_\delta,r_\eta)=1
$$

if and only if $(r_\gamma,r_\delta,r_\eta)\in(\mathbb F^*)^3$ and

$$
\widehat C_{g,t}'=
r_\gamma^{u_{\gamma,t}}
r_\delta^{u_{\delta,t}}
r_\eta^{u_{\eta,t}}\widehat C_{g,t}
$$

for every $g$ and $t$. This equation updates direct and divided terms and
preserves terms whose exponent vector is zero. Contributor $i$ samples
$(r_{\gamma,i},r_{\delta,i},r_{\eta,i})$, computes the successor, and publishes
a proof $\rho_2^{(i)}$ of knowledge of those shares for the exact ordered state
pair.

After $c_2$ valid updates, the encoded terms equal the CRS expressions in [6]
with

$$
\gamma=\prod_{i=1}^{c_2}r_{\gamma,i},
\qquad
\delta=\prod_{i=1}^{c_2}r_{\delta,i},
\qquad
\eta=\prod_{i=1}^{c_2}r_{\eta,i}.
$$

The last state is eligible for public finalization when $c_2\geq1$ and every
proof in the ordered record $Q_2$ verifies.

## 9. Verification, Transcript, and Final CRS

Let $\mathsf{VerifyUpdate}_j$ be the deterministic verifier for $\Pi_j$. Its
public statement contains the phase number, $\Lambda$, the source sequence, the
preceding state, and the successor state. For the second phase it also contains
the finalized first-phase state. The proof system must be complete and a proof
of knowledge for $\mathcal R_j$ in the random-oracle model used by
[5, Sections 3 and 5.2].

The public predicate

$$
\mathsf{VerifySRS}
(\Lambda,\mathcal U,Q_{\mathrm{src}},Q_1,Q_2,\sigma)
$$

returns $1$ exactly when all of the following checks succeed:

1. $\Lambda$ defines finite sets $\mathcal D_g(\Lambda)$,
   $\mathcal A_g(\Lambda)$, and $\mathcal J_g(\Lambda)$ and finite-dimensional
   spaces $\mathcal V_{g,k,b}(\Lambda)$, and
   $\mathsf{VerifySource}(\mathcal U,Q_{\mathrm{src}})=1$.
2. The source uses the field and groups fixed by $\Lambda$, and
   $D_g\geq d_g^\star$ for $g\in\{1,2\}$.
3. The first record has length $c_1\geq1$, its first preceding state is
   $\mathsf{Prepare}_x(\Lambda,\mathcal U)$, adjacent entries name the same
   intermediate state, and every $\rho_1^{(i)}$ is accepted by
   $\mathsf{VerifyUpdate}_1$ for $\mathcal R_1$.
4. The second record has length $c_2\geq1$, its first preceding state is
   $\mathsf{Specialize}(\Lambda,S_1^{(c_1)})$, adjacent entries name the same
   intermediate state, and every $\rho_2^{(i)}$ is accepted by
   $\mathsf{VerifyUpdate}_2$ for $\mathcal R_2$.
5. The claimed final CRS $\sigma$ is exactly the collection of CRS elements
   indexed by $\mathcal J_g(\Lambda)$ in the last second-phase state.

The ordered public record is

$$
Q=(Q_{\mathrm{src}},Q_1,Q_2).
$$

Recomputing both deterministic transformations and verifying each ordered
state pair binds the final CRS to the source, the public subcircuit library, and
every accepted update. The predicate does not decide whether any accepted
update was honest. That condition belongs to the update-knowledge-soundness
game described in Section 3.5.

The security statement is parameterized by $\lambda$ and the bit length
$|\Lambda|$ of the public relation description. Admissible instances satisfy

$$
D_1+D_2+
\sum_{g,k,b}r_{g,k,b}
+|\mathcal J_1|+|\mathcal J_2|+c_1+c_2
\leq \operatorname{poly}(\lambda+|\Lambda|).
$$

The source record, update proofs, and complete public transcript also have
polynomial length. The formal degrees produced by the source substitution and
the verifier equations, and the number of group-oracle queries made by the
adversary and extractor, are bounded by
$\operatorname{poly}(\lambda+|\Lambda|)$. These conditions make the public
input and generic-group bad-event bound asymptotically meaningful; finiteness
alone is not sufficient.

## 10. Trust and Security Analysis

### 10.1 Security objective and assumptions

The target property is update knowledge soundness in the ceremonial game
described in Section 3.5 [5, Definition 5]. The source history, the first phase,
and the second phase are the protected setup components in this instantiation.
The desired conclusion is that, after an honest update in each component, an
efficient generic-group adversary that observes and participates in the entire
ceremony cannot produce an accepted final proof without enabling extraction of
a valid witness, except with negligible probability.

This objective assumes that the source satisfies its stated group and update
conditions, that at least one update in every protected component uses an
independently unpredictable nonzero share that remains undisclosed and is
erased, and that the group and hash primitives meet their stated security
assumptions. The update-proof arguments cited from [5] operate in the
random-oracle model. Public transition verification establishes none of the
randomness, non-disclosure, or erasure assumptions.

### 10.2 Result of applying the cited model

The attempted application of the cited model stops before witness extraction.
Jang and Judd's affine prover strategy restricts every prover-supplied $G_1$
element to the span of their CRS [6, Definition 6 and Equation 79]. The protocol
considered here gives the adversary a larger span: it retains the complete
public source sequence, every homogeneous first-phase component, and every
public update-proof element. Polynomial size bounds the generic-group collision
event only after the resulting formal identities have been shown to imply
witness extraction.

The first unresolved direction appears in the binding step. Let
$f(X)=X^ht_n(X)$ be one of the nonzero correction polynomials in the
$\alpha^3$ family of the Jang--Judd CRS [6, Section 3.3]. The first-phase
interface contains $[\alpha^3f(x)]_1$, while the source powers allow public
construction of $[f(x)]_1$. A prover can therefore make the
challenge-independent changes

$$
\Delta U=\alpha^3f(x),
\qquad
\Delta B=-f(x).
$$

Their contribution to the binding polynomial cancels identically [6, Equations
81 and 84]:

$$
\alpha\Delta U+\alpha^4\Delta B=0.
$$

This direction does not use an algebraic relation between $x$, $\alpha$, and
$y$; it arises because sequential independent updates require the public state
to separate components with different $\alpha$- and $y$-degrees. The direction
is not globally verifier-null because $U$ participates in the arithmetic
identity while $B$ does not have the same role. The analysis has not normalized
it into the original affine strategy or extended it to an accepting proof for a
false statement. It is therefore an unclassified, potentially witness-changing
direction rather than a completed attack.

No theorem in [3, 5, 6] proves that the remaining verifier identities eliminate
every additional solution introduced by this public interface, and [5, Theorem
5] concerns Groth16 rather than Tokamak's verifier equations. Honest updates and
successful $\mathsf{VerifySRS}$ checks establish the stated setup history and
transition relations, but they do not remove earlier public states from the
adversary's view. The available evidence therefore proves neither update
knowledge soundness nor its failure for the completed construction.

### 10.3 Honest updates and public verification

An honest update in each protected component is the trust premise of the
adopted game. One contributor can supply such an update if its share meets the
required randomness, secrecy, and erasure conditions. Additional contributors
provide redundancy against compromise, while use of the same contributor in
multiple components concentrates the operational risk. If every share
protecting any component is known, the honest-update premise for that component
is absent and the target security conclusion cannot be invoked.

Public transition and transcript verification establish that accepted updates,
fixed material, public inputs, and the ordered ceremony record are mutually
consistent [14]. A malicious contributor may nevertheless use predictable
randomness or retain a share, and an operator may censor, delay, withhold, or
choose among otherwise valid chains. These actions are not disproved by
identity metadata, receipt labels, hashes, or pairing checks. The checks retain
their integrity and provenance meaning even when the honest-update premise is
not satisfied; they do not replace that premise or resolve the extraction gap in
Section 10.2.

## 11. Limitations

The source supplies only $x$, while the first phase generates $\alpha$ and $y$
from independent contributor products. This avoids deriving multiple target
parameters from one source scalar. However, the transparent sequential update
interface exposes homogeneous components that are not separately available in
the CRS analyzed by [6]. The cited extraction proof has not been extended to
this larger public affine basis. Consequently, this document does not claim
update knowledge soundness or production security for the completed CRS, and it
does not claim that an attack has been established.

The analysis also does not characterize security after the honest-update
premise fails. It makes no component-specific forgery claim and does not infer
that any unproved security property is preserved. The protocol's selection
policy requires a qualifying receipt in each Tokamak phase, but a receipt label
does not prove unpredictable sampling, non-disclosure, or erasure. Multiple
identities, independent organizations, hardware isolation, and public
attestations are not protocol requirements.

Finally, storing data under SHA-256 digests of its contents, using a specified
byte encoding, checking pairing equations, and rechecking the transcript all
depend on correct cryptographic primitives and implementation. They protect the
integrity and recorded origin of the artifacts, not confidentiality, erasure,
fairness, censorship resistance, or long-term availability.

## 12. Implementation Correspondence

The protocol is identified as `tokamak-mpc-2phase-v1`. The implementation uses
`Phase 1` and `Phase 2` as serialized phase identifiers. `Phase 2` covers both
deterministic circuit preparation and the contribution period that follows it.
The implementation records the parameters that each contribution must update in
phase-specific contribution profiles. The selected first-phase `UniversalTau`
state is consumed by the specialization and second-phase contribution
implementation [14].

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

Completed ceremonies have produced reusable first-phase results, extended
earlier verified results, or reused first-phase material in circuit-specific
ceremonies [9–13]. More recent research explores decentralized, asynchronous,
and lower-cost powers-of-tau execution [17–19]. These works motivate reuse and
improve ceremony operation, but candidate selection still requires the curve,
degree, and algebraic compatibility analysis in Section 4.

## 14. Conclusion

The protocol starts from a verified sequence of univariate encoded powers that
supplies only the $x$-polynomial dimension. Contributors in the first phase
independently generate $\alpha$ and $y$. Public computation then specializes
the resulting homogeneous polynomial components to the subcircuit library, and
the second phase contributes to $\gamma$, $\delta$, and $\eta$.

A longer univariate powers-of-tau sequence cannot replace the independent
contributions to $\alpha$ and $y$ merely by assigning several target parameters
to different powers of the same hidden value. Such an assignment changes the
multivariate opening argument even when its exponent range is sufficient and
its bounded monomials do not collide.

Public verification provides reproducible evidence about the source artifact,
contribution equations, the canonical subcircuit library, links between states,
and final artifacts. Security also requires at least one unpredictable share in
each phase to remain unknown and be erased. Failure of that condition removes
the honest-contributor premise used by [3, 5], but it does not invalidate
verification of unrelated public data or automatically reveal every other
trapdoor.

The cited analyses do not prove knowledge soundness for the complete public
interface needed to update Tokamak's six setup parameters. In particular,
separating components by their $\alpha$- and $y$-degrees introduces an
unclassified direction in the Jang--Judd binding argument. The protocol must
therefore be evaluated through the public verification guarantees, trust
assumptions, and proof limitation stated here, not by assuming that an existing
ceremony proof applies unchanged.

## 15. References

1. Jens Groth, [*On the Size of Pairing-Based Non-interactive Arguments*](https://doi.org/10.1007/978-3-662-49896-5_11), EUROCRYPT 2016.
2. Sean Bowe, Ariel Gabizon, and Matthew Green, [*A Multi-party Protocol for Constructing the Public Parameters of the Pinocchio zk-SNARK*](https://doi.org/10.1007/978-3-662-58820-8_5), Financial Cryptography Workshops 2018 proceedings.
3. Sean Bowe, Ariel Gabizon, and Ian Miers, [*Scalable Multi-party Computation for zk-SNARK Parameters in the Random Beacon Model*](https://eprint.iacr.org/2017/1050), IACR ePrint 2017/1050.
4. Jens Groth, Markulf Kohlweiss, Mary Maller, Sarah Meiklejohn, and Ian Miers, [*Updatable and Universal Common Reference Strings with Applications to zk-SNARKs*](https://doi.org/10.1007/978-3-319-96878-0_24), CRYPTO 2018.
5. Markulf Kohlweiss, Mary Maller, Janno Siim, and Mikhail Volkhov, [*Snarky Ceremonies*](https://doi.org/10.1007/978-3-030-92078-4_4), ASIACRYPT 2021.
6. Jehyuk Jang and Jamie Judd, [*An Efficient SNARK for Field-Programmable and RAM Circuits*](https://eprint.iacr.org/2024/507), IACR ePrint 2024/507, revised 2025.
7. Aniket Kate, Gregory M. Zaverucha, and Ian Goldberg, [*Constant-Size Commitments to Polynomials and Their Applications*](https://doi.org/10.1007/978-3-642-17373-8_11), ASIACRYPT 2010.
8. Mary Maller, Sean Bowe, Markulf Kohlweiss, and Sarah Meiklejohn, [*Sonic: Zero-Knowledge SNARKs from Linear-Size Universal and Updateable Structured Reference Strings*](https://doi.org/10.1145/3319535.3339817), ACM CCS 2019.
9. Dusk Network, [*Trusted setup for BLS12-381*](https://github.com/dusk-network/trusted-setup), official ceremony repository, and [the ceremony's powers-of-tau implementation](https://github.com/dusk-network/powersoftau/blob/5429415959175082207fd61c10319e47a6b56e87/src/lib.rs#L56-L64), which fixes the group-specific sequence lengths.
10. Zcash Foundation, [*Powers of Tau attestations*](https://github.com/ZcashFoundation/powersoftau-attestations), official ceremony repository.
11. Ethereum Foundation, [*KZG Powers of Tau ceremony specifications*](https://github.com/ethereum/kzg-ceremony-specs) and [public transcript](https://github.com/ethereum/kzg-ceremony), official repositories.
12. Privacy & Scaling Explorations, [*Perpetual Powers of Tau*](https://github.com/privacy-ethereum/perpetualpowersoftau), official ceremony repository, including [the official contribution command over `bn128`](https://github.com/privacy-ethereum/perpetualpowersoftau/blob/b077232729db7c9eb65b63c4aaaa0ac4a1b0bba2/snarkjs_instructions.md#L39-L47).
13. Filecoin Project, [*Phase 2 attestations*](https://github.com/filecoin-project/phase2-attestations), official ceremony repository; Ariel Gabizon, [*Perpetual Powers of Tau for BLS12-381*](https://github.com/arielgabizon/perpetualpowersoftau), phase-one ceremony records linked by the Filecoin repository; and the ceremony implementation defining [the BLS12-381 exponent](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/small_bls12_381/mod.rs#L27-L39) and [the corresponding group-specific sequence lengths](https://github.com/arielgabizon/powersoftau/blob/2bd49903bac07485fe23e5ef1a2d5fa19561977b/src/parameters.rs#L25-L40).
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
33. Georg Fuchsbauer, Eike Kiltz, and Julian Loss, [*The Algebraic Group Model and its Applications*](https://doi.org/10.1007/978-3-319-96881-0_2), CRYPTO 2018.
34. Claus-Peter Schnorr, [*Efficient Identification and Signatures for Smart Cards*](https://doi.org/10.1007/0-387-34805-0_22), CRYPTO 1989 proceedings.
35. Amos Fiat and Adi Shamir, [*How to Prove Yourself: Practical Solutions to Identification and Signature Problems*](https://doi.org/10.1007/3-540-47721-7_12), CRYPTO 1986 proceedings.
