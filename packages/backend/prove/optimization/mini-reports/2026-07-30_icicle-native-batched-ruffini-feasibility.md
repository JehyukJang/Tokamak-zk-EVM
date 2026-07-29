# ICICLE-Native Batched Ruffini Feasibility

## Decision Status

Candidate 3C is blocked at the mandatory Stage 0 API-feasibility gate. ICICLE
exposes a batched polynomial-division dispatcher, but neither the workspace's
ICICLE `v3.8.0` CUDA backend nor the latest official `v4.0.0` CUDA backend
registers an implementation for it. Only the CPU backend registers polynomial
division.

No experiment or production code was added. Proceeding requires an explicit
project-owner decision to defer the candidate or change its architecture.

## Current Production Boundary

After the accepted combined-Pi and shared-M/N opening changes, normal proof
generation performs two large Ruffini boundaries:

1. `poly.div_by_ruffini.prove4.Pi_combined` divides one 4096-by-256 polynomial
   at `(chi, zeta)`;
2. `poly.div_by_ruffini_shared_x.prove4.M_N` divides one 4096-by-256 polynomial
   once along X and divides its shared X remainder at two Y points.

The current implementation:

- extracts one X polynomial for every Y coefficient;
- copies each extracted polynomial through host memory;
- runs the sequential Ruffini recurrence with Rayon;
- flattens and transposes the quotient back to row-major layout;
- constructs new ICICLE polynomials from host quotient buffers.

On the corrected Lambda Cloud NVIDIA A10 environment, three production
timing-only runs measured:

| sample | `total_wall` | combined Pi Ruffini | shared M/N Ruffini | Ruffini total |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 23.648456 s | 0.622282 s | 0.291165 s | 0.913447 s |
| 2 | 23.336629 s | 0.599113 s | 0.279839 s | 0.878952 s |
| 3 | 23.155058 s | 0.604533 s | 0.281829 s | 0.886362 s |

## Algebraic Contract

For coefficients `a_0, ..., a_(n-1)` and division point `x`, Ruffini division
by `X - x` computes:

```text
q_(n-2) = a_(n-1)
q_i = a_(i+1) + x * q_(i+1)
r = a_0 + x * q_0
```

For a row-major bivariate polynomial, every Y column is an independent X
polynomial. A native batch would therefore use:

- `batch_size = y_size`;
- `columns_batch = true`;
- `numerator_size = x_size`;
- one interleaved denominator `[-x, 1]` per batch element;
- an interleaved quotient and remainder output.

The Y remainder divisions are small follow-up operations. The principal
candidate value is eliminating host extraction, one independent recurrence per
Y coefficient, quotient flattening, transpose, and re-upload for the large X
batch.

## ICICLE `v3.8.0` API Audit

Workspace revision:

- tag: `v3.8.0`;
- commit: `42b4f9a3`;
- Rust crate source:
  `wrappers/rust/icicle-core/src/polynomials/mod.rs`;
- dispatcher source: `icicle/src/vec_ops.cpp`;
- backend registration source:
  `icicle/backend/cpu/src/field/cpu_vec_ops.cpp`.

The C++ `polynomial_division` API accepts `VecOpsConfig`, including
`batch_size`, `columns_batch`, memory-placement flags, stream, and asynchronous
execution. The high-level Rust `DensePolynomial::divide` wrapper does not
expose that batch configuration, so Candidate 3C would need a small private FFI
wrapper similar to the accepted polynomial-evaluation wrapper.

The blocking issue is backend availability. The complete `v3.8.0` source
contains exactly one polynomial-division registration:

```text
REGISTER_POLYNOMIAL_DIVISION("CPU", cpu_poly_divide<scalar_t>);
```

No CUDA source registers `REGISTER_POLYNOMIAL_DIVISION`.

## Latest Official Version Audit

The official repository's latest tag on 2026-07-30 is `v4.0.0`, commit
`6c777759`. Its backend source also contains exactly one polynomial-division
registration, again in the CPU backend:

```text
REGISTER_POLYNOMIAL_DIVISION("CPU", cpu_poly_divide<scalar_t>);
```

Upgrading ICICLE therefore would not make the planned backend-neutral batched
division available on CUDA.

Official sources:

- <https://github.com/ingonyama-zk/icicle/tree/v3.8.0>
- <https://github.com/ingonyama-zk/icicle/tree/v4.0.0>
- <https://dev.ingonyama.com/3.0.0/icicle/primitives/vec_ops>

## Why Implementation Stops

Submitting polynomial division on the active CUDA device cannot dispatch to a
CUDA implementation. The following alternatives are not the approved
Candidate 3C architecture:

- switching the active device to CPU around Ruffini division;
- copying device coefficients to host and invoking the CPU primitive;
- retaining the current host implementation as an implicit fallback;
- adding a custom CUDA kernel outside ICICLE;
- replacing division with an NTT/convolution formulation.

The first three preserve the host staging that Candidate 3C is intended to
remove and violate the single backend-neutral path requirement. A custom CUDA
kernel creates backend-specific prove code. An NTT formulation is a different
algorithm with different work, allocations, and performance risks.

## Required Project-Owner Decision

The available choices are:

1. defer Candidate 3C until ICICLE provides CUDA polynomial division;
2. re-scope Candidate 3C as a backend-specific custom CUDA recurrence, with a
   separately selected CPU path;
3. replace Candidate 3C with a new backend-neutral NTT/convolution experiment;
4. leave Candidate 3C blocked and proceed to Candidate 7 or Candidate 8.

No choice has been made. The optimization campaign must not implement one of
these alternatives implicitly.
