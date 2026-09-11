# Current univariate CRS storage and setup experiments

## Audience and scope

This report is for backend performance engineers and reviewers implementing
the current univariate protocol. It is separate from the superseded protocol's
prover optimization report. It covers CRS storage and trusted-setup computation,
with separate controls for each experiment, not complete prove time.
MPC, publishing and CUDA measurements are outside this experiment.

## Storage reference and candidates

The dense reference is commit `f276370fc`. The local QAP library contains 44
compiled circuits, with n=m=1,024, m_I=1,024, s=256, t=64 and m_D=45,056.
The full reference has four RKYV payloads totaling 1,983,906,512 bytes.
Timing runs use release builds, the same ICICLE CPU installation and fixed
development generators/scalars. Compilation is excluded. These deterministic
scalars are a test control, never production setup material.

- A omits nonpublic query coordinates outside the actual compiled catalog or
  beyond a compiled circuit's flatten-map length. Public queries keep their
  existing separate representation.
- B retains the original nonpublic slots but replaces exactly those eligible
  coordinates with the group identity. It is measured without a run codec.

Eligibility follows from the admitted witness convention, not from a zero
arithmetic column. `witness_maps` admits only actual circuit IDs and
requires witness length to equal the flatten-map length. Unused placements
have neither a selected circuit nor a witness. Therefore the omitted
coordinates always have zero coefficients in U28. Their original points
retain weighted-selection terms and generally are not infinity. Replacing
them is a specialization of the binding sum, not lossless point recovery.
All actual nonpublic wires remain, including constants, interface wires and
wires whose value happens to be zero in an execution. Selection roots, masks,
public specialization and the four-file role boundary remain unchanged.

The candidate layout derives block offsets and retained local wire indices
from existing flatten maps. It adds no per-point descriptors or library
metadata to CRS files. A selected placement/circuit pair is one contiguous
retained range. Empty placements require no query read or identity expansion.

## Measurement procedure

Preserve the dense release binary and output before changing generation.
Repeat full-library setup runs sequentially, without a concurrent build or
benchmark. From `packages/backend/rust`, run the independent storage comparison:

```sh
cargo run --locked --release -p libs --example crs_storage_benchmark -- DENSE_DIRECTORY LIBRARY OUTPUT_DIRECTORY
```

Configure the same ICICLE runtime libraries as the trusted-setup launch entry.
An optional fourth argument, `CANDIDATE_DIRECTORY`, instead compares every
retained query and all other prover sections with the dense archive, and scans
all candidate CRS point families for identity runs. The dense archive is a test
oracle produced at the reference commit, not a supported production format.

The benchmark projects the actual dense archive to A and raw B, then reads
the same selected points and computes the same ICICLE binding MSM. It tests
full, partial and empty placement use with alternating A/B order. Projection
write time is not trusted-setup generation time. First-touch access is not
claimed as an OS-cache-purged cold read. Raw point files are experimental
payloads, not additional production artifact formats. Each candidate gathers
only retained points; B is not penalized by an unnecessary dense MSM.

On macOS the benchmark also performs six alternating range-read trials per
cache mode using `F_NOCACHE` on its own file handles. This requests uncached
I/O; it does not purge the system cache or establish physical-disk coldness.
Range-read timing excludes allocation, point decoding and MSM. Warm mmap
preparation includes selected-point gathering, conversion and allocation.

The full B setup experiment starts with the reference generator and changes
only the nonpublic scalar assignment: use zero when the circuit has no
compiled entry or the local index exceeds its flatten-map length; otherwise
use the original scalar. Full A setup uses the retained-coordinate writer in
this change. Neither candidate adds independent arithmetic or batching tuning.

## Results and disposition

**Accepted: A, direct omission.** It removes 10,694,144 nonpublic points whose
binding coefficients are always zero, retaining 6,006,784 points. Offsets are
derived once from existing library maps; a selected block can be read without
dense restoration. The writer never creates the omitted scalar/point slots.

Measurements were taken on 2026-09-11, on an Apple M4 Pro with 14 logical cores
and 48 GiB RAM, using ICICLE 3.8.0 CPU and release builds. Full setup runs were
sequential and excluded compilation. The [measurement record](evidence/current-univariate-crs-storage.json)
contains repeat timings, hashes, section statistics and access distributions.

| Metric | Dense reference | B: raw identity placeholders | A: omission |
| --- | ---: | ---: | ---: |
| Four RKYV payloads, bytes | 1,983,906,512 | 1,983,906,512 | 957,268,688 |
| Payloads plus provenance, bytes | 1,983,907,281 | 1,983,907,281 | 957,269,457 |
| Setup wall time, seconds | 373.12 / 372.89 | 234.15 | 217.79 / 222.36 |
| CRS generation, seconds | 365.329 / 365.627 | 229.446 | 215.622 / 220.551 |
| Serialize and activate, seconds | 7.164 / 6.555 | 4.138 | 1.637 / 1.615 |
| Peak RSS, GiB | 4.140 / 4.138 | 4.139 | 2.095 / 2.237 |

A reduces total payload size by **51.75%** (1.848 GiB to 0.892 GiB). Its
two-run mean setup time is **220.08 seconds**, compared with **373.01 seconds**
for the dense control, a **41.00% reduction**. These are setup measurements,
not prover timings. B has only one full setup trial; its timing is descriptive,
not a separate repeated-speedup claim.

| File | Dense bytes | A bytes |
| --- | ---: | ---: |
| `tau_sequence.rkyv` | 301,992,400 | 301,992,400 |
| `prover_keys.rkyv` | 1,653,636,880 | 626,999,056 |
| `preprocess_keys.rkyv` | 28,276,128 | 28,276,128 |
| `verifier_keys.rkyv` | 1,104 | 1,104 |

The storage microbenchmark uses full (153,659 selected points), partial
(76,187 points), and empty placement sets. Each of two independent batches
has 30 alternating trials. The following values are medians of the 29 warm
trials, excluding the first touch:

| Selected workload | A preparation + MSM, ms | B preparation + MSM, ms |
| --- | ---: | ---: |
| Full, batch 1 | 12.924 | 12.930 |
| Partial, batch 1 | 7.124 | 7.175 |
| Full, batch 2 | 12.979 | 13.079 |
| Partial, batch 2 | 7.389 | 7.257 |

There is no consistent B access/MSM advantage across these batches; A wins
on size and simplicity, not on a claimed universal MSM speedup. Empty
placements perform neither point reads nor an MSM. In batch 2, per-handle
uncached-request range-read medians were approximately 1.30/1.44 ms (A/B) for
the full selection and 0.54/0.55 ms for the partial selection; cached-request
results and first-touch samples are in the record. These small local-access
tests do not measure downloading, browser heap use, or a cold full-CRS load.

All retained G1/G2 families in both A outputs contained **zero identity
points**, so an infinity-run codec provides no residual saving on this
library. Raw B introduces 11,264 placeholder runs, but it has no stable read
advantage that warrants a second codec experiment. A trial of LZ4 (`-B6`)
increased the retained nonpublic payload from 576,651,264 to
576,653,479 bytes. No run tables, codec dependency, identity expansion,
per-point tags or alternate production representation were added. Other
libraries can have different residual statistics; those require measurement
before introducing a codec.

## Trusted-setup computation follow-up

The storage representation above is the control for a separate compute
experiment. This section does not attribute compression gains to computation.
The compute control is the compressed writer at commit `893c3eb17`.
**Accepted: CPU fixed-base preprocessing and batch normalization, with batches
written directly into the final output array.** The four-file format and all
point coordinates remain unchanged.
Memory use is recorded, but the selection policy imposes no memory cap:
reproducible execution speed determines acceptance.

Opt-in Cargo feature `timing` on `trusted-setup` reuses the existing
backend timing collector. It records scalar construction, each ordered G1/G2
encoding invocation and per-file serialization, hashing and writes. File
tasks overlap; their durations must not be added as serial wall time.

The first repeated release control took 222.33 seconds wall, including
219.894 seconds of CRS generation. Encoding 524,292 G2 tau points took
104.164 seconds; encoding 6,006,784 retained nonpublic G1 points took
79.173 seconds. Scalar preparation was below one second. The second control
took 218.15 seconds wall. These controls preceded candidate comparisons.

The older [native optimization history](../../rust/prove/optimization/publication/optimization-report.md)
supports testing shared preprocessing and bulk work instead of repeated
equivalent operations. Its numeric speedups are not predictions for this
protocol. Direct sparse R1CS evaluation and bounded power recurrence already
exist here. Prover-specific opening combinations, bivariate transforms and
vanishing division do not apply to this setup scalar-label construction.
The candidates were ICICLE one-point MSM batches and CPU fixed-base
table reuse with bounded affine-normalization batches. CUDA dispatch and the
CRS representation remain unchanged. Independent correctness/timing comparisons
preceded production candidate integration. Scalar preparation was below one
second, power construction about 5 ms, and prover-key serialization about
40 ms; no additional scalar/buffer algorithm was adopted without isolated
evidence of an improvement.

The independent G1/G2 comparison passed byte equality for zero, one, modulus
minus one and random scalars, including empty and small inputs. CPU ICICLE
one-point MSM batches were rejected: at 1,024 points G1 took about 792 ms
versus 14 ms direct, and G2 took about 11,657 ms versus 199 ms direct. No
regressing CPU batch implementation was integrated or run at full CRS scale.

At 16,384 points, fixed-base preprocessing with bounded normalization took
about 30 ms G1 and 83 ms G2, versus 217 ms and 3,195 ms direct. Small-input
results were mixed, so integration starts at the measured 16,384-point
boundary and preserves direct encoding below it. The existing arkworks
dependency supplies the arithmetic; no custom curve algorithm is introduced.
CUDA keeps the existing ICICLE bulk path without surrounding Rayon tasks.

The [compute measurement record](evidence/current-univariate-setup-compute.json)
contains all 12 full setup runs, independent encoding samples and seven paired
collection trials. Full runs used the same host, local library, release CPU
configuration and fixed development scalars as the storage experiment.

| Full setup variant | Process wall samples, seconds | Mean wall, seconds | Mean generation, seconds |
| --- | --- | ---: | ---: |
| Compressed control, direct ICICLE arithmetic | 222.33, 218.15 | 220.240 | 217.573 |
| Fixed-base, unindexed temporary collection | 14.24, 14.34, 12.84, 12.19, 14.66 | 13.654 | 10.019 |
| Fixed-base, direct output writes (accepted) | 12.18, 12.21, 12.05, 12.13, 12.51 | 12.216 | 10.089 |

The accepted five-run mean is **94.45% shorter (18.03x)** than the two-run
compute control. These gains are additional to, not interchangeable with,
the storage experiment's compression gains. The last accepted run encoded
the G2 tau family in 1.388 seconds and the nonpublic G1 family in 5.636 seconds,
compared with 104.164 and 79.173 seconds in the first control.

The collection choice has a narrower evidence boundary. Seven alternating
1,048,583-point G1 trials favored unindexed collection in isolation: medians
0.958 seconds unindexed versus 0.979 seconds direct. However, full setup,
including file writes and activation, favored direct output in the repeated
series above (10.53% lower mean wall time). A four-run unindexed/direct/direct/
unindexed crossover is included in those samples. Generation-only averages
do not show a direct-output advantage; the difference is primarily in the
serialization/write phase and remains subject to filesystem variation.
Direct output is selected for observed whole-command speed, not for a claim
that its encoding kernel is universally faster or that lower memory use is
itself an acceptance criterion. Peak RSS was approximately 2.24–2.25 GiB for
direct output and 2.75–2.81 GiB for unindexed collection; there was no imposed
memory cap.

All four files across all 12 runs are byte-identical, totaling 957,268,688
bytes. Every provenance digest matches its payload. The compute change adds
no decompression, reconstruction, consumer indexing, or curve conversion
work at CRS read time. Parallel work uses the runtime's available CPU workers;
the 1,024-point batches and 16,384-point threshold do not fix a core count.

To reproduce the isolated comparisons and instrumented setup, configure the
ICICLE libraries as in the trusted-setup launch entry and run from
`packages/backend/rust`:

```sh
cargo run --locked --release -p libs --example setup_encoding_benchmark
cargo test --locked --release -p libs compare_cpu_output_collection -- --ignored --nocapture
cargo build --locked --release -p trusted-setup --features timing
/usr/bin/time -l ../target/release/trusted-setup --subcircuit-library ../../frontend/qap-compiler/subcircuits/library --output OUTPUT_DIRECTORY --fixed-tau
```

`/usr/bin/time -l` is the macOS measurement invocation. Preserve the control
binary before rebuilding candidates, run them sequentially, and compare all
four file hashes and their provenance. Compilation is excluded. CUDA remains
on its existing ICICLE bulk path; it was not benchmarked in this experiment.

## Validation boundary

Storage-stage checks (P3.1) passed:

- Three shared archive/layout tests, the direct setup-equation/binding test,
  and four trusted-setup command/lifecycle tests, all in release mode.
- Dense-versus-omitted binding equality for full, partial and empty selection,
  including rejection of supplied witnesses at implicit-zero coordinates.
- Every retained point in both full-library A outputs equals the dense
  reference. Other prover sections also match. The other three role files
  are byte-identical across all five setup runs; each run's four provenance
  digests match, and repeated A outputs are identical.
- Backend contract generation/closure checks and WASM TypeScript checking.
  The shared archive range reader and generated ordering contract are updated.

Compute-stage checks (P3.2) passed in release mode: two setup tests (the
existing algebra/binding oracle and CPU coordinate parity across the batching
boundary), four trusted-setup command tests, and three shared archive tests.
The ignored collection benchmark was executed explicitly and passed; the
standalone encoding comparison checked every output against direct ICICLE.
Parity includes zero, one, modulus-minus-one, random scalars, small inputs,
partial final batches and identity generators. Full-library checks cover all
four payloads and their provenance, not a complete proof flow.

An additional existing `univariate_relation` test sweep passed three tests and
failed three: `placement_selector_uses_only_real_catalog_ids`,
`connection_selectors_match_the_u5_coset_values`, and
`permutation_admission_rejects_invalid_selector_and_mapping_shapes`. Their
shared fixture sets `l_free=0`, which the current shape constructor rejects
before relation or compression code runs. Both source files are unchanged
from `f276370fc`; this compression change does not repair those fixtures.
The package-wide test suite is therefore **not reported as green**.

Current-protocol native and WASM preprocess/prove/verify still require their
planned rewrite; full E2E, complete-prove timing, converter/runtime integration
and final integrated storage qualification remain pending. Old-protocol
consumers are not evidence of compatibility with these new archives. Re-run
the storage comparison if the integrated prover's access pattern changes.
