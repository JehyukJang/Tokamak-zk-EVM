# Constant-Free Combined Pi Ruffini Correction

## Decision Status

Candidate 3A passed exact correctness and fresh proof-verification gates, but
its five-pair end-to-end result did not exceed observed noise.

The project owner rejected Candidate 3A as a standalone production
optimization. No production code changed, and the isolated experiment was
discarded after this decision.

## Source And Environment

- Production baseline: `008eb86fd`
- Isolated implementation: `a1e4af48d`
- Final instrumented experiment: `eead0281f`
- Candidate owner: `Prover::prove4`
- Current benchmark backend: ICICLE CPU fallback
- Primary metric: end-to-end `total_wall`
- Experiment isolation: detached worktree

## Candidate Boundary

The production combined Pi numerator contains three explicit scalar
subtractions:

```text
kappa1 * (VXY - V_eval)
kappa1^3 * (RXY - R_eval)
kappa1^4 * (a_free_X - A_eval)
```

The remaining terms are unchanged. Candidate 3A constructs the same combined
numerator without these scalar subtractions:

```text
kappa1 * VXY
kappa1^3 * RXY
kappa1^4 * a_free_X
```

and records the combined scalar correction:

```text
c = kappa1 * V_eval + kappa1^3 * R_eval + kappa1^4 * A_eval
```

It then runs the existing bivariate Ruffini split once on the constant-free
numerator.

## Algebraic Basis

For any bivariate polynomial `P`, scalar `c`, and split point `(x, y)`:

```text
P - c = Q_X(X, Y) * (X - x) + Q_Y(Y) * (Y - y) + (P(x, y) - c)
```

Subtracting `c` changes only the final scalar remainder. It does not change
either quotient. Therefore:

```text
ruffini(P - c).Q_X = ruffini(P).Q_X
ruffini(P - c).Q_Y = ruffini(P).Q_Y
ruffini(P - c).remainder = ruffini(P).remainder - c
```

The production numerator evaluates to zero at `(chi, zeta)`, so the
constant-free numerator must return remainder `c`. Its two quotient
polynomials, and therefore its two KZG commitments, must exactly match
production.

## Current Cost And Allocation

The canonical CPU timing table records:

| operation | time | shape |
| --- | ---: | --- |
| scalar subtraction inside `Pi_A` | 0.007889 s | `VXY` |
| `poly.add.prove4.R_minus_eval` | 0.013193 s | 4096 by 256 |
| `poly.add.prove4.Pi_B_numerator` | 0.000007 s | 128 by 1 |
| directly removable work | 0.021089 s | |
| `poly.combine.prove4.Pi_combined_numerator` | 0.051091 s | 4096 by 256 |
| `poly.div_by_ruffini.prove4.Pi_combined` | 0.352879 s | 4096 by 256 |

Each scalar subtraction clones or reconstructs a polynomial even though only
coefficient `(0, 0)` changes. The candidate removes those intermediate
polynomials and adds only scalar field arithmetic and a remainder comparison.

The expected saving is substantially smaller than normal E2E variance. The
candidate must not be promoted from algebraic correctness or boundary timing
alone.

## ICICLE And Backend Constraints

Candidate 3A does not replace the Ruffini kernel. It continues to invoke the
same `DensePolynomialExt::div_by_ruffini` operation and changes only the input
constant and expected remainder.

No additional ICICLE primitive, CPU implementation, active-device branch,
transfer, or fallback is required. The same prove control flow applies to
every backend. ICICLE-native batched Ruffini work remains independently owned
by Candidate 3C and must not be combined with this experiment.

## Correctness Gates

Focused tests must compare:

- Legacy split of `P - c`;
- Candidate split of `P` followed by scalar remainder correction.

They must establish exact equality of both quotient coefficient arrays and:

```text
legacy_remainder = candidate_remainder - c
```

Coverage must include zero, constant, X-only, Y-only, sparse, dense,
mismatched logical degree, and representative 4096-by-256 polynomials. Split
points and corrections must include zero, one, negative one, and nontrivial
field values. The reconstruction identity must pass at independent points.

The full fixture Parity mode must assert exact equality of:

- constant-free and Legacy combined Pi quotient polynomials;
- `Pi_X` and `Pi_Y`;
- corrected and Legacy remainders;
- the complete `Proof4` and `Proof4Test` outputs.

A fresh Candidate-only proof must pass the existing verifier with a fresh
matching preprocess artifact.

## Benchmark Protocol

The detached experiment will expose Legacy, Candidate, and Parity modes only
inside its isolated worktree. Legacy retains all three scalar-subtracted
numerators. Candidate removes them and checks the combined correction.

After warming both measured paths, collect five alternating E2E pairs using
the same release binary, source revision, fixture, CRS, ICICLE backend, timing
instrumentation, and output location. Report:

- every `total_wall` sample;
- mean, median, range, paired delta, and 95% paired interval;
- `prove4.total`;
- all three removed scalar-subtraction spans;
- combined numerator construction and Ruffini timing;
- movement in unchanged neighboring stages.

End-to-end `total_wall` remains the acceptance metric. The candidate qualifies
for project-owner review only if exact parity and fresh verification pass and
the E2E improvement exceeds observed noise. No production integration may
begin without explicit project-owner approval.

## Isolated Implementation

The detached experiment added Legacy, Candidate, and Parity modes. Candidate
omitted the three scalar-subtracted intermediate polynomials and passed their
weighted scalar sum to one private Ruffini correction helper. The helper
delegated both quotient calculations to the unchanged production Ruffini
operation and subtracted the correction only from its returned remainder.

Parity reconstructed the Legacy combined numerator, split both numerators, and
asserted exact quotient coefficient, shape, degree, and corrected-remainder
equality. No custom CPU kernel, ICICLE wrapper, device branch, transfer, or
fallback was introduced.

## Correctness Results

The focused exact-parity suite passed for:

- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense polynomials;
- lower logical degrees in larger storage;
- 64-by-16 and representative 4096-by-256 shapes;
- zero, one, negative-one, and nontrivial corrections;
- zero, one, negative-one, and nontrivial split points;
- the Ruffini reconstruction identity at independent points.

The complete release `timing,testing-mode` fixture passed in Parity mode on
final experiment revision `eead0281f`. This covered both the combined Pi
quotients and the decomposed `Proof4Test` commitment paths.

A new preprocess artifact and Candidate-only proof were generated from matching
inputs at the same revision. Candidate proof generation completed in 37.143
seconds, and the existing verifier returned `true`.

The relevant commands were:

```text
cargo test --release -p prove --lib constant_free_ruffini_matches_scalar_subtracted_numerator -- --nocapture
TOKAMAK_PROVE4_CONSTANT_FREE_RUFFINI_EXPERIMENT=parity ... cargo test --release -p prove --features timing,testing-mode --test timing timing_prove_stages -- --nocapture
cargo run --release -p preprocess -- ...
TOKAMAK_PROVE4_CONSTANT_FREE_RUFFINI_EXPERIMENT=candidate cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
```

## Instrumentation Correction

An initial five-pair run used implementation revision `a1e4af48d`. Its E2E
samples were:

| pair | Legacy | Candidate | Legacy minus Candidate |
| ---: | ---: | ---: | ---: |
| 1 | 37.047488 s | 37.370526 s | -0.323039 s |
| 2 | 37.148379 s | 37.332106 s | -0.183727 s |
| 3 | 37.201275 s | 37.046366 s | 0.154908 s |
| 4 | 37.472879 s | 37.160341 s | 0.312538 s |
| 5 | 37.292743 s | 36.934643 s | 0.358100 s |

Legacy mean was 37.232553 seconds and Candidate mean was 37.168797 seconds.
The apparent 0.063756-second improvement had a paired 95% interval of
-0.312704 to 0.440216 seconds.

This run is excluded from the decision because moving `VXY - V_eval` outside
its former detail scope removed that subtraction from the timing event stream.
The benchmark protocol requires all three removed spans. Revision `eead0281f`
added an explicit `poly.add.prove4.V_minus_eval` span without changing the
algorithm, then repeated correctness, verification, warm-up, and all measured
runs. Results from the two revisions are not combined.

## Final End-To-End Benchmark

Legacy and Candidate were warmed once before measurement. Five measured pairs
used this alternating order:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

Every final run used revision `eead0281f`, the same release timing binary,
fixture, CRS, ICICLE CPU backend, and output location.

| pair | Legacy `total_wall` | Candidate `total_wall` | Legacy minus Candidate |
| ---: | ---: | ---: | ---: |
| 1 | 37.360121 s | 37.138996 s | 0.221124 s |
| 2 | 36.985977 s | 37.306823 s | -0.320845 s |
| 3 | 37.274046 s | 37.154081 s | 0.119965 s |
| 4 | 37.231689 s | 37.266078 s | -0.034390 s |
| 5 | 37.037729 s | 37.082667 s | -0.044939 s |

| statistic | Legacy | Candidate | Legacy minus Candidate |
| --- | ---: | ---: | ---: |
| mean | 37.177912 s | 37.189729 s | -0.011817 s (-0.032%) |
| median | 37.231689 s | 37.154081 s | -0.034390 s paired median |
| minimum | 36.985977 s | 37.082667 s | -0.320845 s |
| maximum | 37.360121 s | 37.306823 s | 0.221124 s |
| range | 0.374143 s | 0.224155 s | 0.541969 s |

The paired Legacy-minus-Candidate deltas had:

- mean: -0.011817 seconds;
- sample standard deviation: 0.205386 seconds;
- 95% Student-t interval: -0.266837 to 0.243203 seconds.

Two pairs favored Candidate and three favored Legacy. The interval includes
zero by a wide margin.

## Supporting Attribution

The required subtraction spans were present exactly once in every Legacy run
and absent from every Candidate run:

| removed boundary | Legacy mean | Candidate mean | Legacy minus Candidate |
| --- | ---: | ---: | ---: |
| `poly.add.prove4.V_minus_eval` | 0.007672 s | removed | 0.007672 s |
| `poly.add.prove4.R_minus_eval` | 0.012534 s | removed | 0.012534 s |
| `poly.add.prove4.Pi_B_numerator` | 0.000004 s | removed | 0.000004 s |
| directly removed total | 0.020211 s | removed | 0.020211 s |

The complete affected boundary, including the adjacent expression and Ruffini
spans, changed from 0.716635 seconds to 0.695991 seconds, a 0.020644-second or
2.881% local reduction. The unchanged Ruffini operation itself varied between
the paths and does not represent algorithmic work removed by Candidate 3A.

| stage | Legacy mean | Candidate mean | Legacy minus Candidate |
| --- | ---: | ---: | ---: |
| init | 4.622628 s | 4.630052 s | -0.007424 s |
| prove0 | 9.023606 s | 8.997964 s | 0.025642 s |
| prove1 | 2.004207 s | 1.982970 s | 0.021237 s |
| prove2 | 12.124544 s | 12.134182 s | -0.009638 s |
| prove3 | 0.633367 s | 0.636810 s | -0.003444 s |
| prove4 | 8.758918 s | 8.796294 s | -0.037375 s |

The paired `prove4.total` interval was -0.155531 to 0.080780 seconds for
Legacy minus Candidate. The approximately 20-millisecond local saving is
smaller than variance inside prove4 and unchanged neighboring stages.

## Final Decision

Candidate 3A is rejected. Its algebra, exact quotient parity, fresh
verification, and local boundary saving are established, but mean E2E
`total_wall` regressed by 0.032% and the paired confidence interval does not
exclude either a material regression or improvement.

The constant-free Ruffini correction must not enter production as part of this
optimization campaign. The detached experiment and its ignored raw timing
artifacts were removed after the project-owner decision.
