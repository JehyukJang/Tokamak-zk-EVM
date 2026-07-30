# Prove4 Derived Difference Evaluations

## Decision Status

Candidate 2C is integrated in production commit `6c132c3d8`. The project owner
superseded the historical standalone rejection because the optimization
removes two full polynomial evaluations algebraically. Exact parity, fresh
verification, and the production CPU timing gate passed.

## Source And Environment

- Production baseline: `20eaf778e`
- Isolated experiment: `a23f4e86b`
- Candidate owner: `Prover::prove4`
- Current benchmark backend: ICICLE CPU fallback
- Primary metric: end-to-end `total_wall`
- Experiment isolation: detached worktree

## Candidate Boundary

Prove4 constructs and retains:

```text
r_D1 = r - r_omegaX
r_D2 = r - r_omegaX_omegaY
```

These polynomials are required later by the `LHS_zk1` and `LHS_zk2`
expressions, so Candidate 2C does not remove their construction.

The current implementation also evaluates both difference polynomials at
`(chi, zeta)`, even though it has already computed:

```text
small_r_eval
small_r_omegaX_eval
small_r_omegaX_omegaY_eval
```

By linearity of polynomial evaluation:

```text
r_D1_eval = small_r_eval - small_r_omegaX_eval
r_D2_eval = small_r_eval - small_r_omegaX_omegaY_eval
```

The candidate replaces only the two full-grid difference-polynomial
evaluations with these scalar subtractions.

## Current Cost

The canonical CPU timing table at baseline `855f0348a` records:

| operation | time |
| --- | ---: |
| `poly.eval.prove4.r_D1` | 0.146065 s |
| `poly.eval.prove4.r_D2` | 0.146350 s |
| combined removable boundary | 0.292415 s |

The candidate removes two polynomial evaluations without adding allocation,
coefficient traversal, transfer, or dispatcher calls. The retained
difference-polynomial construction and downstream expressions are unchanged.

## Correctness Gates

The isolated experiment must establish exact scalar equality between:

- direct evaluation of `r - r_omegaX` and the corresponding evaluation
  difference;
- direct evaluation of `r - r_omegaX_omegaY` and the corresponding evaluation
  difference.

Focused tests must cover zero, constant, X-only, Y-only, sparse, dense, and
representative shapes with zero, one, negative-one, and random evaluation
points and scale values.

The full fixture must compare the complete Legacy and Candidate `Proof4`
outputs exactly. A fresh candidate proof must pass the existing verifier.

## Benchmark Protocol

The detached experiment will provide Legacy, Candidate, and Parity modes only
inside the isolated worktree.

After warming both measured paths, collect at least five alternating E2E runs
using the same release binary, source revision, fixture, CRS, ICICLE backend,
and timing instrumentation. Report:

- every `total_wall` sample;
- mean, median, range, and paired delta;
- `prove4.total`;
- the two removed Legacy evaluation spans;
- the Candidate scalar-derivation span;
- movement in unchanged neighboring stages.

The candidate qualifies for project-owner review only if exact parity and
fresh verification pass and the E2E improvement exceeds observed noise. No
production integration may begin without explicit project-owner approval.

## Isolated Implementation

The detached experiment added Legacy, Candidate, and Parity modes. Legacy
performed the two existing full-grid evaluations. Candidate derived both
scalars with two field subtractions. Parity executed both paths and asserted
exact equality before returning the Candidate values.

This candidate adds no custom CPU implementation, active-device branch,
dispatcher wrapper, allocation, or fallback. It is backend neutral because it
removes two evaluations without replacing them with a backend operation.

## Correctness Results

The focused exact-equality test passed for:

- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense polynomials;
- 64-by-16 and representative 4096-by-256 shapes;
- zero, one, negative-one, and nontrivial scale values;
- zero, one, negative-one, and nontrivial evaluation points.

The complete release timing fixture passed in Parity mode. A fresh preprocess
artifact and Candidate-only proof were then generated from matching inputs.
The existing verifier returned `true`.

The relevant commands were:

```text
cargo test --release -p prove --lib derived_difference_evaluations_match_polynomial_differences -- --nocapture
TOKAMAK_PROVE4_DERIVED_EVAL_EXPERIMENT=parity ... cargo test --release -p prove --features timing --test timing timing_prove_stages -- --nocapture
cargo run --release -p preprocess -- ...
TOKAMAK_PROVE4_DERIVED_EVAL_EXPERIMENT=candidate cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
```

## End-To-End Benchmark

Legacy and Candidate were warmed once before measurement. Five measured pairs
used this alternating order:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

Every run used experiment commit `a23f4e86b`, the same release timing binary,
fixture, CRS, ICICLE CPU backend, and output location.

| pair | Legacy `total_wall` | Candidate `total_wall` | Legacy minus Candidate |
| ---: | ---: | ---: | ---: |
| 1 | 37.214711 s | 36.872588 s | 0.342123 s |
| 2 | 36.970704 s | 37.120908 s | -0.150204 s |
| 3 | 37.093146 s | 37.644209 s | -0.551064 s |
| 4 | 37.006404 s | 36.904430 s | 0.101974 s |
| 5 | 37.317808 s | 37.010359 s | 0.307449 s |

| statistic | Legacy | Candidate | Legacy minus Candidate |
| --- | ---: | ---: | ---: |
| mean | 37.120554 s | 37.110499 s | 0.010056 s (0.027%) |
| median | 37.093146 s | 37.010359 s | 0.101974 s paired median |
| minimum | 36.970704 s | 36.872588 s | -0.551064 s |
| maximum | 37.317808 s | 37.644209 s | 0.342123 s |
| range | 0.347104 s | 0.771621 s | 0.893186 s |

The paired improvements had:

- mean: 0.010056 seconds;
- sample standard deviation: 0.370033 seconds;
- 95% Student-t interval: -0.449401 to 0.469513 seconds.

The interval includes zero by a wide margin. Three pairs favored Candidate and
two favored Legacy.

## Supporting Attribution

| boundary | Legacy mean | Candidate mean | Legacy minus Candidate |
| --- | ---: | ---: | ---: |
| `poly.eval.prove4.r_D1` | 0.148109 s | removed | |
| `poly.eval.prove4.r_D2` | 0.146503 s | removed | |
| combined replaced boundary | 0.294612 s | 0.000000217 s | 0.294612 s |
| `prove4.total` | 8.763035 s | 8.505434 s | 0.257601 s |

The paired `prove4.total` improvement had a 95% interval of 0.152002 to
0.363200 seconds, so the intended local reduction is reproducible. The mean
prove4 reduction recovered 87.437% of the directly removed evaluation time.

Unchanged stages moved as follows:

| stage | Legacy mean | Candidate mean | Legacy minus Candidate |
| --- | ---: | ---: | ---: |
| init | 4.607443 s | 4.620622 s | -0.013179 s |
| prove0 | 9.011372 s | 9.032090 s | -0.020719 s |
| prove1 | 1.995477 s | 2.003858 s | -0.008380 s |
| prove2 | 12.099248 s | 12.304358 s | -0.205110 s |
| prove3 | 0.633330 s | 0.633811 s | -0.000481 s |

Candidate pair 3 had a 12.783413-second `prove2.total`, producing a
0.704135-second paired regression in an unchanged stage. This explains much of
the E2E variance, but excluding that sample after observing it would invalidate
the predefined benchmark. The complete five-pair result must therefore remain
the decision evidence.

## Historical Standalone Decision

Candidate 2C is rejected. Its algebra, exact parity, fresh verification, and
local prove4 saving are established, but the primary E2E `total_wall`
improvement is only 0.027% and its confidence interval does not exclude either
a material regression or improvement.

The scalar-derivation path must not enter production as part of this
optimization campaign. The detached experiment and its ignored raw timing
artifacts were removed after the project-owner decision.

## Superseding Production Decision

The consolidated July decision superseded the standalone performance
rejection. The project owner approved every backend-independent algebraic work
reduction, including Candidate 2C, and directed production integration after
Candidate 2D was removed.

Production retains the materialized `r_D1` and `r_D2` polynomials required by
the later `LHS_zk1` and `LHS_zk2` expressions. It replaces only their direct
evaluations with the two scalar differences justified by evaluation
linearity. The production comment records both the original operation and the
identity, and `testing-mode` compares the derived values with direct
evaluations.

The integrated path passed the `prove` library test, one complete release
`timing,testing-mode` fixture, and a fresh matching preprocess/prove/verify
sequence. The verifier returned `true`. No post-integration CUDA validation
was performed by project-owner decision.

Three timing-only CPU runs measured:

| sample | `total_wall` | `prove4.total` | derived scalar boundary |
| ---: | ---: | ---: | ---: |
| 1 | 37.579199 s | 8.597659 s | 0.000000250 s |
| 2 | 37.192760 s | 8.492197 s | 0.000000375 s |
| 3 | 37.113367 s | 8.397507 s | 0.000000291 s |
| mean | 37.295109 s | 8.495787 s | 0.000000305 s |
| median | 37.192760 s | 8.492197 s | 0.000000375 s |

All three timing files contain no `poly.eval.prove4.r_D1` or
`poly.eval.prove4.r_D2` event. The median sample regenerated
`timing.local.cpu.current.json` and `timing.local.cpu.current.md`. The timing
set is a production validation gate rather than a same-session paired
comparison; the integration follows the algebraic owner decision.

## Corrected July Rebenchmark

Before integration, the corrected five-run candidate versus legacy means were
`36.788042` versus `37.030477` seconds on CPU and `23.817396` versus
`23.762909` seconds on CUDA. CUDA mean and median directions disagreed, so the
isolated timing did not establish a backend-wide speedup. Integration followed
the project-owner algebraic-work decision, not a new performance claim.

See
[July Rebenchmark And Final Disposition](2026-07-30_july-rebenchmark-and-final-disposition.md)
for all samples, controls, and the completed production sequence.
