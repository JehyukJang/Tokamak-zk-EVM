# Backend-Dispatched Batched Coefficient Rescaling

## Decision Status

Candidate 4 is defined but not yet implemented or benchmarked. No production
code has changed.

## Source And Environment

- Production baseline: `ee948ca0e`
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
