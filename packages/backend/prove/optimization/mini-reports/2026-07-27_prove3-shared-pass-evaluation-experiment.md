# Prove3 Shared-Pass Evaluation Experiment

## Decision Status

Candidate 2B's single-threaded shared-pass implementation is eligible for
project-owner review. It passed exact scalar, full-fixture, proof, and verifier
parity checks. In a separated three-way benchmark, five CPU runs reduced mean
end-to-end `total_wall` by 1.205487 seconds, or 3.017%, without Rayon.

Rayon reduced the local prove3 shared-pass span further, but its additional
mean E2E improvement over the serial shared pass was 0.217815 seconds with a
95% interval of -0.770716 to 1.206345 seconds. Rayon is not independently
qualified for production by the E2E gate.

No production prover code has been changed. Production integration requires an
explicit project-owner decision.

## Source And Environment

- Source revision: `75f3fd440`
- Initial experiment commit: `b1eeeba54`
- Separated experiment commit: `8c0cb6bd3`
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
output location for all paths.

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

One row-major coefficient copy and one row pass can compute both row
reductions. A final reverse traversal performs the three X-Horner reductions.
The first two outputs reuse `row_zeta` exactly. The row pass can execute
serially or with Rayon; this is an implementation choice separate from the
shared-pass algebra.

## Allocation And Operation Change

For an `x_size` by `y_size` polynomial, the baseline performs:

- two full scaled-polynomial constructions;
- three independent generic evaluations;
- approximately `3 * x_size * y_size` coefficient evaluation work.

Both shared-pass variants perform:

- one full coefficient copy into host memory;
- one pair of Y-Horner reductions per active X-row;
- three final X-Horner reductions;
- approximately `2 * x_size * y_size` coefficient evaluation work.

The serial variant updates all three X accumulators immediately and does not
retain row values. The Rayon variant stores one temporary pair per active X-row
to parallelize the Y reductions before the deterministic X reduction.

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

Full-fixture parity must compare the complete legacy, serial, and Rayon
`Proof3` from the same `RXY`, `chi`, and `zeta`. Serial-only and Rayon-only
proofs must be accepted by the existing verifier.

## Benchmark Protocol

The revised detached experiment uses `legacy`, `serial`, `rayon`, and `parity`
modes selected only in the temporary worktree. No selector may enter
production.

First benchmark the isolated three-evaluation boundary after warming all three
implementations. Use all six order permutations and collect six measurements
per implementation. Include coefficient copying, row-buffer allocation where
applicable, row reductions, and output assembly.

Then warm all three complete prover paths and collect five CPU end-to-end
`total_wall` measurements per implementation in rotating order:

```text
L1, S1, R1, R2, S2, L2, S3, R3, L3, L4, R4, S4, R5, L5, S5
```

`total_wall` is the decision metric. `prove3.total`, the complete shared-pass
spans, the three legacy evaluation spans, and scaling spans provide supporting
attribution. Evaluate legacy versus serial, legacy versus Rayon, and serial
versus Rayon independently.

## CPU And CUDA Implications

Both shared-pass variants are CPU-oriented: they copy coefficients to host
memory and use field arithmetic, with Rayon used only by the parallel variant.
On a CUDA backend, either may trade device evaluation for a device-to-host
transfer and CPU work. No CUDA test machine is available.

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

The detached worktree contains two experimental structured evaluation methods.
Both:

1. copies the polynomial coefficients to host memory once;
2. respects the polynomial's active X and Y logical degrees;
3. evaluates each active X-row at `y` and `shifted_y`;
4. performs three reverse X-Horner reductions for `(x,y)`,
   `(shifted_x,y)`, and `(shifted_x,shifted_y)`.

The serial method traverses rows in reverse order and updates the X
accumulators immediately. The Rayon method evaluates rows in parallel, stores
the row-value pairs, and then performs the reverse X reduction.

An experiment-only `TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT` selector provided
`legacy`, `serial`, `rayon`, and `parity` modes in the temporary worktree.
`parity` executed all three complete prove3 evaluation paths from the same
`RXY` and challenges and asserted exact equality of all three outputs.

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

The full fixture `parity` run completed without a `Proof3` mismatch. Fresh
Rayon-only and serial-only proofs used a fresh matching preprocess artifact.
The existing verifier returned `true` for both.

All 40 non-ignored `libs` unit tests passed. The relevant commands were:

```text
cargo check -p prove --features timing
cargo test -p libs --lib test_eval_three_shared_matches_independent_evaluations -- --nocapture
cargo test --release -p libs --lib bench_eval_three_shared_candidates -- --ignored --nocapture
cargo test -p prove --lib
TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT=parity ... cargo test --release -p prove --features timing --test timing timing_prove_stages -- --nocapture
TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT=serial cargo run --release -p prove -- ...
TOKAMAK_PROVE3_SHARED_EVAL_EXPERIMENT=rayon cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
cargo test -p libs --lib
```

## Isolated Boundary Benchmark

The revised release microbenchmark used the representative 4096-by-256
polynomial, warmed all paths, checked exact output equality, and used all six
execution-order permutations.

| statistic | independent evaluations | serial shared pass | Rayon shared pass |
| --- | ---: | ---: | ---: |
| mean | 0.450810 s | 0.043675 s | 0.005553 s |
| median | 0.450405 s | 0.043661 s | 0.005436 s |
| minimum | 0.447746 s | 0.043082 s | 0.005359 s |
| maximum | 0.454063 s | 0.044394 s | 0.006046 s |
| range | 0.006317 s | 0.001312 s | 0.000687 s |

The serial shared pass reduced the isolated boundary by 0.407135 seconds, or
90.312%, and was 10.322 times faster. Rayon then reduced the serial boundary by
another 0.038122 seconds, or 87.286%, and was 7.866 times faster than serial.
The complete Rayon path was 81.187 times faster than the independent
evaluations.

This comparison excludes coefficient scaling from the baseline, so the
0.407-second serial reduction isolates shared traversal and evaluator overhead.
It proves that the dominant benefit does not depend on Rayon.

## Initial Bundled End-To-End Results

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

Every pair favored the initial Rayon candidate. Paired improvements had:

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

## Separated End-To-End Results

All three complete paths were warmed before measurement. Five measurements per
path used the rotating order defined in the benchmark protocol.

| sample | legacy | serial shared pass | Rayon shared pass |
| ---: | ---: | ---: | ---: |
| 1 | 40.414060 s | 39.480513 s | 38.382417 s |
| 2 | 39.674561 s | 38.238561 s | 38.431230 s |
| 3 | 39.709369 s | 39.135606 s | 38.483257 s |
| 4 | 40.010508 s | 38.296717 s | 39.236119 s |
| 5 | 39.943389 s | 38.573056 s | 38.102358 s |

| statistic | legacy | serial shared pass | Rayon shared pass |
| --- | ---: | ---: | ---: |
| mean | 39.950377 s | 38.744891 s | 38.527076 s |
| median | 39.943389 s | 38.573056 s | 38.431230 s |
| minimum | 39.674561 s | 38.238561 s | 38.102358 s |
| maximum | 40.414060 s | 39.480513 s | 39.236119 s |
| range | 0.739498 s | 1.241952 s | 1.133761 s |

Pairwise results were:

| comparison | mean improvement | speedup | sample SD | 95% interval | t statistic |
| --- | ---: | ---: | ---: | ---: | ---: |
| legacy minus serial | 1.205487 s | 3.017% | 0.450475 s | 0.646148 to 1.764825 s | 5.984 |
| legacy minus Rayon | 1.423301 s | 3.563% | 0.509151 s | 0.791107 to 2.055495 s | 6.251 |
| serial minus Rayon | 0.217815 s | 0.562% | 0.796134 s | -0.770716 to 1.206345 s | 0.612 |

Every legacy-versus-serial pair favored serial, and the confidence interval
excludes zero. The shared pass therefore produces a reproducible E2E
improvement without Rayon.

Rayon reduced mean `prove3.total` from 0.579719 seconds for serial to 0.421841
seconds, a local 0.157878-second improvement. However, only three of the five
serial-versus-Rayon E2E pairs favored Rayon, and the E2E confidence interval
spans zero. The required primary metric does not establish an additional Rayon
benefit.

Separated stage means were:

| stage | legacy | serial shared pass | Rayon shared pass |
| --- | ---: | ---: | ---: |
| init | 4.944275 s | 4.881051 s | 4.838189 s |
| prove0 | 9.437618 s | 9.405885 s | 9.503197 s |
| prove1 | 2.101692 s | 2.054423 s | 2.124734 s |
| prove2 | 12.782507 s | 12.624581 s | 12.628793 s |
| prove3 | 1.479091 s | 0.579719 s | 0.421841 s |
| prove4 | 9.195157 s | 9.189546 s | 9.000504 s |

Within prove3, legacy evaluations averaged 1.033667 seconds and scaling
averaged 0.043294 seconds. The serial shared span averaged 0.177982 seconds;
the Rayon shared span averaged 0.022043 seconds. Both local reductions agree
with their respective `prove3.total` movement.

## Recommendation

Recommend approving the single-threaded Candidate 2B shared pass for CPU
production integration.

The serial candidate is exact, verifier-compatible, faster in every
legacy-versus-serial pair, and its prove3 reduction agrees with the work
removed. An approved production implementation must contain no experiment
selector or legacy CPU fallback and must pass fresh preprocess, proof, verifier,
and production timing gates.

Do not include Rayon in the initial production integration. Its local prove3
benefit is real, but its additional E2E effect did not pass the primary metric.
It may be reconsidered with a dedicated higher-sample E2E experiment.

Because the serial implementation is host-oriented, production design should
retain the current ICICLE evaluation path for CUDA devices unless a future CUDA
benchmark proves the host shared pass faster. The project owner must approve
this explicit CPU/CUDA path split together with serial production integration.
