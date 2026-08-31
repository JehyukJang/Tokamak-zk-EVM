# Target Two-Phase MPC Protocol Contract

## Status and audience

This is the normative implementation contract for maintainers and reviewers of
the Tokamak zk-EVM MPC setup. It describes the target two-phase protocol. Code
that still samples or serializes a public scalar `y`, treats the Dusk source as
a completed Tokamak phase, or uses the legacy `SigmaV2` accumulator does not
yet implement this contract.

The final `Sigma` formulas and the four-file final CRS archive remain stable.
The ceremony state, receipt, and provenance formats are intentionally new and
reject legacy intermediates.

## Protocol overview

The protocol has two ceremony phases. Dusk adaptation is a verified source
transformation outside the ceremony.

```text
Native:
  Phase1.InitializeUniversalTau
  -> Phase1.Contribute(NativeAlphaXY)+
  -> Phase2.PrepareCircuit
  -> Phase2.Contribute(CircuitGammaDeltaEta)+
  -> FinalCRS

Dusk-backed:
  AdaptDuskTau
  -> Phase1.PrepareFromAdaptedTau
  -> Phase1.Contribute(DuskY)+
  -> Phase2.PrepareCircuit
  -> Phase2.Contribute(CircuitGammaDeltaEta)+
  -> FinalCRS
```

`+` requires at least one `random` or `hybrid` receipt. `beacon` and `testing`
transitions may be verified, but do not satisfy that selection requirement.
The Dusk adaptor creates no Tokamak contribution receipt and does not satisfy
the Dusk-backed Phase 1 requirement.

## Notation and checked setup shape

Let:

- `n` be the number of constraints per subcircuit;
- `l` be the number of public wires;
- `l_D` be the number of interface wires;
- `m_i = l_D - l` be the number of intermediate wires;
- `m_D` be the total number of wires;
- `s = s_max` be the maximum placement count;
- `N = max(n, m_i)`.

The setup is valid only when `l_D >= l`, `n`, `m_i`, and `s` are nonzero powers
of two, and every derived length below passes checked `usize` arithmetic.
`l` may be zero or a power of two as required by the existing setup validator.

Trapdoor symbols are `alpha`, `x`, `y`, `gamma`, `delta`, and `eta`. The
notation `[f]_1` and `[f]_2` denotes the G1 and G2 encodings of scalar or
polynomial evaluation `f`.

## Authoritative monomial layout

One `MonomialLayout` derived from the checked setup shape is the only authority
for allocation, chunking, validation, and documentation.

```text
xGridLen       = 2 * N
yGridLen       = 2 * s
alphaMax       = 4
alphaXMax      = max(2 * N, n + 2, m_i + 1)
alphaYMax      = max(2 * s - 1, s + 2)
```

The inclusive maxima and half-open stored ranges are:

| Family | Stored exponents | Purpose |
|---|---|---|
| `x` | `0 <= a < xGridLen` | Final `xy_powers` and plain-X MSMs |
| `y` | `0 <= b <= alphaYMax` | Y grid and `y^i(y^s-1)` corrections |
| `alpha` | `0 <= k <= 4` | Wire and vanishing terms |
| `alpha_x` | `1 <= k <= 4`, `0 <= a <= alphaXMax` | A/B/C, K, and X-vanishing terms |
| `xy` | `0 <= a < xGridLen`, `0 <= b < yGridLen` | Final bivariate CRS grid |
| `alpha_xy_abc` | `1 <= k <= 3`, `0 <= a < n`, `0 <= b < s` | A/B/C wire commitments with secret Y |
| `alpha4_xy_k` | `k = 4`, `0 <= a < m_i`, `0 <= b < s` | Intermediate K-polynomial commitments |
| `alpha_y` | `1 <= k <= 4`, `0 <= b <= alphaYMax` | Y-vanishing corrections |

The `xy` family has exactly `xGridLen * yGridLen` points in row-major order,
with flat index `a * yGridLen + b`. The specialized mixed families are not
silently padded to a larger rectangle. Their declared shapes and ordering are
part of the layout digest.

The `alphaXMax` bound covers the existing correction formulas
`alpha^k x^h(x^n-1)` for `k=1..3`, `h=0..2`, and
`alpha^4 x^j(x^m_i-1)` for `j=0..1`. The `alphaYMax` bound covers
`alpha^k y^i(y^s-1)` for `k=1..4`, `i=0..2`, including the small valid domains
`s=1` and `s=2` where `2*s` alone is insufficient.

## Dusk adaptor

The Dusk adaptor downloads or reads the pinned Dusk Groth16 powers-of-tau
artifact, verifies the exact source SHA-256, decodes the supported raw format,
checks required G1/G2 sequences, and maps plain Dusk tau powers into the
Tokamak alpha/X basis.

For `N = max(n, m_i)`, the mapping is:

```text
x                 = dusk_tau
alpha^k           = dusk_tau^(2 * N * k), 1 <= k <= 4
alpha^k * x^a     = dusk_tau^(2 * N * k + a)
```

The adaptor must prove that every requested exponent is within the verified
Dusk ranges. It does not use the Dusk Groth16 alpha or beta families. Its
output is an `AdaptedTau` document, not a ceremony state, contribution, or
receipt.

Mapping version 1 commits `N`, the alpha, X, and alpha-X bounds, the `2 * N`
omega stride, and the exact maximum Dusk G1/G2 exponents consumed by those
bounds. Changing any mapping input therefore changes the canonical adaptor
manifest.

## Phase 1 universal tau

Both routes output the same typed `UniversalTau` payload and canonical chunk
order. Source provenance may differ, but Phase 2 must not branch on the point
layout or cryptographic operations.

### Native initialization and contribution

Native initialization materializes the full layout with conceptual
`alpha = x = y = 1`. The genesis is not selectable.

Each `NativeAlphaXY` contributor samples independent nonzero shares
`rho_alpha`, `rho_x`, and `rho_y` and applies:

```text
[alpha^k]                 *= rho_alpha^k
[x^a]                     *= rho_x^a
[y^b]                     *= rho_y^b
[alpha^k x^a]             *= rho_alpha^k * rho_x^a
[x^a y^b]                 *= rho_x^a * rho_y^b
[alpha^k y^b]             *= rho_alpha^k * rho_y^b
[alpha^k x^a y^b]         *= rho_alpha^k * rho_x^a * rho_y^b
```

Every required G1 and G2 encoding follows the same share. Verification binds
all three proofs and all affected families to one previous-state digest.

### Dusk-backed preparation and contribution

`PrepareFromAdaptedTau` copies the verified alpha/X bases, constructs the
Y-dependent families at conceptual `y = 1`, and emits a `prepared` Phase 1
state with profile `DuskY`. It is deterministic and creates no secret.

Each `DuskY` contributor samples a nonzero `rho_y`, updates every Y-indexed
family by the corresponding power, updates `[y]_2`, and leaves every adapted
alpha/X-only family byte-for-byte immutable. A contributed state is invalid if
`[y^s]_1 = [1]_1`. The prepared genesis is never selectable.

### Phase 1 selection

Selection requires a fully verified chain and at least one `random` or
`hybrid` receipt for its bound profile. Native and Dusk-backed outputs expose
the same `UniversalTau` accessors. A selected state remains immutable; Phase 2
records its digest instead of creating a separately signed `finalize` state.

## Phase 2 circuit preparation

Phase 2 accepts only a selected `UniversalTau`. Native versus Dusk provenance
is retained for the transcript but cannot select a different circuit
preparation implementation.

Preparation binds the canonical `subcircuitLibrary.sourceDigest`, reads the
concrete R1CS/QAP inputs, and constructs circuit-specific points with group
MSMs. It never obtains scalar `alpha`, `x`, or `y`.

For wire polynomial `o_j(X)`, helper `K_j(X)`, and Y-domain Lagrange polynomial
`L_i(Y)`, representative constructions are:

```text
[L_i(y) o_j(x)]_1
  = sum_(a,b) l_(i,b) o_(j,a) [x^a y^b]_1

[L_i(y) alpha^4 K_j(x)]_1
  = sum_(a,b) l_(i,b) k_(j,a) [alpha^4 x^a y^b]_1

[alpha^k y^i (y^s - 1)]_1
  = [alpha^k y^(i+s)]_1 - [alpha^k y^i]_1
```

Preparation initializes direct encodings of `gamma`, `delta`, and `eta` to the
group generators and leaves inverse-dependent families unscaled. It emits a
`prepared` Phase 2 state with profile `CircuitGammaDeltaEta`.

## Phase 2 contribution and final output

Each contributor samples independent nonzero `rho_gamma`, `rho_delta`, and
`rho_eta`. Direct encodings scale by the positive share. Every family whose
formula contains an inverse parameter scales by the matching inverse share.
All other Phase 1 and circuit-bound material is immutable.

Final CRS generation requires a verified Phase 2 chain with at least one
`random` or `hybrid` receipt. It records the selected Phase 2 digest and emits
the existing final `Sigma` formulas:

- `Sigma1.xy_powers[a,b] = [x^a y^b]_1` for
  `0 <= a < 2*N`, `0 <= b < 2*s`;
- the existing public, intermediate, and private wire blocks;
- the existing X- and Y-vanishing correction blocks;
- direct G1/G2 encodings for the required trapdoors;
- the existing `lagrange_KL` boundary term.

The final archive contains exactly:

- `combined_sigma.rkyv`;
- `sigma_preprocess.rkyv`;
- `sigma_verify.json`;
- `crs_provenance.json`.

Every final field has the following Phase 1 dependency path:

| Final field or block | Phase 1 families used before Phase 2 scaling |
|---|---|
| `Sigma1.x`, `Sigma2.x` | `x`, including the required G2 encoding |
| `Sigma1.y`, `Sigma2.y` | `y`, including the required G2 encoding |
| `Sigma2.alpha` through `alpha4` | `alpha` G2 encodings |
| `Sigma1.xy_powers` | `xy` |
| `gamma_inv_o_inst` | `alpha_xy_abc` for A/B/C and plain `x` for M |
| `eta_inv_li_o_inter_alpha4_kj` | `alpha_xy_abc` and `alpha4_xy_k` |
| `delta_inv_li_o_prv` | `alpha_xy_abc` |
| `delta_inv_alphak_xh_tx` | `alpha_x` at `h` and `n+h` |
| `delta_inv_alpha4_xj_tx` | `alpha_x` at `j` and `m_i+j` |
| `delta_inv_alphak_yi_ty` | `alpha_y` at `i` and `s+i` |
| `lagrange_KL` | `xy` over `0 <= a < m_i`, `0 <= b < s` |
| direct `gamma`, `delta`, `eta` encodings | Phase 2 generators; no Phase 1 monomial dependency |

Phase 2 applies the matching positive or inverse parameter share after these
circuit-specific values have been constructed.

## State and receipt combinations

Only these combinations are valid:

| Phase | Profile | Status | Secret proofs |
|---|---|---|---:|
| Phase 1 | `NativeAlphaXY` | `genesis` | 0 |
| Phase 1 | `NativeAlphaXY` | `contributed` | 3 |
| Phase 1 | `DuskY` | `prepared` | 0 |
| Phase 1 | `DuskY` | `contributed` | 1 |
| Phase 2 | `CircuitGammaDeltaEta` | `prepared` | 0 |
| Phase 2 | `CircuitGammaDeltaEta` | `contributed` | 3 |

The previous state fixes the profile. A CLI argument or serialized receipt
cannot override it.

## Versioned serialization contract

The first protocol version is `tokamak-mpc-2phase-v1`; every document has
`contractVersion: 1`. The `documentKind` field is the format magic and is one
of:

- `tokamakAdaptedTau`;
- `tokamakCeremonyState`;
- `tokamakContributionReceipt`;
- `tokamakCeremonyTranscript`.

Manifests and receipts use canonical UTF-8 JSON:

- lower-camel-case property names in the declared struct order;
- no insignificant whitespace;
- decimal integers without leading zeroes;
- lowercase enum strings fixed by the contract;
- lowercase `sha256:` digests with exactly 64 hexadecimal digits;
- absent optional values encoded as JSON `null`, not omitted;
- unknown, missing, duplicated, or reordered properties rejected before
  digest validation.

Point chunks contain only canonical compressed BLS12-381 point encodings in
the order declared by their descriptor. A descriptor binds family, group,
shape, start indexes, point count, byte length, encoding identifier, and chunk
SHA-256. Infinity is forbidden except where a specific payload invariant
explicitly permits it; no current universal-tau family permits it.

Chunk files are content-addressed. Their file name is the lowercase hexadecimal
part of the descriptor's `sha256` value followed by `.points`; file paths are
therefore derived from authenticated content and are not a second manifest
authority.

The state digest is SHA-256 over the canonical state manifest bytes. The
receipt digest is SHA-256 over the canonical receipt bytes. Chunk digests are
SHA-256 over exact chunk bytes. A manifest binds chunks by descriptor and
digest rather than embedding large point arrays.

## Digest and replay domains

`capacityDigest` is SHA-256 over a canonical manifest containing only checked
setup dimensions and protocol capacity fields. `layoutDigest` is SHA-256 over
the canonical `MonomialLayout`. Phase 2 `circuitDigest` is exactly the existing
canonical `subcircuitLibrary.sourceDigest`.

Every proof transcript binds, in fixed order:

1. protocol and contract versions;
2. ceremony identifier;
3. phase and contribution profile;
4. previous and current state digests;
5. capacity, layout, and nullable circuit digests;
6. contributor sequence;
7. parameter label and contribution encodings.

The canonical ceremony transcript lists the adaptor manifest when applicable,
all selected state and receipt digests, entropy modes, qualifying counts,
source provenance, capacity/layout identity, and circuit identity. Its
SHA-256 is written to final provenance as `ceremonyTranscriptSha256` alongside
`ceremonyProtocolVersion`.

## Legacy rejection

The following are incompatible inputs and must fail before curve work:

- legacy `phase1_acc_*` alpha/X-only accumulators;
- legacy `phase1_proof_*` receipts;
- legacy `SigmaV2` and `phase2_acc_*` intermediates;
- manifests without the new document kind, contract version, protocol version,
  contribution profile, and digest domains.

No implicit converter or fallback is permitted. Native ceremonies restart
from a new genesis. Dusk-backed ceremonies rerun the adaptor and Phase 1.

## Security-claim boundary

This contract defines mechanics and validation, not the final public statement
of the trust model. Public claims about retained toxic waste, malicious
parameter selection, and the exact guarantee supplied by an honest contributor
remain gated on the separate literature-backed security review. No such claim
may be inferred solely from a transition passing this contract's checks.
