# July Rebenchmark And Final Disposition

## Audience

This report is the authoritative cross-candidate record for native backend
maintainers. It preserves the corrected July CPU/CUDA comparison, rejected and
unimplemented paths, project-owner decisions, and the later production state.

## Scope And Method

Every reopened path passed focused parity, complete-fixture parity, fresh
proof generation, and verification on CPU and CUDA before timing. Performance
uses first-proof end-to-end `total_wall` only. Each path has five measured CPU
samples and five measured CUDA samples with rotated execution order and
production controls before and after each family.

CPU used the existing local v2.1 CRS. CUDA used the independently downloaded
published v2.1 CRS on the Lambda Cloud host. The files were version-compatible
but were not required to be byte-identical. No local CRS download or
local-to-remote CRS transfer occurred.

The benchmark source was pinned at
`ccd7f49cc60000699b5610802bfad1604d621e05`, whose merge base with
`origin/main` was `c13e8067dc538ee78504514f1dc82f5652bf4e93`. Production
integration occurred later and is recorded separately below.

## Source, Fixture, And Environments

- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- Cargo: `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`
- ICICLE: tag `v3.8.0`, commit
  `42b4f9a36deee586233bc3e3d058ad567abb87a4`
- `Cargo.lock` SHA-256:
  `34cd73ea9793e282eb706e9265de428eb38721ad741b6dedbf40479772297467`
- Timing test SHA-256:
  `cd112497b2bc47bde1ac3e005a092f9e8469536cb6b82fc7f75a675461ad88a2`
- Setup: `l=728`, `l_D=4824`, `m_D=26591`, `n=4096`, `s_D=14`,
  `s_max=256`
- CPU: Apple M4 Pro, 48 GiB RAM, macOS 26.5.2 build 25F84, ICICLE CPU
  backend
- CUDA: Lambda Cloud NVIDIA A10, 30 Intel Xeon Platinum 8358 vCPUs,
  222 GiB RAM, driver 580.105.08, CUDA toolkit 12.8, ICICLE CUDA 12.2
  backend

CPU used the existing local v2.1 CRS. CUDA downloaded the published v2.1 CRS
directly from Google Drive and
`@tokamak-zk-evm/subcircuit-library@2.1.3` directly from npm. The two CRS
copies were version-compatible but intentionally not required to be
byte-identical. The remote CRS hashes were:

| artifact | SHA-256 |
| --- | --- |
| `combined_sigma.rkyv` | `11148a5deae2d921cc3b646d4f522e49d6f4216c02c32fea3dea012726c9ace6` |
| `sigma_preprocess.rkyv` | `05af9715c41aa6d8c3c510df9e4c6e3e3b20eb0b2ac5ac001111b5225599f4a0` |
| `sigma_verify.json` | `43315b9282cc57ea5d0dd6c78d108e2524d3e9a58b46d18729fc4433f3e68321` |

The timing command for every retained performance run was:

```text
cargo test --release -p prove --features timing --test timing -- --nocapture
```

Performance runs did not enable `testing-mode`. Every candidate first passed
focused parity, complete-fixture parity, fresh proof generation, and
verification on both environments. Those correctness runs were not timing
samples.

## Validity And Excluded Evidence

- An initial CPU qualification block at `37.437103`, `37.515893`, and
  `40.095582` seconds was invalidated in full. The third run coincided with
  broad stage slowdown, approximately 52% CPU use by `duetexpertd`, and
  increased helper-process load.
- Earlier 38- and 39-second Candidate 2B runs were discarded after the project
  owner confirmed concurrent CPU use. They do not appear in the retained
  tables.
- Three earlier CUDA production runs in the 35-second range came from a
  degraded host. A clean replacement A10 restored the same fixture to the
  23-second range, so the 35-second block is environment-failure evidence and
  has no candidate decision weight.
- APFS-cloned Cargo targets initially reused stale Candidate 1B and Candidate 2
  binaries. Those runs were quarantined. Both targets were force-cleaned and
  candidate-specific events were checked before collecting the retained runs.
- Candidate 5 Options B and C initially shared a Cargo target, creating an
  artifact-reuse risk. Those focused results were discarded; the retained
  results came from distinct targets and freshly validated binaries.
- All 181 retained CUDA timing JSON files and 11 telemetry files matched the
  preserved SHA-256 manifest. Every measured family reached 100% GPU
  utilization, 1695 MHz SM clock, and PCIe Gen4. No retained CUDA test failed.

## Retained First-Proof Samples

All values below are end-to-end `total_wall` seconds. Each row contains all
five retained samples; no post-hoc outlier was removed.

### CPU

| family | path | samples | mean | median | range |
| --- | --- | --- | ---: | ---: | ---: |
| 1A | current | 37.099682, 38.655066, 41.618969, 37.233031, 37.051421 | 38.331634 | 37.233031 | 4.567548 |
| 1A | legacy | 39.830364, 39.533316, 41.153161, 39.605186, 39.866413 | 39.997688 | 39.830364 | 1.619845 |
| 1B | current | 37.311742, 37.039291, 37.252677, 37.117666, 37.061839 | 37.156643 | 37.117666 | 0.272451 |
| 1B | legacy | 38.646055, 38.562378, 38.344862, 38.413250, 38.357129 | 38.464735 | 38.413250 | 0.301193 |
| 2 | ICICLE Batch | 37.202704, 36.971867, 37.132293, 37.212161, 37.097199 | 37.123245 | 37.132293 | 0.240294 |
| 2 | legacy | 37.969198, 37.888517, 37.689017, 37.968671, 38.032345 | 37.909550 | 37.968671 | 0.343328 |
| 2 | adjusted | 37.787678, 37.891995, 37.966170, 37.732682, 37.647613 | 37.805228 | 37.787678 | 0.318557 |
| 2 | Serial | 37.108667, 36.956376, 36.937052, 37.014307, 36.936874 | 36.990655 | 36.956376 | 0.171794 |
| 2 | Rayon | 36.859087, 36.790388, 36.651871, 36.706469, 36.819955 | 36.765554 | 36.790388 | 0.207216 |
| 2C | legacy | 37.015424, 37.124660, 37.035453, 37.122807, 36.854039 | 37.030477 | 37.035453 | 0.270621 |
| 2C | candidate | 36.645971, 36.936926, 36.722681, 36.814063, 36.820570 | 36.788042 | 36.814063 | 0.290955 |
| 2D | grouped | 36.923064, 37.163316, 37.324821, 36.910134, 37.173222 | 37.098911 | 37.163316 | 0.414686 |
| 2D | independent | 37.499973, 37.384767, 37.522554, 37.215475, 37.712906 | 37.467135 | 37.499973 | 0.497431 |
| 3A | legacy | 37.112861, 37.151528, 37.132107, 36.900690, 37.148645 | 37.089166 | 37.132107 | 0.250837 |
| 3A | candidate | 36.889031, 37.111440, 36.780291, 37.007984, 37.263929 | 37.010535 | 37.007984 | 0.483638 |
| 4 | legacy | 37.141678, 37.210863, 36.814244, 37.054104, 37.174839 | 37.079145 | 37.141678 | 0.396619 |
| 4 | X | 37.109851, 36.831132, 36.957143, 37.091325, 37.036547 | 37.005200 | 37.036547 | 0.278719 |
| 4 | Y | 36.951781, 37.082349, 36.965965, 37.063077, 36.822942 | 36.977223 | 36.965965 | 0.259407 |
| 4 | X+Y | 37.184824, 36.866537, 37.169676, 37.332823, 37.058973 | 37.122566 | 37.169676 | 0.466286 |
| 5 | Option A | 37.482999, 36.889703, 37.079856, 37.277461, 37.007305 | 37.147465 | 37.079856 | 0.593296 |
| 5 | archive | 37.898398, 37.954672, 37.877540, 37.891072, 37.725192 | 37.869375 | 37.891072 | 0.229480 |
| 5 | Option B | 38.339442, 37.849685, 37.917848, 37.918829, 37.745342 | 37.954230 | 37.917848 | 0.594100 |
| 5 | Option C | 37.149608, 37.162164, 37.381917, 37.045368, 37.366287 | 37.221069 | 37.162164 | 0.336549 |
| 6 | full input | 37.603703, 38.310766, 39.759029, 37.483826, 37.738672 | 38.179199 | 37.738672 | 2.275204 |
| 6 | `O_mid` | 37.227195, 37.323779, 37.334361, 37.521530, 37.401541 | 37.361681 | 37.334361 | 0.294335 |
| 6 | `O_prv` | 37.170716, 37.228395, 38.250419, 37.742769, 37.234622 | 37.525384 | 37.234622 | 1.079703 |
| 6 | both | 37.422621, 37.405464, 38.654451, 37.305889, 37.271472 | 37.611980 | 37.405464 | 1.382980 |

CPU production controls before and after each family were:

| family | before | after |
| --- | ---: | ---: |
| 1A | 37.002451 | 37.242372 |
| 1B | 37.151542 | 37.102478 |
| 2 | 36.989912 | 36.961030 |
| 2C | 37.192262 | 36.955810 |
| 2D | 37.107222 | 37.016362 |
| 3A | 37.361802 | 36.862387 |
| 4 | 36.995542 | 37.132208 |
| 5 | 37.342537 | 36.843988 |
| 6 | 37.182565 | 37.329540 |

### CUDA

| family | path | samples | mean | median | range |
| --- | --- | --- | ---: | ---: | ---: |
| 1A | current | 24.014422, 23.145252, 23.668989, 24.007392, 23.578263 | 23.682864 | 23.668989 | 0.869170 |
| 1A | legacy | 23.737154, 23.597295, 23.576469, 24.264238, 24.216788 | 23.878389 | 23.737154 | 0.687768 |
| 1B | current | 23.783975, 23.811418, 23.248017, 23.983008, 23.963755 | 23.758035 | 23.811418 | 0.734990 |
| 1B | legacy | 24.879060, 24.825814, 24.705068, 24.503302, 24.886085 | 24.759866 | 24.825814 | 0.382783 |
| 2 | ICICLE Batch | 23.438072, 23.852355, 23.575864, 24.169573, 23.854588 | 23.778090 | 23.852355 | 0.731501 |
| 2 | legacy | 24.128546, 23.867002, 23.795482, 24.323642, 24.353911 | 24.093717 | 24.128546 | 0.558429 |
| 2 | adjusted | 23.972934, 23.639034, 23.969505, 24.081314, 24.056312 | 23.943820 | 23.972934 | 0.442281 |
| 2 | Serial | 24.087623, 24.729522, 24.269998, 24.552259, 24.531154 | 24.434111 | 24.531154 | 0.641899 |
| 2 | Rayon | 23.768764, 24.228083, 23.724914, 23.705367, 23.426870 | 23.770799 | 23.724914 | 0.801213 |
| 2C | legacy | 23.696234, 23.822014, 23.715952, 23.900758, 23.679587 | 23.762909 | 23.715952 | 0.221171 |
| 2C | candidate | 23.591595, 23.607855, 23.704695, 24.585497, 23.597341 | 23.817396 | 23.607855 | 0.993901 |
| 2D | grouped | 23.799853, 23.899502, 23.778938, 23.737000, 23.997922 | 23.842643 | 23.799853 | 0.260922 |
| 2D | independent | 23.394082, 23.903575, 23.817241, 23.439391, 23.370280 | 23.584914 | 23.439391 | 0.533295 |
| 3A | legacy | 23.669692, 23.544595, 23.439292, 23.463163, 23.797869 | 23.582922 | 23.544595 | 0.358577 |
| 3A | candidate | 23.766896, 23.821110, 23.977269, 23.591160, 23.449509 | 23.721188 | 23.766896 | 0.527760 |
| 4 | legacy | 23.700147, 24.111309, 23.668061, 23.430092, 24.005119 | 23.782945 | 23.700147 | 0.681218 |
| 4 | X | 23.758036, 23.653003, 23.480223, 23.526925, 23.175593 | 23.518756 | 23.526925 | 0.582443 |
| 4 | Y | 23.884773, 23.769170, 23.329342, 23.979633, 23.288043 | 23.650192 | 23.769170 | 0.691590 |
| 4 | X+Y | 23.607398, 23.626527, 23.526451, 23.358981, 23.443294 | 23.512530 | 23.526451 | 0.267546 |
| 5 | Option A | 24.068350, 23.679405, 23.905399, 23.823985, 24.093438 | 23.914115 | 23.905399 | 0.414033 |
| 5 | archive | 24.526264, 25.141308, 25.213847, 24.886066, 24.831691 | 24.919835 | 24.886066 | 0.687583 |
| 5 | Option B | 25.122549, 25.386656, 24.881768, 25.067448, 25.231863 | 25.138057 | 25.122549 | 0.504888 |
| 5 | Option C | 24.677447, 24.175831, 24.087209, 24.970975, 24.344353 | 24.451163 | 24.344353 | 0.883767 |
| 6 | full input | 23.789433, 23.799971, 23.913499, 24.461204, 23.718596 | 23.936541 | 23.799971 | 0.742609 |
| 6 | `O_mid` | 23.967116, 23.922981, 23.629332, 23.585398, 24.051187 | 23.831203 | 23.922981 | 0.465789 |
| 6 | `O_prv` | 23.754543, 23.580211, 23.808208, 23.314911, 24.501565 | 23.791888 | 23.754543 | 1.186654 |
| 6 | both | 23.652123, 23.436975, 23.436326, 23.375165, 23.988941 | 23.577906 | 23.436975 | 0.613775 |

CUDA production controls before and after each family were:

| family | before | after |
| --- | ---: | ---: |
| 1A | 23.737328 | 23.664848 |
| 1B | 23.794243 | 23.334063 |
| 2 | 23.940852 | 23.359740 |
| 2C | 24.256762 | 24.053972 |
| 2D | 24.130705 | 23.485570 |
| 3A | 23.736218 | 23.537681 |
| 4 | 24.104620 | 23.264654 |
| 5 | 24.207610 | 23.704387 |
| 6 | 23.733032 | 24.221609 |

## Classification Rule

The classification is based on what removes the work, not on the identity used
only to prove correctness:

- **Algebraic optimization:** changes the mathematical expression through an
  identity or invariant and thereby removes a proof-level operation regardless
  of backend or memory layout.
- **Algorithmic optimization:** evaluates the same expression with a different
  backend-independent algorithm that shares intermediate work.
- **Implementation optimization:** preserves the mathematical operation count
  and seeks speed through API batching, memory placement, caching, data layout,
  threading, allocation, or input preparation.

Zero-scalar MSM compaction is an implementation optimization. Although
`0 * G = 0` proves correctness, the optimization itself is a scan, allocation,
copy, and compact-input policy whose result depends on the active MSM
implementation.

## Corrected Algebraic Comparisons

Every delta below compares the algebraic candidate with the same source after
removing only that identity. Negative values favor the algebraic candidate.
Values are five-run first-proof `total_wall` means. Median values are included
where anomalous samples materially affect interpretation.

| candidate | removed mathematical work | CPU mean comparison | CUDA mean comparison | corrected result |
| --- | --- | --- | --- | --- |
| 1A combined Pi | combine `Pi_A + Pi_C + kappa1^4 * Pi_B` before opening, reducing three Ruffini splits and five commitments to one split and two commitments | `38.332` vs `39.998`, delta `-1.666 s`; medians `37.233` vs `39.830` | `23.683` vs `23.878`, delta `-0.196 s` | faster on both; CPU means contain anomalous slow samples but the median direction agrees |
| 1B shared M/N X opening | reuse the identical M/N X quotient and commitment instead of calculating both independently | `37.157` vs `38.465`, delta `-1.308 s` | `23.758` vs `24.760`, delta `-1.002 s` | clear improvement on both |
| 2A adjusted-point identity | evaluate `scaleX/scaleY(P)` by adjusting the evaluation point instead of materializing scaled polynomials; both paths still perform three independent evaluations | `37.805` vs `37.910`, delta `-0.104 s` | `23.944` vs `24.094`, delta `-0.150 s` | faster on both; the previous table incorrectly compared this intermediate path with the already shared 2B path |
| 2C derived difference evaluations | derive `r_D1` and `r_D2` scalar values by subtraction instead of evaluating materialized difference polynomials | `36.788` vs `37.030`, delta `-0.242 s`; medians `36.814` vs `37.035` | `23.817` vs `23.763`, delta `+0.054 s`; medians `23.608` vs `23.716` | CPU faster; CUDA inconclusive because the mean and median disagree and the candidate contains a `24.585 s` sample |
| 3A constant-free Ruffini | divide the original polynomial and correct only the remainder instead of materializing a full constant-subtracted numerator | `37.011` vs `37.089`, delta `-0.079 s` | `23.721` vs `23.583`, delta `+0.138 s` | CPU movement is noise-level and CUDA is slower in this block; owner approval is algebraic, not performance-based |

Candidates 1A, 1B, and 2A were already represented in production at the
benchmark revision. Candidates 2C and 3A were subsequently integrated in
commits `6c132c3d8` and `627821017`.

## Corrected Algorithmic Comparison

Candidate 2B's backend-independent algorithm evaluates three related challenge
points together and shares their common row reductions. Its correct comparator
is Candidate 2A's adjusted-point path with three independent evaluations, not
the materialized-scaling path and not another 2B implementation.

| 2B realization | CPU mean vs adjusted independent | CUDA mean vs adjusted independent | interpretation |
| --- | ---: | ---: | --- |
| ICICLE two-stage batch | `37.123` vs `37.805`, delta `-0.682 s` | `23.778` vs `23.944`, delta `-0.166 s` | shared algorithm improves both in the current backend-neutral implementation |
| custom Rust Serial shared pass | `36.991` vs `37.805`, delta `-0.815 s` | `24.434` vs `23.944`, delta `+0.490 s` | CPU gain, material CUDA loss |
| custom Rust Rayon shared pass | `36.766` vs `37.805`, delta `-1.040 s` | `23.771` vs `23.944`, delta `-0.173 s` | fastest CPU mean and effectively tied with ICICLE Batch on CUDA |

The 2B shared-work algorithm is approved. ICICLE Batch, Serial, and Rayon are
implementation realizations of that algorithm. The project owner selected the
ICICLE two-stage Batch implementation and rejected the custom Serial and Rayon
paths.

### Candidate 2B Implementation Selection

The implementation decision must compare the three approved-algorithm
realizations directly, rather than comparing each realization only with the
independent-evaluation algorithm.

| implementation | execution model | CPU mean / median | CUDA mean / median |
| --- | --- | ---: | ---: |
| ICICLE Batch | submit two native batched polynomial-evaluation stages and let the ICICLE dispatcher select its backend | `37.123 / 37.132 s` | `23.778 / 23.852 s` |
| Rust Serial | evaluate the three points through one sequential host traversal | `36.991 / 36.956 s` | `24.434 / 24.531 s` |
| Rust Rayon | evaluate the three points through a parallel host traversal | `36.766 / 36.790 s` | `23.771 / 23.725 s` |

Pairwise implementation deltas are:

| comparison | CPU mean delta | CUDA mean delta | interpretation |
| --- | ---: | ---: | --- |
| Serial minus ICICLE Batch | `-0.133 s` | `+0.656 s` | Serial is slightly faster on CPU and materially slower on CUDA |
| Rayon minus ICICLE Batch | `-0.358 s` | `-0.007 s` | Rayon is faster on CPU and tied with Batch on CUDA at mean level |
| Rayon minus Serial | `-0.225 s` | `-0.663 s` | Rayon is faster than Serial on both measured backends |

Serial is dominated by Rayon in the retained measurements. ICICLE Batch
preserves native backend dispatch and device-oriented execution. Rayon performs
this boundary on the host and improves CPU `total_wall` by `0.358 s`, while
its CUDA mean differs from Batch by only `0.007 s`. The project owner selected
ICICLE Batch to retain the native backend-dispatched implementation.

## Corrected Implementation Comparisons

### Candidate 2D: Same-Point Evaluation Submission

The grouped path changes dispatcher submission, not proof algebra.

| implementation | CPU mean | CUDA mean |
| --- | ---: | ---: |
| three independent ICICLE submissions | `37.467 s` | `23.585 s` |
| one grouped ICICLE batch | `37.099 s` (`-0.368`) | `23.843 s` (`+0.258`) |

The grouped implementation improved CPU and regressed CUDA in this block. The
project owner rejected Candidate 2D. Production commit `9a871a9f5` subsequently
restored the three independent submissions and removed the grouped helper and
its dedicated tests.

### Candidate 3B/3C: Ruffini Kernel

These preserve the Ruffini calculation and change only its execution:

- 3B is a direct Rust row-major CPU recurrence and has not been benchmarked.
- 3C is an ICICLE-native batched division path and is blocked because ICICLE
  v3.8.0 and v4.0.0 do not provide a CUDA polynomial-division backend.

The project owner rejected both Candidates 3B and 3C. No Ruffini-kernel
experiment or production integration remains planned.

### Candidate 4: Coefficient Rescaling Implementation

All paths perform the same coefficient multiplications. The candidates replace
full scale matrices, copies, and Y transpose with ICICLE batched scalar-vector
multiplication.

| implementation | CPU mean vs full matrix | CUDA mean vs full matrix |
| --- | ---: | ---: |
| full scale matrices in both directions | `37.079 s` | `23.783 s` |
| batched X only | `37.005 s`, delta `-0.074 s` | `23.519 s`, delta `-0.264 s` |
| batched Y only | `36.977 s`, delta `-0.102 s` | `23.650 s`, delta `-0.133 s` |
| batched X and Y | `37.123 s`, delta `+0.043 s` | `23.513 s`, delta `-0.270 s` |

The CUDA production control moved by `-0.840 s` across this block, which is
larger than every candidate delta. The complete Candidate 4 block is
inconclusive rather than evidence for any implementation. The project owner
rejected Candidate 4, so the full-matrix production implementation remains.

### Candidate 5: CRS-To-MSM Input Preparation

All paths commit the same coefficients against the same CRS points. They differ
only in when and where archived points are decoded and cached. The correct
common comparator is repeated archive decoding, not Option A.

| implementation | CPU mean vs repeated decode | CUDA mean vs repeated decode |
| --- | ---: | ---: |
| repeated archive decoding for each commitment | `37.869 s` | `24.920 s` |
| Option A: decode the complete CRS grid once | `37.147 s`, delta `-0.722 s` | `23.914 s`, delta `-1.006 s` |
| Option B: decode and cache each shape directly from the archive | `37.954 s`, delta `+0.085 s` | `25.138 s`, delta `+0.218 s` |
| Option C: full decoded grid plus compact shape caches | `37.221 s`, delta `-0.648 s` | `24.451 s`, delta `-0.469 s` |

Option A is faster than Option C by `0.074 s` CPU and `0.537 s` CUDA and is
already in production. Historical Option D added device-resident shape caches
to Option A: it changed CPU from `37.144 s` to `37.253 s` (`+0.109 s`) and
CUDA from `23.285 s` to `23.099 s` (`-0.186 s`). That separate historical
comparison did not establish a first-proof improvement and Option D was
rejected. The project owner retained Option A, which decodes the complete CRS
grid once.

The historical first-proof Option A versus A+D samples were:

| environment | Option A samples | Option A+D samples | mean delta |
| --- | --- | --- | ---: |
| CPU | 37.018632, 37.060732, 37.150746, 37.293829, 37.196537 | 37.081405, 37.257991, 37.073644, 37.240274, 37.610820 | A was 0.108732 s faster |
| CUDA | 23.105823, 23.262647, 23.157733, 23.188531, 23.712127 | 22.816105, 23.303093, 22.802643, 23.443928, 23.130695 | A+D was 0.186080 s faster |

The CPU paired interval was `-0.142826` to `0.360289` seconds in favor of A,
and the CUDA paired interval was `-0.226587` to `0.598746` seconds in favor of
A+D. Neither established an Option D first-proof improvement. CUDA reused-proof
means were `22.062971 s` for A and `20.437942 s` for A+D, but the project owner
explicitly excluded reused proofs from the decision.

### Candidate 6: Zero-Scalar MSM Input Compaction

All paths compute the same MSM. The candidates scan scalar inputs, allocate
compact buffers, and omit zero-scalar terms before calling ICICLE.

| implementation | CPU mean/median vs full input | CUDA mean/median vs full input |
| --- | --- | --- |
| submit full `O_mid` and `O_prv` inputs | `38.179 / 37.739 s` | `23.937 / 23.800 s` |
| compact `O_mid` only | `37.362 / 37.334 s`; mean delta `-0.818 s`, median delta `-0.404 s` | `23.831 / 23.923 s`; mean delta `-0.105 s`, median delta `+0.123 s` |
| compact `O_prv` only | `37.525 / 37.235 s`; mean delta `-0.654 s`, median delta `-0.504 s` | `23.792 / 23.755 s`; mean delta `-0.145 s`, median delta `-0.045 s` |
| compact both | `37.612 / 37.405 s`; mean delta `-0.567 s`, median delta `-0.333 s` | `23.578 / 23.437 s`; mean delta `-0.359 s`, median delta `-0.363 s` |

The CPU full-input path contains a `39.759 s` sample; `O_prv` and the combined
path contain `38.250 s` and `38.654 s` samples. CUDA also contains isolated
`24.461 s` and `24.502 s` samples. No individual sample is deleted
post-hoc. The affected evidence is inconclusive, and 6M/6P are not approved
for integration. The project owner rejected both 6M and 6P.

### Candidates 7 And 8

- Candidate 7 changes host/device staging, resize, padding, degree handling,
  NTT input placement, multiplication, and fused-expression leaf preparation.
  It was not benchmarked and was rejected by the project owner.
- Candidate 8 changes where prove1 division, transpose, and reverse products
  execute and retains intermediates on the active device. It was not
  benchmarked and was rejected by the project owner.

## Stage Attribution

- Candidate 1A's mean movement is concentrated in `prove4`: `-2.095 s` CPU
  and `-0.316 s` CUDA. Unrelated CPU stages added back about `0.43 s`.
- Candidate 1B's movement is also concentrated in `prove4`: `-1.389 s` CPU
  and `-0.972 s` CUDA.
- Candidate 2 legacy and adjusted paths add about `0.85/0.82 s` to CPU
  `prove3`. Serial saves about `0.05 s` in CPU `prove3` but adds `0.41 s` to
  CUDA `prove3`. Rayon saves about `0.20 s` in CPU `prove3` and is effectively
  tied with Batch in CUDA `prove3`.
- Candidate 2C's CPU movement is mainly `prove4` at `-0.345 s`, but unrelated
  stages offset part of it. CUDA stage movement is mixed and smaller than
  observed run variation.
- Candidate 2D changes `prove4` by `-0.310 s` CPU but `+0.195 s` CUDA.
- Candidate 3A saves `0.051 s` in CPU `prove4` and `0.117 s` in CUDA
  `prove4`, but unrelated CUDA stages add more time than it saves.
- Candidate 4's candidate-owned savings are too small to separate cleanly
  from broad control movement.
- Candidate 5 Option A pays a one-time full-grid decode in `init`, then saves
  more across commitments in `prove0`, `prove2`, and `prove4`. The net gain
  over archive is `0.722 s` CPU and `1.006 s` CUDA.
- Candidate 6 combined compaction changes several stages because the compact
  statement encoding is reused across proof phases. Its mean gain is
  `0.567 s` CPU and `0.359 s` CUDA, with `prove4` contributing `0.221 s` of
  the CUDA movement.

## Project-Owner Disposition

The project owner decided that every candidate whose essential optimization
removes or shares mathematical work must be applied, independently of the
inconclusive end-to-end measurements in this campaign. An optimization is
classified as algebraic or algorithmic only when its reduction in mathematical
work is independent of the selected backend, API, memory location, cache, or
threading implementation.

The approved algebraic and algorithmic set is:

| candidate | backend-independent reduction | disposition |
| --- | --- | --- |
| 1A | combine the three weighted Pi numerators, then perform one Ruffini split and two commitments instead of three splits and five commitments | retain the current production algorithm |
| 1B | calculate the identical M/N X quotient and commitment once and reuse the result in both proof fields | retain the current production algorithm |
| 2A | evaluate a coefficient-scaled polynomial at an adjusted point instead of materializing the scaled polynomial | retain this identity in the production evaluation algorithm |
| 2B algorithm | evaluate the three related challenge points together and share their common reductions | retain the shared-evaluation algorithm; implementation selection remains separate |
| 2C | derive `r_D1` and `r_D2` scalar evaluations by subtraction instead of evaluating materialized difference polynomials | approve production integration |
| 3A | divide the original polynomial and correct only the scalar remainder instead of materializing a full constant-subtracted numerator | approve production integration |

Implementation disposition is:

| candidate | project-owner disposition |
| --- | --- |
| 2B implementation | retain ICICLE two-stage Batch; reject custom Serial and Rayon |
| 2D | reject grouped same-point evaluation and restore independent submissions in a later production change |
| 3B/3C | reject both Ruffini-kernel implementation candidates |
| 4 | reject batched X/Y coefficient rescaling and retain the current full-matrix implementation |
| 5 | retain Option A, which decodes the complete CRS grid once; reject the archive, shape-cache, combined shape-cache, and device-cache alternatives |
| 6M/6P | reject zero-scalar compaction and retain unchanged full MSM inputs |
| 7 | reject the ICICLE-native polynomial data-flow implementation family |
| 8 | reject the device-resident prove1 recursion implementation family |

Candidate 1A and 1B were already present in production. Candidate 2A and the
shared-evaluation semantics are represented by the current Candidate 2 path.
At the time of the disposition, Candidates 2C and 3A still required
owner-approved production integration and Candidate 2D required removal. The
completed production sequence is recorded below.

The project owner selected the production execution order:

1. audit and correct the production comments for already integrated Candidates
   1A, 1B, and 2A;
2. remove Candidate 2D and restore independent submissions;
3. integrate Candidate 2C;
4. integrate Candidate 3A.

Each step must remain separate and pass its CPU correctness and production
timing gates before the next step starts. The project owner explicitly declined
post-integration CUDA revalidation. Existing isolated CUDA correctness evidence
is retained as historical support and must not be described as fresh validation
of the resulting production changes.

## Completed Production Sequence

The approved sequence completed without fresh post-integration CUDA
validation:

1. Commit `5b1484308` documented the original operations and algebraic
   identities for Candidates 1A, 1B, and 2A.
2. Commit `9a871a9f5` removed Candidate 2D and restored independent
   same-point evaluations. The 43 non-ignored `libs` tests, the `prove` library
   test, one release `timing,testing-mode` fixture, and fresh
   preprocess/prove/verify passed; verification returned `true`. Its three CPU
   timing samples were `37.220667`, `38.195563`, and `37.051648` seconds.
3. Commit `6c132c3d8` integrated Candidate 2C with direct-evaluation
   assertions retained under `testing-mode`. The `prove` library test, one
   release parity fixture, and fresh preprocess/prove/verify passed;
   verification returned `true`. Its three CPU timing samples were
   `37.579199`, `37.192760`, and `37.113367` seconds.
4. Commit `627821017` integrated Candidate 3A with a focused unit test and
   exact quotient comparisons under `testing-mode`. The focused test, `prove`
   library test, one release parity fixture, and fresh preprocess/prove/verify
   passed; verification returned `true`. Its three CPU timing samples were
   `37.659379`, `37.071582`, and `37.077365` seconds.

The canonical CPU timing table was regenerated from the median sample after
each production step. These three-sample production smoke blocks do not replace
the isolated five-run comparisons above and do not establish new performance
claims.

## Integrity Notes

The invalid and corrected incidents are listed in the validity section rather
than silently removed. The retained CUDA evidence consists of 181 timing JSON
files and 11 telemetry files; all 192 matched the preserved manifest. Raw
ignored artifacts remain local evidence and are not part of the tracked public
record.
