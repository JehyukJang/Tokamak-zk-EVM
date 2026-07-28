# CRS-To-MSM Input Preparation Profiling

## Decision Status

Candidate 5 diagnostic profiling and the three approved Phase 1 host-cache
experiments are complete. Options A and C established first-proof and
cache-reuse improvements; Option B established only a cache-reuse improvement.
The project owner selected Option A as the Phase 1 finalist. Phase 2 must
compare Option A alone with Option A plus Option D. Phase 2 correctness and
CUDA performance measurements are complete. First-proof improvement was not
established, while reused-proof improvement was established. The final
production choice is blocked on the project-owner decision. No cache,
representation change, or production optimization has entered the production
branch.

## Source And Environment

- Production baseline: `e30506c16`
- Option A experiment: `4cf658b4a`
- Option B experiment: `44f8f29d1`
- Option C experiment: `f030bf727`
- Phase 2 experiment: `13c7e0924`
- Phase 2 CPU backend: ICICLE CPU fallback on Apple M4 Pro
- Phase 2 CUDA backend: ICICLE v3.8.0 on NVIDIA A10 with 23,028 MiB
- Primary metric for any later candidate: end-to-end `total_wall`
- Diagnostic source: `prove/optimization/timing.local.cpu.current.json`
- Experiment isolation: dedicated worktree and experiment-only branches

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
distinct shape requires approximately 16.79 million points, or 1.50 GiB of raw
point storage before allocator overhead. The repeated 4097-by-257 shape
accounts for most reuse.

The project owner required each of the following host-cache architectures to
be tested independently before selecting a Phase 1 finalist:

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
  retains about 1.50 GiB of raw point storage; it removes only duplicate-shape
  decode work.
- Expected use: unlikely to outperform Option A on first-proof `total_wall`,
  but useful if repeated proofs dominate.

### Option C: Full Grid Plus Shape Cache

Decode the full grid once, then copy each exact active rectangle into a retained
shape cache on first use.

- Advantage: only 4.19 million field decodes, compact MSM inputs are reused,
  and repeated commitment shapes avoid later allocation and gathering.
- Cost: approximately 1.88 GiB of raw point storage retained between the full
  grid and compact shape vectors, plus one first-use copy per distinct shape;
  requires thread-safe cache ownership because commitments may run
  concurrently.
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

The profiling evidence rejected degree, resize, coefficient compaction, and the
thin Y commitments as first Candidate 5 targets.

## Phase 1 Correctness

Each option was implemented on an isolated experiment branch. The focused
tests compared exact G1 outputs and post-optimization polynomial metadata
against the unchanged implementation. Each option also passed the complete
release `timing,testing-mode` parity fixture, fresh preprocess/prove/verify, and
a second proof executed by the same `Prover`. Every fresh proof verified as
`true`.

The five measurements for each option used alternating baseline and candidate
execution. First-proof results include cache construction. Reused-proof results
measure a second proof from the same prover instance. Raw timing JSON, proof,
and preprocess artifacts remain under ignored experiment directories and no
experiment code entered the production branch.

## Option A Results

Option A decodes and retains the 4,194,304-point full grid, approximately
384 MiB at 96 bytes per affine point. It still gathers approximately 19.95
million active bases into compact vectors during each proof.

| pair | baseline first | Option A first | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 38.670327 s | 38.047879 s | 0.622448 s |
| 2 | 38.550343 s | 38.038809 s | 0.511534 s |
| 3 | 38.950966 s | 38.013384 s | 0.937582 s |
| 4 | 38.823246 s | 37.908618 s | 0.914628 s |
| 5 | 40.844997 s | 38.305743 s | 2.539254 s |
| **mean** | **39.167976 s** | **38.062887 s** | **1.105089 s** |

The paired first-proof 95% confidence interval is 0.083748 to 2.126431
seconds. The baseline and candidate medians are 38.823246 and 38.038809
seconds; their ranges are 2.294654 and 0.397125 seconds.

| pair | baseline reused | Option A reused | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 33.750363 s | 32.343459 s | 1.406904 s |
| 2 | 33.478771 s | 32.150900 s | 1.327871 s |
| 3 | 33.362732 s | 32.338259 s | 1.024473 s |
| 4 | 34.113701 s | 32.428911 s | 1.684790 s |
| 5 | 34.385636 s | 33.759853 s | 0.625783 s |
| **mean** | **33.818241 s** | **32.604276 s** | **1.213964 s** |

The paired reused-proof 95% confidence interval is 0.711995 to 1.715934
seconds. The baseline and candidate medians are 33.750363 and 32.343459
seconds; their ranges are 1.022905 and 1.608953 seconds.

For first proofs, baseline archive decoding averaged 1.133925 seconds. Option A
instead averaged 0.256072 seconds to construct the full cache and 0.119807
seconds to gather active rectangles. Reused proofs still spent 0.085732 seconds
gathering, while the baseline spent 1.087929 seconds decoding.

## Option B Results

Option B builds compact exact-shape caches directly from the archive. It
decoded and retained 16,791,691 points across ten shapes, approximately
1.50 GiB of raw point storage before allocator and map overhead. Four
commitments reused an earlier shape during the first proof; all 14 hit the
cache during the second proof.

| pair | baseline first | Option B first | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 38.691405 s | 38.648986 s | 0.042419 s |
| 2 | 38.717706 s | 40.192866 s | -1.475160 s |
| 3 | 40.510573 s | 38.748630 s | 1.761943 s |
| 4 | 39.085121 s | 38.692035 s | 0.393086 s |
| 5 | 38.631759 s | 38.869129 s | -0.237370 s |
| **mean** | **39.127313 s** | **39.030329 s** | **0.096984 s** |

The paired first-proof 95% confidence interval is -1.351854 to 1.545821
seconds, so a first-proof improvement was not established. The baseline and
candidate medians are 38.717706 and 38.748630 seconds; their ranges are
1.878814 and 1.543880 seconds.

| pair | baseline reused | Option B reused | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 33.323909 s | 32.298623 s | 1.025287 s |
| 2 | 33.669798 s | 32.342630 s | 1.327168 s |
| 3 | 34.296523 s | 32.810996 s | 1.485527 s |
| 4 | 33.411111 s | 32.275578 s | 1.135532 s |
| 5 | 33.259649 s | 32.480578 s | 0.779071 s |
| **mean** | **33.592198 s** | **32.441681 s** | **1.150517 s** |

The paired reused-proof 95% confidence interval is 0.811997 to 1.489037
seconds. The baseline and candidate medians are 33.411111 and 32.342630
seconds; their ranges are 1.036875 and 0.535418 seconds.

For first proofs, baseline archive decoding averaged 1.181759 seconds and
Option B shape construction averaged 1.101788 seconds. Reused cache access
averaged 0.000024 seconds, while baseline archive decoding averaged 1.135974
seconds.

## Option C Results

Option C retains both the 4,194,304-point decoded full grid and 16,791,691
points in exact-shape caches. The 20,985,995 stored points require
approximately 1.88 GiB of raw point storage before allocator and map overhead.
Four commitments reused a shape during the first proof; all 14 hit the shape
cache during the second proof.

| pair | baseline first | Option C first | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 39.406301 s | 38.761319 s | 0.644982 s |
| 2 | 39.621069 s | 38.507444 s | 1.113624 s |
| 3 | 39.569381 s | 38.422901 s | 1.146480 s |
| 4 | 39.541434 s | 38.654230 s | 0.887204 s |
| 5 | 39.229935 s | 38.458693 s | 0.771243 s |
| **mean** | **39.473624 s** | **38.560917 s** | **0.912707 s** |

The paired first-proof 95% confidence interval is 0.643981 to 1.181432
seconds. The baseline and candidate medians are 39.541434 and 38.507444
seconds; their ranges are 0.391133 and 0.338419 seconds.

| pair | baseline reused | Option C reused | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 33.927221 s | 32.681855 s | 1.245366 s |
| 2 | 34.571246 s | 32.636581 s | 1.934665 s |
| 3 | 33.962158 s | 32.445001 s | 1.517157 s |
| 4 | 33.847450 s | 32.848147 s | 0.999303 s |
| 5 | 33.811665 s | 32.737557 s | 1.074107 s |
| **mean** | **34.023948 s** | **32.669828 s** | **1.354120 s** |

The paired reused-proof 95% confidence interval is 0.881413 to 1.826827
seconds. The baseline and candidate medians are 33.927221 and 32.681855
seconds; their ranges are 0.759582 and 0.403146 seconds.

For first proofs, baseline archive decoding averaged 1.145008 seconds. Option C
instead averaged 0.253789 seconds to construct the full grid and 0.189081
seconds to construct shape caches. Reused cache access averaged 0.000019
seconds, while baseline archive decoding averaged 1.108804 seconds.

## Phase 1 Comparison And Decision

| option | E2E first-proof mean improvement | paired 95% interval | reused-proof supporting improvement | paired 95% interval | retained raw points |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 1.105089 s | 0.083748 to 2.126431 s | 1.213964 s | 0.711995 to 1.715934 s | about 384 MiB |
| B | 0.096984 s | -1.351854 to 1.545821 s | 1.150517 s | 0.811997 to 1.489037 s | about 1.50 GiB |
| C | 0.912707 s | 0.643981 to 1.181432 s | 1.354120 s | 0.881413 to 1.826827 s | about 1.88 GiB |

The first-proof column is the canonical timing-table E2E `total_wall`: it starts
before `Prover::init` and includes initialization and all proof stages. The
reused-proof column executes all proof stages again on the same initialized
`Prover`, so it excludes initialization and is supporting evidence rather than
the acceptance metric.

The earlier Option C recommendation incorrectly gave the supporting reused
measurement decision weight. It is withdrawn. Options A and C independently
established E2E improvement against their respective baselines, while Option B
did not. The Phase 1 experiments were run in separate sessions and therefore
do not establish a direct A-versus-C performance ordering.

The project owner selected Option A as the Phase 1 finalist. Phase 2 must
compare Option A alone with Option A combined with Option D. That comparison
was initially deferred until a CUDA test machine became available. The
following section records the completed Phase 2 experiment; the Phase 1
selection did not itself authorize production integration.

## Phase 2 Device-Residency Experiment

Experiment commit `13c7e0924` retains Option A's complete decoded host grid and
adds a device-resident cache keyed by the exact active CRS rectangle
`(x_size, y_size)`. On a cache miss, the experiment gathers the compact
row-major base vector from the decoded grid, allocates a typed ICICLE
`DeviceVec<G1Affine>`, copies the bases to the active device, and retains the
allocation for the prover lifetime. On a hit, the MSM dispatcher receives the
same typed device slice directly.

The implementation:

- uses the same prove control flow on the ICICLE CPU and CUDA backends;
- does not inspect the active backend;
- does not add a host fallback;
- keeps the cache lock only through first construction and returns an `Arc`
  before invoking MSM;
- includes full-grid decoding, device allocation, initial transfer, and cache
  lifetime in the measured prover lifecycle.

### Correctness

The focused commitment test compared the archive baseline, Option A, and
Option A+D exactly for zero, constant, X-only, Y-only, sparse, and dense
polynomials. Polynomial metadata also matched exactly.

The following gates passed:

- focused CPU and CUDA device-base commitment parity;
- all `libs` tests on CPU and CUDA: `43 passed; 0 failed; 3 ignored`;
- complete CPU and CUDA release `timing,testing-mode` Option A+D versus
  Option A parity;
- fresh CUDA preprocess, Option A+D proof generation, and verification.

The fresh verifier result was `true`. During the CUDA parity fixture,
`nvidia-smi` observed approximately 3.8 GiB of device memory in use, within the
NVIDIA A10's 23,028 MiB capacity.

### CUDA Benchmark Protocol

Option A and Option A+D each received one unmeasured warm-up. Five measured
pairs alternated execution order:

1. A, A+D;
2. A+D, A;
3. A, A+D;
4. A+D, A;
5. A, A+D.

Each invocation recorded both the complete first proof, including
`Prover::init` and cache construction, and a second proof using the same
prover and retained cache. Runs used the release profile with `timing` only on
the same A10, source revision, CRS, QAP, synthesizer output, and ICICLE v3.8.0
CUDA backend.

### First-Proof Results

| pair | Option A | Option A+D | A minus A+D |
| ---: | ---: | ---: | ---: |
| 1 | 23.105823 s | 22.816105 s | 0.289718 s |
| 2 | 23.262647 s | 23.303093 s | -0.040446 s |
| 3 | 23.157733 s | 22.802643 s | 0.355090 s |
| 4 | 23.188531 s | 23.443928 s | -0.255397 s |
| 5 | 23.712127 s | 23.130695 s | 0.581433 s |
| **mean** | **23.285372 s** | **23.099293 s** | **0.186080 s** |
| **median** | **23.188531 s** | **23.130695 s** | **0.289718 s** |
| **range** | **0.606305 s** | **0.641285 s** | **0.836829 s** |

The paired first-proof delta had a sample standard deviation of `0.332350s`
and a 95% interval of `-0.226587s` to `0.598746s`. Two of five pairs favored
Option A. The primary first-proof `total_wall` metric therefore does not
establish an Option D improvement.

First-proof attribution means were:

| boundary | Option A | Option A+D |
| --- | ---: | ---: |
| full-grid decode | 0.426427 s | 0.436893 s |
| host active-rectangle gather | 0.794167 s | not executed |
| device-cache gather | not executed | 0.659074 s |
| device-cache H2D | not executed | 0.148273 s |
| ICICLE MSM | 1.108153 s | 1.029649 s |

Option A+D replaced `0.794167s` of host gathering with `0.807348s` of initial
device-cache gathering and transfer, while its device-base MSM calls were
`0.078504s` faster on mean. This supports a small local first-proof reduction,
but not the larger and statistically inconclusive E2E mean movement.

### Reused-Proof Results

| pair | Option A | Option A+D | A minus A+D |
| ---: | ---: | ---: | ---: |
| 1 | 21.140451 s | 19.982775 s | 1.157675 s |
| 2 | 21.746369 s | 21.183664 s | 0.562704 s |
| 3 | 22.094405 s | 19.783540 s | 2.310864 s |
| 4 | 21.996917 s | 21.085821 s | 0.911096 s |
| 5 | 23.336713 s | 20.153908 s | 3.182806 s |
| **mean** | **22.062971 s** | **20.437942 s** | **1.625029 s** |
| **median** | **21.996917 s** | **20.153908 s** | **1.157675 s** |
| **range** | **2.196263 s** | **1.400124 s** | **2.620101 s** |

Every reused-proof pair favored Option A+D. The paired delta had a sample
standard deviation of `1.090148s` and a 95% interval of `0.271432s` to
`2.978627s`.

Option A continued to spend `0.802261s` gathering active rectangles on each
reused proof. Option A+D replaced that work with cache lookups totaling less
than `0.009ms` and also reduced mean ICICLE MSM time from `1.080972s` to
`1.006275s`. The directly attributed reused-proof saving was approximately
`0.876958s`; the remaining E2E movement is neighboring-stage variation and is
not attributed to Option D.

### Phase 2 Recommendation And Blocker

Option D establishes a reused-proof improvement but does not pass the
campaign's primary first-proof `total_wall` gate. Under the current acceptance
policy, the recommendation is to retain Option A without D. Selecting A+D
would require an explicit project-owner decision that repeated proofs from one
initialized prover outweigh the unestablished first-proof benefit and the
additional device-cache implementation.

Phase 2 experimentation is complete. Production integration is blocked until
the project owner selects Option A or Option A+D.
