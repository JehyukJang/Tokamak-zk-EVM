# Prove3 Adjusted-Point Evaluation Experiment

## Decision Status

Candidate 2A is rejected as a standalone production optimization. It is
mathematically exact and reduced mean `prove3.total` by 45.569 milliseconds,
but its end-to-end effect was noisy and did not improve mean `total_wall`.

No production prover code has been changed.

## Source And Environment

- Source revision: `75f3fd440`
- Experiment commit: `2ec316ca2`
- Branch baseline: local `packages/backend`
- Experiment isolation: detached temporary worktree
- OS: macOS 26.5.2, build 25F84
- CPU: Apple M4 Pro
- Memory: 48 GiB
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- Cargo: `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`
- ICICLE runtime policy: CPU fallback
- Build profile: Cargo `release`
- Timing feature: `timing`

The experiment uses the same QAP, synthesizer, CRS, timing instrumentation, and
output location for both paths.

## Candidate Boundary

Production `Prover::prove3` constructs the blinded `RXY`, evaluates it at
`(chi, zeta)`, and then:

1. materializes `scaleX(omega_m_i^-1, RXY)`;
2. evaluates it at `(chi, zeta)`;
3. materializes `scaleY(omega_s_max^-1, scaleX(...))`;
4. evaluates it at `(chi, zeta)`.

For the representative 4096-by-256 input, the canonical production timing
sample records:

| operation | time |
| --- | ---: |
| `RXY(chi, zeta)` evaluation | 0.360416 s |
| X coefficient scaling | 0.018242 s |
| X-scaled evaluation | 0.343362 s |
| Y coefficient scaling | 0.029996 s |
| XY-scaled evaluation | 0.343909 s |

The candidate replaces only the two coefficient-scaling operations. It retains
three independent calls to the existing polynomial evaluator and computes:

```text
RXY(chi, zeta)
RXY(omega_m_i^-1 * chi, zeta)
RXY(omega_m_i^-1 * chi, omega_s_max^-1 * zeta)
```

Candidate 2B owns any later attempt to share coefficient traversal across the
three evaluations. Candidate 2A must not include that optimization.

## Algebraic Basis

For a coefficient-domain bivariate polynomial

```text
P(X,Y) = sum_i sum_j p[i,j] * X^i * Y^j
```

coefficient scaling satisfies:

```text
scaleX(a, P)(x, y) = P(a*x, y)
scaleY(b, P)(x, y) = P(x, b*y)
scaleY(b, scaleX(a, P))(x, y) = P(a*x, b*y)
```

Therefore evaluating scaled copies at `(chi, zeta)` is exactly equal in the
field to evaluating the original polynomial at the adjusted challenge points.
No transcript input, proof field, proof ordering, or verifier equation changes.

## Allocation And Operation Change

The baseline performs two full-size output allocations, two full coefficient
copies, construction and transfer of two full scaling buffers, one Y scaling
transpose, and two element-wise multiplication calls. Both scaled polynomials
remain live until their respective evaluations finish.

The candidate computes two adjusted X/Y field points and performs no
coefficient scaling or scaled-polynomial allocation. The number and
implementation of polynomial evaluations remain unchanged.

The canonical sample attributes only 0.048237 seconds to the removed scaling
spans. This is small relative to observed end-to-end movement, so operation
timing alone cannot qualify the candidate.

## Parity Oracles

The isolated correctness suite must compare the baseline and candidate exactly
for all three scalar outputs. It must cover:

- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense bivariate polynomials;
- equal storage shapes with different logical degrees;
- representative production dimensions;
- scale and challenge values zero, one, negative one, roots of unity where
  applicable, and nontrivial field values;
- exact field equality for both adjusted evaluations;
- the explicit coefficient-scaling identities at independent points.

The full fixture parity mode must execute both prove3 paths from the same
`RXY`, `chi`, and `zeta` and assert exact equality of the complete `Proof3`.
A candidate-only proof must be accepted by the existing verifier.

## Benchmark Protocol

The detached experiment uses one temporary binary with `legacy`, `candidate`,
and `parity` modes. The mode switch exists only in the temporary worktree and
must not enter the production branch.

After warming both paths, collect five paired CPU end-to-end `total_wall`
measurements in alternating ABBA order:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

Every run includes prover initialization, all proof stages, adjusted-point
construction, proof output construction, and every other operation inside the
existing timing boundary. `prove3.total`, the two scaling spans, and the three
evaluation spans provide supporting attribution. `total_wall` is the decision
metric.

## Promotion Gate

Candidate 2A is eligible for project-owner review only if:

- every isolated and full-fixture parity check passes;
- a candidate-only proof verifies successfully;
- every benchmark iteration preserves exact proof semantics;
- paired `total_wall` improvement exceeds observed run-to-run noise;
- measured movement is consistent with the scaling work removed.

A neutral, noisy, or negative result is rejected and retained in this report.
No production code may be changed without explicit project-owner approval.

## Isolated Implementation

The detached worktree added an experiment-only
`TOKAMAK_PROVE3_ADJUSTED_POINT_EXPERIMENT` selector with `legacy`,
`candidate`, and `parity` modes. `candidate` evaluated the original `RXY` at
the two adjusted points. `parity` executed both paths from the same polynomial
and challenges and asserted exact equality of both shifted evaluations.

The selector and experimental tests existed only in the detached worktree.
They were not added to the production branch.

## Correctness Results

The isolated suite passed for zero, constant, X-only, Y-only, sparse, dense,
different valid logical degrees in equal storage, and representative
4096-by-256 polynomials. It covered zero, one, negative one, roots of unity,
and nontrivial scale and challenge values.

The full fixture `parity` run completed without a `Proof3` mismatch. A fresh
preprocess artifact and candidate-only proof were generated in the detached
worktree. The existing verifier returned `true`.

The relevant validation commands were:

```text
cargo check -p prove --features timing
cargo test -p libs --lib test_prove3_adjusted_point_experiment_matches_scaled_evaluation -- --nocapture
cargo test -p prove --lib
TOKAMAK_PROVE3_ADJUSTED_POINT_EXPERIMENT=parity ... cargo test --release -p prove --features timing --test timing timing_prove_stages -- --nocapture
TOKAMAK_PROVE3_ADJUSTED_POINT_EXPERIMENT=candidate cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
```

## End-To-End Results

Both paths were warmed once. The measured sequence was:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

Every run used the same release binary, source revision, fixture, CPU fallback,
timing instrumentation, and output location.

| sample | legacy | candidate | legacy minus candidate | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 39.328319 s | 39.298039 s | 0.030280 s | 0.077% |
| 2 | 37.918896 s | 39.552858 s | -1.633962 s | -4.309% |
| 3 | 37.949913 s | 37.740156 s | 0.209757 s | 0.553% |
| 4 | 37.765330 s | 37.870816 s | -0.105487 s | -0.279% |
| 5 | 37.843164 s | 37.723363 s | 0.119802 s | 0.317% |

| statistic | legacy | candidate | legacy minus candidate |
| --- | ---: | ---: | ---: |
| mean | 38.161124 s | 38.437046 s | -0.275922 s (-0.723%) |
| median | 37.918896 s | 37.870816 s | 0.048080 s |
| minimum | 37.765330 s | 37.723363 s | |
| maximum | 39.328319 s | 39.552858 s | |
| range | 1.562989 s | 1.829495 s | |

The paired deltas had:

- mean: -0.275922 seconds;
- sample standard deviation: 0.768043 seconds;
- 95% Student-t interval: -1.229574 to 0.677729 seconds;
- t statistic against zero improvement: -0.803.

The interval spans both a material regression and a material improvement. The
standalone E2E result is therefore inconclusive and fails the promotion gate.

## Supporting Attribution

| metric | legacy mean | candidate mean | delta |
| --- | ---: | ---: | ---: |
| coefficient scaling | 0.041079 s | 0.000000 s | -0.041079 s |
| three prove3 evaluations | 1.057195 s | 1.049750 s | -0.007445 s |
| `prove3.total` | 1.504313 s | 1.458744 s | -0.045569 s (-3.029%) |

The 45.569-millisecond `prove3` reduction agrees with the 41.079 milliseconds
of scaling removed plus normal evaluation movement. Unchanged stages moved by
larger amounts: candidate means increased by 70 milliseconds in initialization,
156 milliseconds in `prove0`, and 41 milliseconds in `prove4`. This explains
why the local improvement cannot be established at the required E2E boundary.

## Complexity And CUDA Implications

The candidate would simplify prove3 and remove two full-size temporary
polynomials without changing the generic evaluator. It uses only field
arithmetic and the existing evaluation contract, so no separate CUDA path is
justified.

The algebra remains useful for Candidate 2B, where one shared coefficient
traversal may produce a larger measurable E2E reduction. Candidate 2B must
benchmark the complete shared-pass implementation independently and must not
claim Candidate 2A's unmeasurable standalone gain as an accepted result.

## Final Decision

Reject Candidate 2A as a standalone production change. Preserve the algebraic
identity as an input to Candidate 2B, delete the detached experiment, and leave
the production prover unchanged.
