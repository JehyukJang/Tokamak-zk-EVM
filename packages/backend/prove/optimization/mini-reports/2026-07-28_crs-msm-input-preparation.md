# CRS-To-MSM Input Preparation Profiling

## Decision Status

Candidate 5 diagnostic profiling is complete. Archived CRS point decoding is
the only dominant preparation boundary. Selecting a cache architecture requires
a project-owner decision before candidate implementation begins. No cache,
representation change, or production optimization has been implemented.

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

## Profiling Implementation And Correctness

Detached experiment commit `0bf9ff8bf` split the existing timing-mode
`optimize_size` call into the identical degree scan, metadata update, and resize
sequence, then placed non-overlapping timers around every preparation step. The
non-timing implementation remained unchanged.

An experiment-only focused test reconstructed the previous commitment
implementation as the oracle. Exact G1 outputs and post-optimization polynomial
metadata matched for zero, constant, X-only, Y-only, lower-degree sparse, and
dense polynomials backed by an rkyv-archived CRS.

The complete release `timing,testing-mode` fixture passed. A fresh preprocess
artifact and timing-feature proof were generated from matching inputs, and the
existing verifier returned `true`.

The relevant commands were:

```text
cargo test --release -p libs --features timing --lib profiled_encode_poly_matches_legacy_commitment -- --nocapture
cargo test --release -p prove --features timing,testing-mode --test timing timing_prove_stages -- --nocapture
cargo run --release -p preprocess -- ...
cargo run --release -p prove --features timing -- ...
cargo run --release -p verify -- ...
```

## Three-Run Profile

One unchanged-algorithm timing run was used as warm-up. The three measured
`total_wall` samples were:

| run | `total_wall` |
| ---: | ---: |
| 1 | 36.462912 s |
| 2 | 36.428467 s |
| 3 | 36.528519 s |
| mean | 36.473299 s |

The aggregate commitment profile was:

| boundary | run 1 | run 2 | run 3 | mean |
| --- | ---: | ---: | ---: | ---: |
| outer `encode_call` | 20.213296 s | 20.177704 s | 20.297361 s | 20.229454 s |
| degree scan | 0.063758 s | 0.063291 s | 0.066643 s | 0.064564 s |
| polynomial resize | 0.031444 s | 0.031080 s | 0.031913 s | 0.031479 s |
| coefficient allocation | 0.011220 s | 0.011218 s | 0.011280 s | 0.011239 s |
| coefficient copy | 0.022007 s | 0.021670 s | 0.021900 s | 0.021859 s |
| coefficient compaction | 0.022098 s | 0.020476 s | 0.020495 s | 0.021023 s |
| archived CRS decode | 1.179614 s | 1.202041 s | 1.195409 s | 1.192355 s |
| MSM allocation | 0.000010 s | 0.000011 s | 0.000009 s | 0.000010 s |
| ICICLE MSM | 18.882804 s | 18.827586 s | 18.949357 s | 18.886582 s |
| output conversion | 0.000185 s | 0.000184 s | 0.000206 s | 0.000192 s |
| unclassified residual | 0.000156 s | 0.000146 s | 0.000148 s | 0.000150 s |

The classified spans reconcile with the outer boundary to within 0.150
milliseconds on mean. Excluding MSM, mean preparation was 1.342872 seconds:

- archived CRS traversal and point decoding: 1.192355 seconds, or 88.8%;
- degree scan and polynomial resize: 0.096043 seconds, or 7.2%;
- coefficient allocation, copy, and compaction: 0.054121 seconds, or 4.0%;
- remaining allocation, output, and residual work: 0.000353 seconds.

The dominant per-call CRS decode means were:

| call site | active shape | CRS decode |
| --- | ---: | ---: |
| prove2 `Q_CX` | 8192 by 511 | 0.262635 s |
| prove4 `Pi_X` | 8191 by 511 | 0.249846 s |
| prove0 `Q_AX` | 4097 by 511 | 0.129683 s |
| prove2 `Q_CY` | 8191 by 257 | 0.123456 s |
| prove0 `U` | 4097 by 257 | 0.064419 s |
| prove0 `B` | 4098 by 258 | 0.061625 s |
| prove1 `R` | 4097 by 257 | 0.061242 s |
| prove0 `Q_AY` | 4097 by 257 | 0.059982 s |
| prove0 `W` | 4099 by 259 | 0.059593 s |
| prove0 `V` | 4097 by 257 | 0.059503 s |
| prove4 `M_N_X` | 4096 by 256 | 0.060305 s |

The three thin Y commitments together contributed less than 0.067
milliseconds of CRS decode and are not independent optimization targets.

## Cache Architecture Decision

The fixture traverses approximately 19.95 million active CRS points across the
14 commitments. The complete archived grid contains 4,194,304 points. Assuming
the current 96-byte ICICLE affine representation, a decoded full grid is about
384 MiB.

There are ten distinct active shapes. Retaining one compact affine vector per
distinct shape requires approximately 16.79 million points, or 1.54 GiB, before
allocator overhead. The repeated 4097-by-257 shape accounts for most reuse.

The project owner must select which independent experiments to run:

### Option A: Full Decoded Grid

Decode the complete 8192-by-512 grid once in `SigmaHolder` and retain it for the
prover lifetime. Each commitment gathers its active rectangle into a compact
affine vector.

- Advantage: only 4.19 million field decodes instead of 19.95 million; simplest
  ownership and about 384 MiB retained memory.
- Cost: every commitment still allocates and copies its compact affine input,
  including repeated shapes.
- Expected use: establishes the lowest-complexity decoded-cache baseline.

### Option B: Archive-Direct Shape Cache

Decode each exact active rectangle on first use and retain it by
`(target_x_size, target_y_size)`.

- Advantage: repeated shapes reuse the final compact MSM base vector with no
  per-call gathering.
- Cost: first-proof construction still decodes about 16.79 million points and
  retains about 1.54 GiB; it removes only duplicate-shape decode work.
- Expected use: unlikely to outperform Option A on first-proof `total_wall`,
  but useful if repeated proofs dominate.

### Option C: Full Grid Plus Shape Cache

Decode the full grid once, then copy each exact active rectangle into a retained
shape cache on first use.

- Advantage: only 4.19 million field decodes, compact MSM inputs are reused,
  and repeated commitment shapes avoid later allocation and gathering.
- Cost: approximately 1.92 GiB retained between the full grid and compact shape
  vectors, plus one first-use copy per distinct shape; requires thread-safe
  cache ownership because commitments may run concurrently.
- Expected use: strongest execution-time candidate under the package policy
  that permits aggressive memory use.

### Option D: Device-Resident Cache

Retain decoded bases or compact shapes in ICICLE device memory and submit them
directly to the same MSM dispatcher.

- Advantage: may remove repeated host-to-device MSM base transfers, especially
  on CUDA.
- Cost: larger implementation and validation surface; no CUDA test machine is
  currently available, and CPU benefit is unproven.
- Expected use: separate follow-up after a host decoded-cache baseline, not the
  first Candidate 5 implementation.

The profiling evidence rejects degree, resize, coefficient compaction, and the
thin Y commitments as first Candidate 5 targets. No cache option may proceed
until the project owner chooses the experiment scope.
