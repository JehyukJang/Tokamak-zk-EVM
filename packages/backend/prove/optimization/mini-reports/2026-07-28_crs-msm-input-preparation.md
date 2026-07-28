# CRS-To-MSM Input Preparation Profiling

## Decision Status

Candidate 5 is in Stage 0. No cache, representation change, or production
optimization has been selected. The next gate is diagnostic profiling of the
unchanged commitment algorithm in a detached worktree.

## Source And Environment

- Production baseline: `e30506c16`
- Current benchmark backend: ICICLE CPU fallback
- Primary metric for any later candidate: end-to-end `total_wall`
- Diagnostic source: `prove/optimization/timing.local.cpu.current.json`
- Experiment isolation: detached worktree

## Audience

This report is for maintainers profiling and optimizing the native
Rust/ICICLE prover in `packages/backend`.

## Current Boundary

`ArchivedSigma1Rkyv::encode_poly_timed` delegates to
`encode_poly_from_xy_powers_with_timing`. For every polynomial commitment, the
current implementation:

1. scans every stored coefficient to find the logical X and Y degrees;
2. may resize the polynomial to power-of-two storage matching those degrees;
3. copies all resized coefficients from the active device to a host vector;
4. compacts the active coefficient rectangle into another host vector;
5. traverses the archived row-major CRS rectangle;
6. decodes every selected archived point into an ICICLE `G1Affine`;
7. allocates the MSM result;
8. invokes ICICLE MSM with host scalars and host bases;
9. converts the projective MSM result to affine form.

The mmap-backed rkyv archive already avoids a full CRS copy at load time. This
candidate concerns repeated per-commitment preparation after the archive is
loaded.

## Canonical Cost

The current canonical CPU timing sample records 14 polynomial commitments:

| call site | outer boundary | MSM | unclassified preparation |
| --- | ---: | ---: | ---: |
| prove0 `U` | 1.141896 s | 1.072942 s | 0.068954 s |
| prove0 `V` | 1.116425 s | 1.049159 s | 0.067265 s |
| prove0 `W` | 1.169290 s | 1.102515 s | 0.066775 s |
| prove0 `Q_AX` | 2.242666 s | 2.110436 s | 0.132230 s |
| prove0 `Q_AY` | 1.115336 s | 1.048581 s | 0.066754 s |
| prove0 `B` | 1.119935 s | 1.048792 s | 0.071143 s |
| prove1 `R` | 1.103976 s | 1.036580 s | 0.067396 s |
| prove2 `Q_CX` | 4.102291 s | 3.823418 s | 0.278874 s |
| prove2 `Q_CY` | 2.247730 s | 2.124781 s | 0.122949 s |
| prove4 `M_N_X` | 1.137369 s | 1.064390 s | 0.072979 s |
| prove4 `M_Y` | 0.003801 s | 0.003582 s | 0.000218 s |
| prove4 `N_Y` | 0.003374 s | 0.003186 s | 0.000188 s |
| prove4 `Pi_X` | 4.184939 s | 3.924668 s | 0.260271 s |
| prove4 `Pi_Y` | 0.002164 s | 0.002044 s | 0.000120 s |
| **total** | **20.691190 s** | **19.415075 s** | **1.276115 s** |

The existing `encode` category measures only the ICICLE MSM call. The
`encode_call` category measures the complete caller-visible boundary.
Subtraction exposes the 1.276115-second aggregate preparation cost but cannot
identify its owner.

## Diagnostic Instrumentation

The detached profiling implementation must preserve the existing algorithm and
record non-overlapping subspans under each existing call-site name:

1. `encode_degree_scan`: coefficient download and logical degree search;
2. `encode_poly_resize`: resize performed by `optimize_size`;
3. `encode_coeff_alloc`: full and compact scalar-vector allocation;
4. `encode_coeff_copy`: active-device-to-host coefficient copy;
5. `encode_coeff_compact`: row-major active-rectangle compaction;
6. `encode_crs_decode`: archived index traversal and conversion to `G1Affine`;
7. `encode_msm_alloc`: projective result allocation;
8. `encode`: the existing ICICLE MSM call;
9. `encode_output`: projective-to-affine result conversion.

Timing mode may expand `optimize_size` into the same `find_degree`, metadata
assignment, and `resize` operations solely to place exact boundaries. It must
not change the order, input shape, output polynomial, CRS indices, MSM inputs,
or proof output.

The sum of classified subspans must be reconciled against every `encode_call`
outer span. Instrumentation overhead and unclassified control work must be
reported rather than hidden.

## Correctness Gate

Before using the profile:

- focused commitment tests must compare exact G1 outputs before and after
  instrumentation;
- the complete release `timing,testing-mode` fixture must pass;
- a fresh proof must verify with a fresh matching preprocess artifact;
- every call must retain its existing coefficient rectangle and CRS index
  ordering.

Profiling changes are diagnostic only and cannot enter production.

## Profiling Protocol

Run one warm-up and three measured unchanged-algorithm timing fixtures on the
same source revision, fixture, CRS, build profile, and CPU backend. Three runs
are sufficient for attribution because this stage does not make an acceptance
decision.

For every call site and aggregate total, report:

- degree scan;
- polynomial resize;
- coefficient allocation, copy, and compaction;
- archived CRS traversal and point conversion;
- MSM allocation and execution;
- output conversion;
- classified versus outer-boundary residual.

Do not implement or benchmark a cache before this profile is complete.

## Candidate Selection After Profiling

Only material boundaries may become subcandidates. Potential choices include:

- one eagerly decoded full `xy_powers` grid retained by `SigmaHolder`;
- retained decoded active rectangles keyed by exact
  `(target_x_size, target_y_size)`;
- reusable compact scalar and affine buffers keyed by shape;
- retained commitment metadata and CRS index maps;
- a device-resident MSM input path supported by the same ICICLE dispatcher.

Memory use, including retaining the full decoded CRS and duplicate
shape-specific rectangles, is not a rejection criterion. Candidate selection
must minimize execution time and include cache construction in the lifecycle
that owns it.

Unsafe reinterpretation of archived bytes as ICICLE points is excluded unless
a formal byte-layout and field-representation contract is established.

Each selected subcandidate must then pass its own isolated correctness,
isolated boundary, five-pair E2E, project-owner decision, production
integration, and production timing gates. No subcandidate is approved by this
profiling report.
