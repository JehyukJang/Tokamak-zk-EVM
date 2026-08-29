# Backend-Dispatched Batched Coefficient Rescaling

## Decision Status

Candidate 4 is rejected. Both X-only and Y-only batching reduced their isolated
and instrumented scaling boundaries, but neither improved end-to-end
`total_wall` beyond observed noise. No production code changed.

## Source And Environment

- Production baseline: `ee948ca0e`
- Stage 0 report commit: `3c3f8367a`
- Detached experiment commit: `19096e9a6`
- Candidate owners: `DensePolynomialExt` coefficient scaling and prove2/prove4
  scaling call sites
- Current benchmark backend: ICICLE CPU fallback
- Primary metric: end-to-end `total_wall`
- Experiment isolation: detached worktree

## Candidate Boundary

For row-major coefficient storage:

```text
index(x, y) = x * y_size + y
```

the production implementation:

1. copies all polynomial coefficients to a host vector;
2. allocates a full `x_size * y_size` device scale vector;
3. uploads one repeated row or column scale vector per exponent;
4. for Y scaling, allocates a second full device vector and transposes the
   first scale vector;
5. performs one full pointwise multiplication;
6. writes a host output and reconstructs the polynomial.

Candidate 4 replaces this with ICICLE's existing batched scalar-vector
multiplication:

1. copy coefficients once into one device buffer;
2. construct only the one-dimensional power table on the host;
3. upload the power table once into one device buffer;
4. allocate one device output;
5. invoke `ScalarCfg::scalar_mul`;
6. construct the output polynomial directly from the device output.

## Algebra And Batch Layout

For X scaling:

```text
P(aX, Y)[x, y] = P[x, y] * a^x
```

Use:

- scalar batch: `[1, a, ..., a^(x_size-1)]`;
- `batch_size = x_size`, inferred by the Rust wrapper;
- vector length per batch: `y_size`;
- `columns_batch = false`.

Each scalar therefore multiplies one contiguous X row.

For Y scaling:

```text
P(X, bY)[x, y] = P[x, y] * b^y
```

Use:

- scalar batch: `[1, b, ..., b^(y_size-1)]`;
- `batch_size = y_size`, inferred by the Rust wrapper;
- vector length per batch: `x_size`;
- `columns_batch = true`.

Each scalar therefore multiplies one strided Y column directly in row-major
storage. No full scale matrix or transpose is needed.

## Current Cost

The canonical CPU timing table records:

| call site | direction | time | shape |
| --- | --- | ---: | --- |
| prove2 `r_omegaX` | X | 0.006487 s | 4096 by 256 |
| prove2 `r_omegaX_omegaY` | Y | 0.006938 s | 4096 by 256 |
| prove4 `r_omegaX` | X | 0.007272 s | 4096 by 256 |
| prove4 `r_omegaX_omegaY` | Y | 0.028844 s | 4096 by 256 |
| X total | | 0.013758 s | |
| Y total | | 0.035782 s | |

These are single canonical samples. Fresh alternating E2E runs must establish
the current cost distribution before any decision.

## ICICLE Native Primitive Inventory

ICICLE v3.8.0 exposes `VecOps::scalar_mul` and `VecOpsConfig` through the Rust
wrapper. The wrapper validates:

- output length equals vector length;
- vector length is divisible by scalar count;
- scalar count becomes the native batch size;
- host/device flags are derived from the typed slices.

The CPU backend applies each scalar to either one contiguous batch or one
strided column batch according to `columns_batch`. The same dispatcher
contract is used by CUDA. No local FFI wrapper is required.

Candidate 4 must not inspect the active device or provide a custom CPU loop.
Errors from allocation, transfer, or `scalar_mul` must remain visible.

## Independent Subcandidates

Benchmark in this order:

1. X batching only, with Legacy Y scaling;
2. Y batching only, with Legacy X scaling;
3. combined X and Y batching only if both independent candidates qualify and
   the project owner authorizes combined evaluation.

Do not use the combined path to rescue an independently unqualified
subcandidate.

## Correctness Gates

Focused tests must compare every coefficient against production for:

- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense polynomials;
- one-by-one, one-by-many, many-by-one, 64-by-16, and representative
  4096-by-256 shapes;
- factors zero, one, negative one, roots of unity, and nontrivial values;
- lower logical degrees inside larger storage.

The identity:

```text
scaleX(a, P)(x, y) = P(a*x, y)
scaleY(b, P)(x, y) = P(x, b*y)
```

must pass at independent points. Host-visible outputs and device-resident
intermediate outputs must agree exactly.

The full release fixture must pass exact Legacy/Candidate coefficient parity
for every prove2 and prove4 scaling call. A fresh Candidate-only proof must pass
the verifier with a fresh matching preprocess artifact.

## Benchmark Protocol

First run a removable isolated boundary benchmark for X and Y separately. It
must include:

- coefficient extraction or device copy;
- power-table generation and upload;
- allocation;
- ICICLE dispatch and synchronization;
- output polynomial construction.

Then benchmark X-only and Y-only end to end as separate experiments. For each
subcandidate:

1. warm Legacy and Candidate once;
2. collect five alternating measured pairs;
3. use the same release binary, source revision, fixture, CRS, backend, timing
   instrumentation, and output location;
4. report every `total_wall` sample, mean, median, range, paired delta, and
   95% paired interval;
5. report both affected call sites and movement in unchanged stages.

End-to-end `total_wall` is the acceptance metric. No subcandidate may enter
production without exact correctness, fresh verification, an E2E improvement
that exceeds observed noise, and explicit project-owner approval.

## Experimental Implementation

The detached experiment added Legacy, X-only, Y-only, Both, and Parity
selectors. The selectors and candidate implementation existed only in the
detached worktree and were never copied to the production branch.

The candidate:

1. copied the polynomial coefficients once to a device buffer;
2. generated and uploaded one one-dimensional power table;
3. invoked the public `icicle_core::vec_ops::scalar_mul` wrapper with contiguous
   X batches or strided Y column batches;
4. constructed the result directly from the device output.

An initial focused test exposed an important API distinction. Calling the
`ScalarCfg::scalar_mul` trait method directly bypassed the public wrapper's
argument setup, leaving `VecOpsConfig.batch_size` at one. Only the first scalar,
which is always one, was then used. The experiment was corrected to call the
public wrapper, which infers the native batch size from the scalar slice and
preserves `columns_batch`. All subsequent correctness and benchmark results use
that corrected implementation.

## Correctness Results

The focused release test passed exact coefficient, shape, degree, and
evaluation-identity parity for both directions across:

- zero and constant polynomials;
- one-by-many and many-by-one shapes;
- sparse and dense polynomials;
- 64-by-16 and representative 4096-by-256 shapes;
- zero, one, negative-one, root-of-unity, and nontrivial scale factors.

The complete release `timing,testing-mode` fixture passed with every prove2 and
prove4 scaling call in Parity mode. A fresh preprocess artifact was generated,
then independent X-only and Y-only proofs were generated. Both proofs passed
the existing verifier with result `true`.

The relevant commands were:

```text
cargo test --release -p libs --lib test_batched_coefficient_scaling_matches_legacy -- --nocapture
cargo test --release -p libs --lib bench_batched_coefficient_scaling_candidates -- --ignored --nocapture
TOKAMAK_COEFFICIENT_SCALING_EXPERIMENT=parity ... cargo test --release -p prove --features timing,testing-mode --test timing timing_prove_stages -- --nocapture
cargo run --release -p preprocess -- ...
TOKAMAK_COEFFICIENT_SCALING_EXPERIMENT=x cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
TOKAMAK_COEFFICIENT_SCALING_EXPERIMENT=y cargo run --release -p prove -- ...
cargo run --release -p verify -- ...
```

## Isolated Boundary Benchmark

The representative 4096-by-256 benchmark used ten alternating Legacy/Candidate
repetitions per direction and included coefficient copying, power generation
and upload, allocation, native dispatch, synchronization, and result
construction.

| direction | Legacy mean | Candidate mean | reduction |
| --- | ---: | ---: | ---: |
| X | 0.005695 s | 0.003593 s | 0.002102 s |
| Y | 0.008358 s | 0.004637 s | 0.003720 s |

Exact coefficient parity passed on every repetition. These local reductions
qualified both independent directions for E2E measurement but did not determine
acceptance.

## X-Only End-To-End Benchmark

Legacy and X-only were warmed once, then measured in this order:

```text
L1, X1, X2, L2, L3, X3, X4, L4, L5, X5
```

| pair | Legacy `total_wall` | X-only `total_wall` | Legacy minus X-only |
| ---: | ---: | ---: | ---: |
| 1 | 37.933011 s | 37.964116 s | -0.031105 s |
| 2 | 37.897023 s | 37.978838 s | -0.081815 s |
| 3 | 38.057720 s | 37.921130 s | 0.136590 s |
| 4 | 37.936089 s | 37.917543 s | 0.018546 s |
| 5 | 37.993589 s | 38.028884 s | -0.035294 s |

| statistic | Legacy | X-only | Legacy minus X-only |
| --- | ---: | ---: | ---: |
| mean | 37.963487 s | 37.962102 s | 0.001384 s |
| median | 37.936089 s | 37.964116 s | -0.031105 s paired median |
| minimum | 37.897023 s | 37.917543 s | -0.081815 s |
| maximum | 38.057720 s | 38.028884 s | 0.136590 s |
| range | 0.160697 s | 0.111340 s | 0.218405 s |

The paired improvement had a 95% Student-t interval of `-0.102312 s` to
`0.105080 s`. The two instrumented X scaling calls improved from a 0.014370
second Legacy mean to a 0.008746 second candidate mean, a 0.005624 second local
reduction. That work did not produce a measurable E2E improvement.

## Y-Only End-To-End Benchmark

Legacy and Y-only were independently warmed once, then measured in this order:

```text
L1, Y1, Y2, L2, L3, Y3, Y4, L4, L5, Y5
```

| pair | Legacy `total_wall` | Y-only `total_wall` | Legacy minus Y-only |
| ---: | ---: | ---: | ---: |
| 1 | 38.056052 s | 37.764812 s | 0.291239 s |
| 2 | 37.947915 s | 37.929940 s | 0.017975 s |
| 3 | 37.905231 s | 37.851449 s | 0.053782 s |
| 4 | 37.929681 s | 38.375350 s | -0.445668 s |
| 5 | 37.727354 s | 37.761218 s | -0.033865 s |

| statistic | Legacy | Y-only | Legacy minus Y-only |
| --- | ---: | ---: | ---: |
| mean | 37.913246 s | 37.936554 s | -0.023307 s |
| median | 37.929681 s | 37.851449 s | 0.017975 s paired median |
| minimum | 37.727354 s | 37.761218 s | -0.445668 s |
| maximum | 38.056052 s | 38.375350 s | 0.291239 s |
| range | 0.328698 s | 0.614131 s | 0.736908 s |

The paired improvement had a 95% Student-t interval of `-0.354791 s` to
`0.308177 s`. The two instrumented Y scaling calls improved from a 0.035386
second Legacy mean to a 0.010389 second candidate mean, a 0.024997 second local
reduction. Mean E2E time nevertheless regressed by 0.023307 seconds.

## Final Decision

X-only and Y-only both failed the primary E2E gate. Their confidence intervals
include zero by margins much larger than the work removed, and Y-only regressed
on mean `total_wall`. The candidates must not be combined to manufacture a
larger local boundary because the predefined protocol requires each direction
to qualify independently.

Candidate 4 is rejected. No production integration, production timing-table
regeneration, backend-specific path, runtime selector, or fallback is retained.
The detached experiment and ignored raw artifacts may be removed after this
report is committed.

## Reopened July Comparison

The later campaign measured legacy, X-only, Y-only, and combined X+Y paths on
both CPU and CUDA. Mean first-proof results were:

| path | CPU | CUDA |
| --- | ---: | ---: |
| legacy | 37.079145 s | 23.782945 s |
| X | 37.005200 s | 23.518756 s |
| Y | 36.977223 s | 23.650192 s |
| X+Y | 37.122566 s | 23.512530 s |

The combined path was a reopened-campaign measurement, not a promotion under
the earlier independent-direction rule. CUDA controls moved from `24.104620`
to `23.264654` seconds, more than every candidate delta, so the complete block
is inconclusive. Candidate 4 remains rejected.

See
[July Rebenchmark And Final Disposition](2026-07-30_july-rebenchmark-and-final-disposition.md)
for all retained samples and controls.
