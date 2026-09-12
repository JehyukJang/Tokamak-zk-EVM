# Current-protocol phase 2: derivation checkpoint

## Audience and status

For engineers and cryptographic reviewers implementing the Filecoin-backed
Tokamak MPC replacement. This is a design-gate record, not an executable
ceremony specification or a security certification. The final CRS is defined
by the current Tokamak manuscript and backend/common contracts. References
are maintained in the [MPC README](../README.md#phase-2-references).

The Filecoin family mapping is identified. The phase 2 contribution protocol
is not yet approved: the reference delta-only update does not cover changing
Tokamak's packed wire weights, and its contribution evidence has a different
public view. No production adapter or contribution kernel has been added at
this checkpoint. Dusk retirement remains required, not completed.

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
argument. A different contribution proof or an explicitly reviewed public-view
extension is needed before production implementation.

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
| Packed nonpublic and free-public queries | Inverse-delta scaling plus selection correction | Additional construction needed |
| Unscaled fixed-public queries | Add `(v_j-1)[r_j T_p]_1` | Additional construction needed |

Choosing all r_j publicly or leaving them under one initializer's control
would change the stated independent-secret requirements. It is not an
implementation shortcut authorized by this plan.

## Evidence and continuation gate

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

Before implementing the affected kernels, decide whether the design may
extend the ceremony's public view, followed by a security analysis of that
extension, or must preserve the existing view and use a different contribution
construction. The latter preserves the current protocol boundary but still
needs a derivation; feasibility and cost are not established here. The former
does not become safe solely by citing the Groth16 references. No change to
the manuscript, final CRS or contribution security assumptions is made by
this checkpoint.
