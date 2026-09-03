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
circuit-independent setup. Contributors then add the independent polynomial
dimension required by Tokamak's bivariate relations. After a public computation
binds that material to the canonical subcircuit library, contributors update the
remaining circuit-dependent parameters.

The implementation verifies source artifacts, contribution equations, data
that a contribution must not change, the canonical subcircuit library, links
between successive states, and final artifacts [14]. Those checks do not prove the
quality of participant randomness or deletion of participant secrets. The
security analyses in [3, 5] require at least one contributor in each phase to
choose an unpredictable secret and erase it. Those analyses do not cover
Tokamak's exact six-parameter construction or the algebraic relation between
two parameters derived from one source scalar, so the security claims below are
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
The first phase completes the reusable circuit-independent setup material; after
public specialization to the committed subcircuit library, the second phase
completes the CRS. This document analyzes the protocol's public verification
guarantees, trust assumptions, and unresolved proof limitation; it does not
claim knowledge soundness for the exact source-derived construction.

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
intermediate, private, and vanishing-polynomial relations [6]. The implementation
retains those meanings. In particular, $\gamma$, $\delta$, and $\eta$ are scalars
with both direct encodings and circuit-dependent elements divided by the
corresponding scalar; they are not “inverse-only” parameters.

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
ceremony, or withhold an artifact, but cannot make an inconsistent transition
satisfy the implemented public checks. Conversely, those checks cannot establish
that a contributor used unpredictable randomness, kept it private, or erased
it. Contributor names and device metadata do not make a contribution valid
[14].

### 3.2 Algebraic setting and notation

The circuit-independent setup material contains the required $G_1$ and $G_2$
encodings of the following pure and mixed monomials:

$$
\begin{aligned}
&[\alpha^k],\ [x^a],\ [y^b], \\
&[\alpha^k x^a],\ [\alpha^k y^b],\ [x^a y^b], \\
&[\alpha^k x^a y^b].
\end{aligned}
$$

The group subscript is omitted in this display. The index ranges are those
required by the CRS for Tokamak's SNARK and the monomial layout specified by
the implementation contract; not every group contains every monomial. The
detailed ranges and serialized order remain in that contract [14].

A participant's share for a scalar $z$ is written $r_z$. Sequential
contributions replace $z$ by $z\prod_i r_{z,i}$. Public group elements are
updated directly; the scalar is never serialized. Circuit specialization is the
deterministic group computation that combines the selected first-phase output
with the canonical subcircuit-library description to construct
circuit-dependent group elements. It fixes that library, not one circuit later
derived from the library.

### 3.3 Setup parameters and stages

The division shown below follows the order in [3, 5]; the assignment of the six
parameters follows the CRS defined in [6] and the implementation [14].

| Parameter | Role in the setup of Tokamak's SNARK | Source or Tokamak stage | Participant procedure | Security assumption |
|---|---|---|---|---|
| $\alpha$ | Powers mixed with wire and correction encodings | Selected univariate sequence | Selecting the required powers introduces no new $\alpha$ share | At least one source contribution protecting $\tau$ was unpredictable, remained undisclosed, and was erased |
| $x$ | Evaluation dimension for subcircuit and wire polynomials | Selected univariate sequence | Selecting the required powers introduces no new $x$ share | The source condition stated for $\alpha$ holds |
| $y$ | Placement dimension and bivariate mixing | First phase | Each contributor erases its $y$ share after completing the contribution | At least one accepted $y$ share was unpredictable, remained undisclosed, and was erased |
| $\gamma$ | Direct encodings and public-instance elements divided by $\gamma$ | Second phase | Each contributor erases its $\gamma$ share after completing the contribution | At least one accepted $\gamma$ share was unpredictable, remained undisclosed, and was erased |
| $\delta$ | Direct encodings and private and correction elements divided by $\delta$ | Second phase | Each contributor erases its $\delta$ share after completing the contribution | At least one accepted $\delta$ share was unpredictable, remained undisclosed, and was erased |
| $\eta$ | Direct encodings and intermediate elements divided by $\eta$ | Second phase | Each contributor erases its $\eta$ share after completing the contribution | At least one accepted $\eta$ share was unpredictable, remained undisclosed, and was erased |

The first phase finishes the circuit-independent monomial encodings. Preparation
for the second phase is the first step that reads the concrete rank-1 constraint
system (R1CS) and quadratic arithmetic program (QAP) coefficients and binds the
canonical digest of the subcircuit library. Contributions in the second phase
then update only the three scalars used by the circuit-dependent elements.
Reading only the degree and placement limits before this point does not fix the
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
records its digest; it adds no signer or secret [14].

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
the source ceremony as a Tokamak phase: the implemented protocol still has the
two contribution periods defined above. The honest-update premise applies to
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
specifications [3, 6, 7, 9–15].

### 4.1 Exponent capacity

Exponent capacity asks whether each source group contains every encoded power
consumed by the target construction. The two groups must be checked separately;
a longer sequence in $G_1$ cannot replace a missing power in $G_2$.

For the current tracked setup, the public-wire count is $l=396$, the
interface-wire count is $l_D=1{,}420$, the number of constraints per subcircuit
is $n=1{,}024$, and the maximum placement count is
$s=s_{\max}=256$. Therefore, $m_i=l_D-l=1{,}024$ and
$N=\max(n,m_i)=1{,}024$ [15]. The checked source mapping requires powers
through exponent $10{,}240$ in $G_1$ and exponent $8{,}192$ in $G_2$ [14].
These are formula-derived repository values, not performance measurements.

Capacity can also be evaluated for a construction that is not algebraically
valid. For comparison, a collision-free assignment of the bounded
$\alpha$-, $x$-, and $y$-monomials to one scalar can use
$e_y=2{,}048$ and $e_\alpha=1{,}048{,}576$. For
$0\leq a<2{,}048$, $0\leq b<512$, and $0\leq k\leq4$, the largest mapped
exponent is $5{,}242{,}879$ in $G_1$, while the corresponding $G_2$ requirement
reaches exponent $4{,}194{,}304$ [6, 14, 15]. These bounds show only that the
monomials fit within a finite univariate sequence; they do not establish
algebraic compatibility.

### 4.2 Curve compatibility

Curve compatibility requires the source sequence and Tokamak's SNARK to use the
same scalar field and pairing groups. Encodings over another curve cannot be
transferred into the BLS12-381 groups used here without changing the
cryptographic setting [6, 14]. A curve match does not establish exponent
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

| Public result | Curve compatibility | Exponent capacity | Algebraic compatibility | Screening result |
|---|---|---|---|---|
| Privacy & Scaling Explorations' Perpetual Powers of Tau [12] | Fails: BN254 rather than BLS12-381 | Passes: up to $2^{28}$ constraints and $2\cdot2^{28}-1$ powers | Not evaluated after the curve mismatch | Excluded by the curve requirement |
| Ethereum KZG ceremony [11] | Passes: BLS12-381 | Fails: the largest sequence ends at $G_1$ exponent $2^{15}-1$, and each $G_2$ sequence ends at exponent $64$ | Its four sequences are separately univariate and contain no mixed terms | Excluded by the $G_2$ requirement |
| Dusk trusted setup [9] | Passes: BLS12-381 | Passes: powers through $2^{21}$ cover the current requirements | Conditional: the proposed first phase supplies the missing independent dimension, but the remaining source-derived relation requires a security argument for the completed construction | Selected source; security admission remains pending |
| Filecoin phase 1 [13] | Passes: BLS12-381 | Passes: supports circuits through $2^{27}$ constraints and generates $2\cdot2^{27}-1$ powers | Conditional: its univariate structure does not by itself supply Tokamak's bivariate setup | Not excluded by source screening, but not selected or added as a protocol route |

The survey leaves two sequences conditionally eligible at the source-screening
level. The implementation selects the Dusk result; this policy choice is not a
claim that the other sequence fails algebraically or that the selected mapping
is secure. Section 6 defines how the protocol uses the selected sequence while
retaining an independently contributed polynomial variable. Section 10 decides
whether the completed construction meets the security objective in Section 3.5.
For the current construction, it identifies an unresolved proof obligation and
retains an explicit limitation.

## 5. Protocol Overview

### 5.1 From univariate encoded powers to Tokamak's setup

The protocol takes a selected sequence of univariate encoded powers, the public
bounds that determine Tokamak's required monomials, and the canonical
subcircuit-library description. Before contributions begin, public computation
selects the source powers needed for the $\alpha$- and $x$-dependent terms and
forms the initial $y$-dependent terms at $y=1$. This prepared state contains no
new participant randomness and cannot be selected as the first-phase output.

### 5.2 The first phase

Contributors in the first phase update $y$ and every encoding that contains it
while leaving the source-derived $\alpha$ and $x$ elements unchanged. The public
state consists of the resulting encoded elements and their ordered update
record; it never contains a contributor's scalar share. The first-phase output
is selected only from a complete verified update chain containing a qualifying
participant contribution. Security separately assumes that at least one update
to this component was honest in the sense required by Section 3.5. The selected
output is the circuit-independent encoded setup material in Tokamak's required
monomial layout.

### 5.3 Circuit specialization and the second phase

Public deterministic specialization binds the canonical subcircuit library by
forming public linear combinations of the group elements produced in the first
phase; it never recovers $\alpha$, $x$, or $y$. It initializes direct encodings
of $\gamma$, $\delta$, and $\eta$ and
the circuit-dependent elements that will be divided by those scalars.
Contributors in the second phase multiply the direct encodings by their shares
and the divided elements by the inverse shares. The public specialization state
cannot be selected as the final output. Selection requires a complete verified
second-phase chain containing a qualifying participant contribution, while the
security objective separately requires an honest update to this component. The
selected result is converted to the unchanged CRS layout of Tokamak's SNARK.

### 5.4 What verification establishes

Public verification establishes that each accepted state is a valid update of
its predecessor, that material outside the declared update remains unchanged,
that the transition is bound to the relevant source or subcircuit-library
input, and that the selected states belong to one complete ordered record [14].
These checks establish transition consistency, not the unpredictability,
secrecy, or erasure required by an honest update. They also do not by themselves
establish update knowledge soundness for Tokamak's exact construction.

### 5.5 Comparison with prior two-phase protocols

| Prior protocols [3, 5] | Tokamak protocol | Comparison |
|---|---|---|
| Circuit-independent setup in the first phase | A selected univariate sequence supplies the $\alpha$ and $x$ encodings, and the first phase adds independent contributions to $y$ | All circuit-independent material is complete before specialization, but Tokamak combines an external result with a Tokamak-specific contribution period. |
| Public specialization to one circuit | Deterministic specialization from selected first-phase points and the canonical subcircuit-library QAP/R1CS description | The public computation has the same role, but Tokamak fixes a reusable subcircuit library rather than one later-derived circuit. |
| Circuit-dependent updates in the second phase | The second phase updates direct and divided elements involving $\gamma$, $\delta$, and $\eta$ | The purpose is the same, but Tokamak uses different parameters and equations. |
| Sequential updates and public verification | Proofs of the contributor's shares, pairing checks, checks that fixed elements did not change, and verification of the complete sequence | The verification purpose is the same; Tokamak defines its own stored states and receipts. |
| At least one honest contribution in each phase | Selection requires a qualifying receipt in each Tokamak phase; security additionally assumes an honest update in each protected component, including the source history | The trust structure is analogous at a high level, but the verifier cannot establish these secrecy assumptions and the proofs in [3, 5] do not cover Tokamak's exact construction. |
| Reusable first-phase material | A verified source sequence supplies the $\alpha$ and $x$ encodings before Tokamak contributions to $y$ | Tokamak reuses one part of an external result and adds an independent dimension required by its bivariate setup. |

The verified output of the first phase is specialized to the canonical
subcircuit library, only the remaining hidden parameters are updated in the
second phase, and the final CRS is derived from the selected states. The
implementation checks the public computations and stored data. Its security
still depends on secret erasure and is limited by the proof gaps stated above.

## 6. Algebraic Compatibility of Univariate Encoded Powers

Let $\tau$ be the hidden scalar of a selected powers-of-tau sequence. Its source
ceremony publishes group encodings $[\tau^d]_1$ and $[\tau^d]_2$ over stated
exponent ranges while leaving $\tau$ unknown [3, 7]. This is a univariate
sequence of encoded powers.
Tokamak's circuit-independent setup instead requires encodings of monomials in
three parameters. For index sets $I_1$ and $I_2$ determined by the setup, the
required families have the form

$$
\mathcal{T}_g
=
\left\{[\alpha^k x^a y^b]_g:(k,a,b)\in I_g\right\},
\qquad g\in\{1,2\}.
$$

Compatibility must be evaluated against the complete public view in the
ceremonial game adopted in Section 3.5, rather than only against the powers
selected for the target basis. Jang and Judd's extractor distinguishes the
independent polynomial variables that occur in its verifier equations [6,
Appendix D]. A source transformation is therefore admissible only if those
distinctions, and hence the extraction argument, remain valid in the presence of
all public source and ceremony data. Assigning a distinct source exponent to
each required monomial establishes representation capacity, but not this
security condition. Section 4.3 gives the corresponding failure when both
polynomial variables are derived as fixed powers of one source scalar.

Let $N=\max(n,m_i)$. For the current construction, the substitution includes
[14]

$$
\Psi(X)=\tau, \qquad \Psi(A)=\tau^{2N}, \qquad \Psi(Y)=Y.
$$

The image therefore retains two polynomial variables, $\tau$ and $Y$, rather
than collapsing both polynomial dimensions into $\mathbb{F}[\tau]$.
Consequently, for each required exponent pair $(k,a)$ and
each available source group $G_g$,

$$
[\alpha^k x^a]_g=[\tau^{2Nk+a}]_g, \qquad g\in\{1,2\}.
$$

The source sequence can therefore supply the slice with $b=0$ by selecting the
encoded power at exponent $2Nk+a$. The remaining slices initially repeat that
encoding, which represents $y=1$:

$$
E_{g,k,a,b}^{(0)}=[\tau^{2Nk+a}]_g.
$$

If the first-phase contributors provide secret shares
$r_1,\ldots,r_c$, write $E_{g,k,a,b}^{(i)}$ for the encoded group element after
contributor $i$. That contributor updates an element with $y$-degree $b$
according to

$$
E_{g,k,a,b}^{(i)}=r_i^b E_{g,k,a,b}^{(i-1)}.
$$

After all contributions, the element is

$$
E_{g,k,a,b}^{(c)}
=
\left[\tau^{2Nk+a}\left(\prod_{i=1}^{c}r_i\right)^b\right]_g
=
[\alpha^k x^a y^b]_g,
\qquad
y=\prod_{i=1}^{c}r_i.
$$

Thus $y$ is contributed independently of $\tau$, rather than being assigned a
fixed relation $y=x^{e_y}$. This resolves the incompatibility that would arise
from deriving both polynomial variables from one powers-of-tau scalar. It does
not establish complete algebraic compatibility with the independently sampled
setup in [6]: the assignment still imposes $\alpha=x^{2N}$. The cited analyses
do not establish whether this remaining relation can create an accepting
relation outside the independently sampled model. Sections 10 and 11 state the
resulting proof limitation.

## 7. The First Phase: Contributions Before Circuit Specialization

For contribution $i$, the only new share is $r_{y,i}$. Every encoded monomial
of degree $b$ in $y$ is multiplied by $r_{y,i}^b$, while elements containing
only $\alpha$ and $x$ remain unchanged. Public verification checks both the
declared update and preservation of the source-derived material. No operator
generates or learns the resulting scalar $y$ [14].

The selected state from the first phase must terminate a complete verified chain
and include a qualifying participant contribution. It provides the required
monomial families to the specialization computation, while its group-element
values and ordered record retain the effects and origin of the accepted
contributions [14].

## 8. Circuit Specialization and the Second Phase

Given the selected points from the first phase and the canonical subcircuit-
library description, deterministic specialization constructs circuit-dependent
encodings by linear group operations. For
$f(X)=\sum_a f_aX^a$ and a Lagrange polynomial
$L_i(Y)=\sum_b\ell_{i,b}Y^b$ over the placement variable, one representative
identity is [6, 14]

$$
[L_i(y)f(x)]_1
  = \sum_{a,b} \ell_{i,b}f_a[x^a y^b]_1,
$$

where $f_a$ and $\ell_{i,b}$ are public coefficients. Because the coefficients
are public, specialization needs no scalar trapdoor. The resulting state is
bound to the selected first-phase output and the canonical subcircuit library.
It initializes the circuit-dependent component before any contributor supplies
the hidden values updated in the second phase.

Each contributor in the second phase samples independent nonzero shares
$r_{\gamma,i}$, $r_{\delta,i}$, and $r_{\eta,i}$. For each group $G_g$ in which
it occurs, a direct encoding $[z]_g$ is multiplied by $r_{z,i}$, while every
encoding $[F/z]_g$ of a circuit-dependent scalar expression is multiplied by
$r_{z,i}^{-1}$. Elements fixed in the first phase or by circuit specialization
must not change. After the sequence, each hidden scalar updated in the second
phase is the product of its accepted shares [14].

## 9. Verification, Transcript, and Final CRS

Each secret share has public $G_1$ and $G_2$ encodings and a proof, bound to the
transcript, that the contributor knows the share. Direct checks tie the first
powers to those encodings. Batched pairing equations check the remaining powers
and elements that contain multiple scalars. Verification of the first phase also
checks that every element containing only $\alpha$ and $x$ remains unchanged. The
second-phase check verifies both direct multiplication by a share and
multiplication by its inverse where required [14].

Each proof is bound to its phase, predecessor and successor states, declared
update, and relevant public inputs. These bindings prevent an otherwise valid
proof from being replayed in a different state chain, phase, or specialization
context. The implementation contract defines the exact bound fields [14].

Each state is authenticated by its contents, and each transition names its
predecessor. Verification recomputes every transition and phase selection rather
than treating an external index as authority. The transcript records the source,
the ordered updates and selected state in each phase, and the canonical
subcircuit library. Finalization reconstructs that record, accepts only a
qualifying selected second-phase state, and binds the final artifacts to the
transcript [14].

Hashes and pairing checks establish integrity within their assumptions. They do
not show that a participant's local entropy was unpredictable, that no copy of a
share exists, or that an artifact will remain available.

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

The reviewed results do not establish update knowledge soundness for the
completed Tokamak CRS. Jang and Judd's setup samples the six trapdoors
independently, and their generic-group extraction argument separates the
corresponding formal variables [6, Equation 21 and Appendix D]. The source
transformation used here instead sets $x=\tau$ and $\alpha=\tau^{2N}$. It
therefore imposes an algebraic relation between variables that the cited
extraction argument treats as independent, while the adversary also retains the
complete public source sequence in its view.

No theorem in [3, 5, 6] shows that this related-parameter setup can be reduced to
the independently sampled setup analyzed in [6], nor does the Groth16 result in
[5, Theorem 5] cover Tokamak's verifier equations. Distinct source exponents
and valid public transitions establish representation and consistency, but do
not supply the missing extraction argument. This is an unresolved proof
obligation, not a demonstrated attack: the available evidence proves neither
update knowledge soundness nor its failure for the completed construction.

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

The first phase supplies a polynomial dimension independently of the source and
therefore avoids deriving both polynomial variables from one source scalar.
However, the source transformation still relates two setup parameters that [6]
samples independently. The cited extraction proof has not been extended to
this distribution and the reviewed ceremonial results do not provide the
missing reduction. Consequently, this document does not claim update knowledge
soundness or production security for the completed source-derived CRS, and it
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

Tokamak implements a two-phase MPC for Tokamak's SNARK. The protocol starts from
a verified sequence of univariate encoded powers before contributors add the
independent $y$ dimension. It then specializes the resulting monomial families
to the canonical subcircuit library and uses the second phase for contributions
to $\gamma$, $\delta$, and $\eta$.

A longer univariate powers-of-tau sequence cannot replace the independent $y$
contributions merely by assigning $x$ and $y$ to different powers of the same
hidden value. Such an assignment changes the bivariate opening argument even
when its exponent range is sufficient and its bounded monomials do not collide.

Public verification provides reproducible evidence about the source artifact,
contribution equations, the canonical subcircuit library, links between states,
and final artifacts. Security also requires at least one unpredictable share in
each phase to remain unknown and be erased. Failure of that condition removes
the honest-contributor premise used by [3, 5], but it does not invalidate
verification of unrelated public data or automatically reveal every other
trapdoor.

The cited analyses do not prove the exact six-parameter MPC for Tokamak's SNARK,
including the relationship between $\alpha$ and $x$ introduced by the source
mapping. The protocol must therefore be evaluated through the public
verification guarantees, trust assumptions, and proof limitation stated here,
not by assuming that an existing ceremony proof applies unchanged.

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
13. Filecoin Project, [*Phase 2 attestations*](https://github.com/filecoin-project/phase2-attestations), official ceremony repository, and Ariel Gabizon, [*Perpetual Powers of Tau for BLS12-381*](https://github.com/arielgabizon/perpetualpowersoftau), phase-one ceremony records linked by the Filecoin repository.
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
