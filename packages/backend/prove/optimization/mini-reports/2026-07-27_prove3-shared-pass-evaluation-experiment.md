# Prove3 Shared-Pass Evaluation Experiment

## Decision Status

Candidate 2B is eligible for project-owner review. It passed exact scalar,
full-fixture, proof, and verifier parity checks. Five paired CPU runs reduced
mean end-to-end `total_wall` by 1.299517 seconds, or 3.412%.

No production prover code has been changed. Production integration requires an
explicit project-owner decision.

## Source And Environment

- Source revision: `75f3fd440`
- Experiment commit: `b1eeeba54`
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

Production `Prover::prove3` evaluates the blinded `RXY` at three related points:

```text
(chi, zeta)
(omega_m_i^-1 * chi, zeta)
(omega_m_i^-1 * chi, omega_s_max^-1 * zeta)
```

It currently realizes the latter two points by materializing coefficient-scaled
polynomials and then calls the generic evaluator three times. Candidate 2A
proved the adjusted-point identity but was rejected as a standalone change
because removing only the scaling work did not exceed end-to-end noise.

Candidate 2B replaces the complete three-evaluation boundary with one
structured shared pass. The E2E baseline remains the current production path,
not the rejected Candidate 2A path. A supporting microbenchmark will also
compare three independent adjusted-point evaluations with the shared pass to
isolate traversal savings.

## Algebraic And Layout Basis

For row-major coefficients `p[i,j]`, define:

```text
row_zeta[i] = sum_j p[i,j] * zeta^j
row_shifted_y[i] = sum_j p[i,j] * (omega_s_max^-1 * zeta)^j
```

Then:

```text
R(chi, zeta) = sum_i row_zeta[i] * chi^i
R(shifted_x, zeta) = sum_i row_zeta[i] * shifted_x^i
R(shifted_x, shifted_y) = sum_i row_shifted_y[i] * shifted_x^i
```

where `shifted_x = omega_m_i^-1 * chi` and
`shifted_y = omega_s_max^-1 * zeta`.

One row-major coefficient copy and one parallel row pass can compute both row
reductions. A final reverse traversal performs the three X-Horner reductions.
The first two outputs reuse `row_zeta` exactly.

## Allocation And Operation Change

For an `x_size` by `y_size` polynomial, the baseline performs:

- two full scaled-polynomial constructions;
- three independent generic evaluations;
- approximately `3 * x_size * y_size` coefficient evaluation work.

The candidate performs:

- one full coefficient copy into host memory;
- `x_size` parallel pairs of Y-Horner reductions;
- three final X-Horner reductions;
- approximately `2 * x_size * y_size` coefficient evaluation work;
- one temporary pair of row values per active X coefficient.

Memory reduction is not an objective. The row-value buffer is retained because
it enables parallel Y reductions and a simple deterministic X reduction.

## Parity Oracles

The isolated correctness suite must compare all three outputs exactly against
three calls to the existing generic evaluator. It must cover:

- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense bivariate polynomials;
- valid lower logical degrees in larger storage;
- representative 4096-by-256 dimensions;
- zero, one, negative one, roots of unity, and nontrivial field points;
- exact scalar equality for every output;
- explicit evaluation against coefficient-domain identities.

Full-fixture parity must compare the complete legacy and candidate `Proof3`
from the same `RXY`, `chi`, and `zeta`. A candidate-only proof must be accepted
by the existing verifier.

## Benchmark Protocol

The detached experiment uses `legacy`, `candidate`, and `parity` modes selected
only in the temporary worktree. No selector may enter production.

First benchmark the isolated three-evaluation boundary after warming both
implementations. Include coefficient copying, row-buffer allocation, parallel
row reductions, and output assembly.

Then warm both complete prover paths and collect five paired CPU end-to-end
`total_wall` measurements in alternating order:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

`total_wall` is the decision metric. `prove3.total`, the complete shared-pass
span, the three legacy evaluation spans, and scaling spans provide supporting
attribution.

## CPU And CUDA Implications

The candidate is intentionally CPU-oriented: it copies coefficients to host
memory and uses Rayon plus field arithmetic. On a CUDA backend, this may trade
device evaluation for a device-to-host transfer and CPU work. No CUDA test
machine is available.

If the CPU candidate qualifies, production review must explicitly decide
whether the shared host path is CPU-only while the existing ICICLE path remains
the CUDA implementation. This would be a hardware-specific implementation
choice, not a fallback for correctness defects.

## Promotion Gate

Candidate 2B is eligible for project-owner review only if:

- every isolated and full-fixture parity check passes;
- a candidate-only proof verifies successfully;
- the shared-pass boundary is faster than three independent evaluations;
- paired E2E `total_wall` improvement exceeds observed noise;
- measured `prove3` and E2E movement agree with the traversal work removed.

A neutral, noisy, or negative result is rejected and retained in this report.
No production code may be changed without explicit project-owner approval.

## Isolated Implementation

The detached worktree added an experimental structured evaluation method that:

1. copies the polynomial coefficients to host memory once;
2. respects the polynomial's active X and Y logical degrees;
3. evaluates each active X-row at `y` and `shifted_y` in parallel;
4. stores both row values;
5. performs three reverse X-Horner reductions for `(x,y)`,
   `(shifted_x,y)`, and `(shifted_x,shifted_y)`.

An experiment-only `TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT` selector provided
`legacy`, `candidate`, and `parity` modes in the temporary worktree. `parity`
executed both complete prove3 evaluation paths from the same `RXY` and
challenges and asserted exact equality of all three outputs.

Neither the method nor the selector has entered the production branch.

## Correctness Results

The isolated suite passed for:

- a hand-calculated `1 + 2Y + 3X + 4XY` polynomial;
- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense bivariate polynomials;
- valid lower logical degrees in larger storage;
- a representative random 4096-by-256 polynomial;
- zero, one, negative one, roots of unity, and nontrivial field points;
- exact scalar parity for all three outputs.

The full fixture `parity` run completed without a `Proof3` mismatch. A fresh
preprocess artifact and candidate-only proof were generated in the detached
worktree. The existing verifier returned `true`.

All 40 non-ignored `libs` unit tests passed. The relevant commands were:

```text
cargo check -p prove --features timing
cargo test -p libs --lib test_eval_three_shared_matches_independent_evaluations -- --nocapture
cargo test --release -p libs --lib bench_eval_three_shared_candidate -- --ignored --nocapture
cargo test -p prove --lib
TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT=parity ... cargo test --release -p prove --features timing --test timing timing_prove_stages -- --nocapture
TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT=candidate cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
cargo test -p libs --lib
```

## Isolated Boundary Benchmark

The release microbenchmark used the representative 4096-by-256 polynomial,
warmed both paths, checked exact output equality, and alternated five
measurements per path.

| statistic | three independent evaluations | shared pass |
| --- | ---: | ---: |
| mean | 0.433728 s | 0.005458 s |
| median | 0.434051 s | 0.005455 s |
| minimum | 0.431113 s | 0.005412 s |
| maximum | 0.436563 s | 0.005518 s |
| range | 0.005450 s | 0.000106 s |

The shared pass reduced the isolated boundary by 0.428269 seconds, or 98.742%,
and was 79.464 times faster. This comparison excludes coefficient scaling from
the baseline, so it isolates traversal and evaluator overhead rather than
claiming Candidate 2A's removed work.

## End-To-End Results

Both complete paths were warmed once. The measured order was:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

Every run used the same release binary, source revision, fixture, CPU fallback,
timing instrumentation, and output location.

| sample | legacy | candidate | delta | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 37.854850 s | 36.860399 s | -0.994451 s | 2.627% |
| 2 | 37.963229 s | 36.700163 s | -1.263066 s | 3.327% |
| 3 | 37.882092 s | 36.795040 s | -1.087052 s | 2.870% |
| 4 | 38.871517 s | 36.974194 s | -1.897323 s | 4.881% |
| 5 | 37.884456 s | 36.628761 s | -1.255695 s | 3.315% |

| statistic | legacy | candidate | candidate delta |
| --- | ---: | ---: | ---: |
| mean | 38.091228 s | 36.791711 s | -1.299517 s (-3.412%) |
| median | 37.884456 s | 36.795040 s | -1.089416 s |
| minimum | 37.854850 s | 36.628761 s | |
| maximum | 38.871517 s | 36.974194 s | |
| range | 1.016667 s | 0.345433 s | |

Every pair favored the candidate. Paired improvements had:

- mean: 1.299517 seconds;
- sample standard deviation: 0.353139 seconds;
- 95% Student-t interval: 0.861038 to 1.737997 seconds;
- t statistic against zero improvement: 8.229.

The confidence interval excludes zero and its lower bound remains materially
positive despite neighboring-stage movement.

## Supporting Attribution

| stage | legacy mean | candidate mean | legacy minus candidate |
| --- | ---: | ---: | ---: |
| init | 4.604488 s | 4.604526 s | -0.000038 s |
| prove0 | 9.025519 s | 8.953578 s | 0.071942 s |
| prove1 | 2.044715 s | 1.986585 s | 0.058130 s |
| prove2 | 12.226093 s | 12.092117 s | 0.133975 s |
| prove3 | 1.471417 s | 0.429119 s | 1.042298 s |
| prove4 | 8.706708 s | 8.714241 s | -0.007533 s |

Within prove3:

| operation | legacy mean | candidate mean |
| --- | ---: | ---: |
| three evaluation spans | 1.030695 s | not executed |
| two coefficient-scaling spans | 0.041222 s | not executed |
| one shared-pass span | not executed | 0.020464 s |

The shared-pass span measured about 15 milliseconds slower inside the full
prover than in the isolated microbenchmark, but it still removed approximately
1.051 seconds from the evaluation and scaling spans. This agrees with the
1.042-second `prove3.total` reduction. Favorable movement in prove0 through
prove2 accounts for the remaining E2E mean difference and is treated as normal
neighboring-stage variation rather than candidate-owned work.

## Recommendation

Recommend approving Candidate 2B for CPU production integration.

The candidate is exact, verifier-compatible, faster in every measured pair,
and its prove3 reduction agrees with the work removed. An approved production
implementation must contain no experiment selector or legacy CPU fallback and
must pass fresh preprocess, proof, verifier, and production timing gates.

Because the implementation is host- and Rayon-oriented, production design
should retain the current ICICLE evaluation path for CUDA devices unless a
future CUDA benchmark proves the host shared pass faster. The project owner
must approve this explicit CPU/CUDA path split together with production
integration.
