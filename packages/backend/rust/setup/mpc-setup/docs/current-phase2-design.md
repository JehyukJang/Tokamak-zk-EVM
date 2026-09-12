# Current-protocol phase 2: derivation checkpoint

## Audience and status

For engineers and cryptographic reviewers implementing the Filecoin-backed
Tokamak MPC replacement. This is a design-gate record, not an executable
ceremony specification or a security certification. The final CRS is defined
by the current Tokamak manuscript and backend/common contracts. References
are maintained in the [MPC README](../README.md#phase-2-references).

The Filecoin family mapping is identified. Intermediate public encodings may
be extended to support separate wire-weight and delta updates. Security
analysis of that extension is deferred, not an implementation gate. The
public-point update and consistency equations below have a test-only model;
the production adapter, contribution receipt and knowledge proof are not yet
implemented. Dusk retirement remains required, not completed.

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
This checks the header/layout candidate, not the full challenge digest,
subgroups, power relations, or contribution history. No full source SHA-256
or independently verified source ceremony is claimed. Decoding must validate
the upstream point encoding before converting to common affine bytes.

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
| Imported tau/tagged sequences and ordinary preprocess powers | Unchanged | Source mapping identified |
| Weighted helper for wire j | Multiply by v_j | Direct identity |
| Inverse-delta masking queries | Multiply by u^-1 | Reference-style identity |
| `[delta]_2` | Multiply by u | Direct identity; knowledge/chain proof still needed |
| Packed nonpublic and free-public queries | Inverse-delta scaling plus selection correction | Intermediate equations below |
| Unscaled fixed-public queries | Add `(v_j-1)[r_j T_p]_1` | Intermediate equations below |

Choosing all r_j publicly or leaving them under one initializer's control
would change the stated independent-secret requirements. It is not an
implementation shortcut authorized by this plan.

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
  and an independently contributed weight for each wire index j.

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
and wire index; a receipt for another transition or wire must not be reused.
The concrete receipt encoding and proof implementation remain P15.3 work,
not completed by this test model. Do not reuse the old gamma/delta/eta proof
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

## Evidence and implementation status

`tests/current_phase2_derivation.rs` checks the source size/capacity arithmetic,
the probed generator coordinates, the delta-only reference identity and two successive weight/delta updates
using deliberately known test scalars and BLS12-381 G1 points. It checks that
both naive scaling approaches fail and that the correction identity agrees
with the direct oracle, including fixed queries, helpers and masks. Supplying
the missing summand from known scalars in a test is not an MPC algorithm.

The normal package test command currently fails while compiling old MPC
imports of the removed `FinalMpcCrsProvenance` API in `drive_upload.rs` and
`flows/final_artifacts.rs`. These are existing replacement work, not a reason
to restore the legacy provenance contract. An isolated harness can execute
the algebra tests without that old production library; its result must not
be reported as a successful MPC package build. On 2026-09-12, all four tests
passed in an isolated release harness using arkworks 0.5.0. This is not source
ceremony verification, proof-of-knowledge verification, or SNARK E2E.

The additional public-point model initializes from encoded images and applies
two contributions using only each participant's own shares. The oracle alone
tracks the cumulative scalars for comparison. It checks both weighted-helper
ranges, all nine masks, free/nonpublic and fixed queries, and cumulative
roles. Negative cases modify every mutable point family, substitute a wire's
share, reverse a transition and provide zero shares. These tests check
unbatched pairing identities, not receipt authentication or knowledge proofs.
After adding those cases, all six tests passed in the isolated release
harness on 2026-09-12 (0.27 seconds for the test run, excluding compilation).

## Future work: cryptographic security analysis

Analyze the complete exposure from the original Filecoin ceremony, the
separated correction points, cumulative encodings and contribution proofs.
Establish which assumptions and extraction arguments apply to this Tokamak
extension. That analysis is explicitly deferred and does not block current
implementation. Do not report equation tests, a successful SNARK E2E, source
hash verification or the Groth16 citation as completing it. Release eligibility
and production ceremony operation are separate decisions, not granted here.
