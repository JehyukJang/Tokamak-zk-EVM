# Shared M/N X Opening Experiment

## Decision Status

The project owner approved Candidate 1B for production integration. The
production implementation passed coefficient, remainder, G1, proof, and
verifier parity checks. Five production runs measured a mean CPU end-to-end
`total_wall` of 38.418836 seconds and a median of 38.499482 seconds.

The canonical production timing moved from 39.509995 seconds to 38.499482
seconds, a 1.010512-second or 2.558% reduction. Candidate 1B is accepted.

## Source And Environment

- Source revision: `a4e0aef8c`
- Production commit: `57f9981ec`
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

The experiment uses the same QAP, synthesizer, CRS, and timing-test fixture as
the accepted combined Pi production timing.

## Candidate Boundary

Production currently constructs:

```text
M_numerator = RXY - R_omegaX_eval
N_numerator = RXY - R_omegaX_omegaY_eval
```

It then performs two independent bivariate Ruffini splits:

```text
M: (a, b_M) = (omega_m_i^-1 * chi, zeta)
N: (a, b_N) = (omega_m_i^-1 * chi, omega_s_max^-1 * zeta)
```

The current boundary performs:

- two full-size scalar-subtraction numerator allocations;
- two full X synthetic-division passes;
- two Y synthetic divisions;
- four commitments: `M_X`, `M_Y`, `N_X`, and `N_Y`.

The canonical production timing sample attributes:

| operation | time |
| --- | ---: |
| M/N numerator construction | 0.019704 s |
| M/N Ruffini division | 0.610207 s |
| `M_X` commitment call boundary | 1.138650 s |
| `N_X` commitment call boundary | 1.126944 s |
| M/N Y commitment call boundaries | 0.003781 s |

## Algebraic Basis

For any bivariate polynomial `P`, scalar `c`, and shared X opening point `a`:

```text
P(X,Y) - c = Q_X(X,Y) * (X-a) + (R_X(Y)-c)
```

The X quotient `Q_X` is independent of `c`. Therefore subtracting the distinct
M and N scalar evaluations does not change either X quotient.

For the two Y points:

```text
R_X(Y) - c_M = Q_MY(Y) * (Y-b_M)
R_X(Y) - c_N = Q_NY(Y) * (Y-b_N)
```

when `c_M = R_X(b_M)` and `c_N = R_X(b_N)`. The candidate can consequently:

1. split `RXY` once at X point `a`;
2. divide the resulting `R_X(Y)` at `b_M` and `b_N`;
3. commit `Q_X` once;
4. assign the same G1 point to both `M_X` and `N_X`;
5. commit the two distinct Y quotients.

This removes two full numerator allocations, one full X division, and one X
commitment. It preserves all six `Proof4` fields and their ordering.

## Parity Oracles

The isolated experiment must prove:

- exact coefficient equality between the shared X quotient and both legacy X
  quotients;
- exact coefficient equality for both Y quotients;
- exact scalar equality between the two X-remainder evaluations and the
  transcript-provided M/N evaluations;
- exact G1 equality for all four M/N proof fields;
- reconstruction of both opening identities at independent points;
- acceptance of a candidate-only proof by the existing verifier.

Tests must cover zero, constant, X-only, Y-only, sparse, dense,
mismatched-logical-degree, and representative production shapes. Shared X and
distinct Y challenge points must include zero, one, negative one, roots of
unity where applicable, and random values.

## Benchmark Protocol

The experiment will use one temporary binary with `legacy`, `candidate`, and
`parity` modes. No experiment switch will enter the production branch.

After warming both paths, collect five paired end-to-end `total_wall`
measurements in alternating order:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

The benchmark includes shared split construction, quotient assembly,
commitment preparation, MSM, duplicated proof-field assignment, and all
candidate-owned allocations. `prove4.total` and the M/N operation boundaries
are supporting attribution; `total_wall` is the decision metric.

## Isolated Implementation

The detached worktree added an experimental shared-X Ruffini operation that:

1. extracts each Y-indexed X polynomial once;
2. performs all X synthetic divisions once;
3. retains the resulting X remainders as `R_X(Y)`;
4. performs two Y synthetic divisions at the M and N Y points;
5. returns one X quotient, two Y quotients, and two scalar remainders.

An experiment-only `legacy`, `candidate`, or `parity` mode selected the M/N
path. `parity` computed both paths from the same `RXY` and asserted exact G1
equality for `M_X`, `M_Y`, `N_X`, and `N_Y`. This runtime switch is not a
production design and must not be promoted.

## Correctness Results

The isolated coefficient suite passed for:

- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense bivariate polynomials;
- equal storage shapes with different logical degrees;
- a representative 1024-by-32 dense shape;
- shared X points zero, one, negative one, and a nontrivial scalar;
- distinct Y points including zero, one, negative one, roots of unity, and
  nontrivial scalars;
- exact X quotient coefficient parity against both independent legacy splits;
- exact M and N Y quotient coefficient parity;
- exact scalar remainder parity;
- invariance of all quotients after subtracting the opening evaluation;
- both reconstruction identities at independent points.

The full fixture `parity` run completed without a G1 mismatch. A proof generated
with the candidate-only path was verified with the existing verifier, which
returned `true`.

## End-To-End Results

Both paths were warmed and measured from the same temporary binary, release
profile, source revision, fixture, CPU fallback, timing instrumentation, and
output location.

| sample | legacy | candidate | delta | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 40.591511 s | 39.119400 s | -1.472110 s | 3.627% |
| 2 | 40.859749 s | 39.105055 s | -1.754694 s | 4.294% |
| 3 | 39.380804 s | 37.640342 s | -1.740462 s | 4.420% |
| 4 | 39.319012 s | 37.774210 s | -1.544802 s | 3.929% |
| 5 | 39.746149 s | 38.244499 s | -1.501651 s | 3.778% |

| statistic | legacy | candidate | candidate delta |
| --- | ---: | ---: | ---: |
| mean | 39.979445 s | 38.376701 s | -1.602744 s (-4.009%) |
| median | 39.746149 s | 38.244499 s | -1.501651 s (-3.778%) |
| minimum | 39.319012 s | 37.640342 s | |
| maximum | 40.859749 s | 39.119400 s | |
| range | 1.540737 s | 1.479059 s | |

Every pair favored the candidate. Paired deltas had:

- mean: 1.602744 seconds;
- sample standard deviation: 0.134812 seconds;
- 95% Student-t interval: 1.435352 to 1.770136 seconds;
- t statistic against zero improvement: 26.584.

The end-to-end runs moved over time, but pairing isolated a stable candidate
delta. The confidence interval excludes zero by a wide margin.

## Supporting Attribution

Mean `prove4.total` changed from 10.380796 seconds to 8.817809 seconds:

- delta: -1.562987 seconds;
- `prove4` speedup: 15.057%.

Mean M/N boundary timings were:

| operation | legacy | candidate |
| --- | ---: | ---: |
| numerator construction | 0.021194 s across 2 allocations | none |
| Ruffini work | 0.612504 s across 2 full splits | 0.331690 s for 1 shared-X split |
| X commitment call boundaries | 2.341426 s across 2 calls | 1.150580 s across 1 call |
| Y commitment call boundaries | 0.004161 s across 2 calls | 0.003976 s across 2 calls |

The measured M/N boundary decreases by approximately 1.493 seconds. This agrees
with the observed 1.563-second `prove4` reduction and 1.603-second end-to-end
reduction. The remaining difference is within neighboring-stage movement.

## Production Integration

The approved implementation adds a focused shared-X Ruffini operation to the
bivariate polynomial layer. It accepts one X point and multiple Y points and
returns one X quotient, one Y quotient per Y point, and each scalar remainder.
The existing generic two-dimensional Ruffini operation remains unchanged.

Production `prove4` now:

1. splits `RXY` once at the shared M/N X point;
2. derives the distinct M and N Y quotients from the shared X remainder;
3. commits the shared X quotient once;
4. assigns the resulting G1 point to both `M_X` and `N_X`;
5. commits `M_Y` and `N_Y` independently.

Normal production builds contain no runtime experiment mode, legacy fallback,
or redundant M/N commitment. Under `testing-mode`, the prover computes the
legacy independent splits and asserts both reconstruction identities and exact
G1 equality for all four M/N proof fields.

The retained regression test compares the shared operation with two independent
legacy splits for constant and representative dense polynomials. It checks
exact quotient coefficients, scalar remainders, invariance under subtraction
of each opening evaluation, and reconstruction at an independent point.

## Production Validation

The following gates passed:

- `cargo check -p prove --features timing`;
- `cargo check -p prove --features testing-mode`;
- the focused shared-X Ruffini regression test;
- `cargo test -p prove --lib`;
- `cargo test -p prove --features testing-mode --lib`;
- the full release fixture with `timing,testing-mode`;
- all 39 non-ignored `libs` unit tests;
- `cargo test -p verify --lib`.

A new preprocess artifact and proof were generated with matching release
binaries and inputs. The existing verifier returned `true`.

## Production Timing

Five release CPU runs used the same fixture, timing feature, and CPU fallback
policy:

| sample | `total_wall` | `prove4.total` |
| ---: | ---: | ---: |
| 1 | 37.971643 s | 9.007749 s |
| 2 | 38.392882 s | 8.842167 s |
| 3 | 38.544349 s | 8.864634 s |
| 4 | 38.685825 s | 8.909582 s |
| 5 | 38.499482 s | 8.777010 s |

| statistic | `total_wall` | `prove4.total` |
| --- | ---: | ---: |
| mean | 38.418836 s | 8.880228 s |
| median | 38.499482 s | 8.864634 s |
| minimum | 37.971643 s | 8.777010 s |
| maximum | 38.685825 s | 9.007749 s |
| range | 0.714182 s | 0.230739 s |

The canonical timing table uses sample 5, the median `total_wall` run. Against
the preceding accepted canonical sample:

| metric | before | after | delta |
| --- | ---: | ---: | ---: |
| `total_wall` | 39.509995 s | 38.499482 s | -1.010512 s (-2.558%) |
| `prove4.total` | 10.071134 s | 8.777010 s | -1.294124 s (-12.850%) |

The production mean is within 0.042135 seconds of the isolated candidate mean.
This supports the isolated paired result while accounting for normal movement
between benchmark sessions.

## Complexity And CUDA Implications

The production implementation adds a focused shared-X Ruffini operation to the
polynomial layer and replaces only the M/N opening call site. It returns one X
quotient, a Y quotient for each requested Y point, and the scalar
remainders. The generic two-dimensional Ruffini operation remains unchanged.

The proof schema remains unchanged: the same committed X point is copied into
both `M_X` and `N_X`. Testing mode should retain direct comparison against both
legacy splits and assert both reconstruction identities.

The algorithm uses the same host-side coefficient and ICICLE commitment
contracts, so no separate CUDA path is justified. Because a substantial part of
the CPU gain comes from one removed MSM, CUDA end-to-end improvement may be
smaller and remains unmeasured.

## Final Decision

Candidate 1B is accepted. It is exact, verifier-compatible, and retains an
end-to-end production improvement consistent with the division and commitment
work removed. The isolated experiment can be deleted.

## Corrected July Rebenchmark

The same-revision five-run comparison measured current versus legacy
first-proof means of `37.156643` versus `38.464735` seconds on CPU and
`23.758035` versus `24.759866` seconds on CUDA. The accepted path improved both
environments.

See
[July Rebenchmark And Final Disposition](2026-07-30_july-rebenchmark-and-final-disposition.md)
for all samples, controls, and final classifications.
