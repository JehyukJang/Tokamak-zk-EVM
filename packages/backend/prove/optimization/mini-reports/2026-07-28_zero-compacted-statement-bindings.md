# Zero-Compacted Statement Binding Experiment

## Decision Status

Candidate 6 isolated correctness and E2E benchmarking are complete. Neither
`O_mid` nor `O_prv` established an E2E improvement under the campaign
acceptance rule. The project owner rejected both subcandidates. Candidate 6 is
complete with no production integration, and no candidate code entered the
production branch.

## Audience

This report is for maintainers benchmarking and optimizing the native
Rust/ICICLE prover in `packages/backend`.

## Source And Environment

- Production baseline: `6d0631148`
- Boundary-definition commit: `2818e4739`
- Isolated experiment commit: `38fa95654`
- Upstream baseline: `origin/main` at `c13e8067d`
- Active backend: ICICLE CPU fallback
- Primary metric: timing-table E2E `total_wall`
- Fixture setup parameters: `l=728`, `l_D=4824`, `m_D=26591`,
  `s_D=14`, and `s_max=256`
- Experiment isolation: dedicated worktree and experiment-only branch

## Production Boundary

Both bindings call `encode_statement_common` from
`ArchivedSigma1Rkyv`:

- `O_mid` selects global wire indices in `[l, l_D)`;
- `O_prv` selects global wire indices in `[l_D, m_D)`.

For every selected placement variable, the current implementation parses the
hex scalar, decodes the corresponding archived G1 base, appends both to full
vectors, validates the selected-variable count, and submits one ICICLE MSM.
The returned core binding is then combined with its existing zero-knowledge
terms by `Prover::init`.

The candidate changes only the scalar/base vectors submitted to those two
MSMs. Selection ranges, placement order, local-wire order, global base index,
count validation, and the later zero-knowledge terms remain unchanged.

## Algebraic Identity

For ordered scalars `s_i` and bases `G_i`, each binding computes:

```text
sum_i(s_i * G_i)
```

Since `0 * G_i` is the group identity, removing exactly those terms for which
`s_i = 0` preserves the result:

```text
sum_i(s_i * G_i) = sum_{i: s_i != 0}(s_i * G_i)
```

The candidate must parse every selected scalar and maintain an independent
selected-term count. It must not use compact-vector length as the selection
validation, because that would conceal missing zero-valued selected wires.
Relative order among retained scalar/base pairs must be unchanged.

## Current Fixture Profile

The representative fixture contains 234 placements. A direct scan using the
production selection rules gives:

| binding | selected terms | zero terms | retained terms | zero ratio |
| --- | ---: | ---: | ---: | ---: |
| `O_mid` | 6,820 | 2,429 | 4,391 | 35.616% |
| `O_prv` | 650,925 | 298,765 | 352,160 | 45.899% |
| `O_pub_free` control | 109 | 53 | 56 | 48.624% |

`O_pub_free` is intentionally not compacted. Its current boundary is about one
millisecond, so an additional scan and branch can cost more than the smaller
MSM saves.

The five accepted production CPU timing samples recorded:

| boundary | mean |
| --- | ---: |
| E2E `total_wall` | 37.284705 s |
| `O_mid_core` | 0.007426 s |
| `O_prv_core` | 0.663365 s |
| `O_pub_free` control | 0.001214 s |

The maximum attributable saving is therefore concentrated in `O_prv`.
Operation-level savings remain supporting evidence and cannot replace E2E
`total_wall`.

## Isolated Experiment

Use one removable experiment branch with four modes:

1. `baseline`: unchanged full-vector `O_mid` and `O_prv`;
2. `mid`: compact only `O_mid`;
3. `prv`: compact only `O_prv`;
4. `parity`: execute full and compact forms for both boundaries and assert exact
   G1 equality.

The experiment may modify copied source in its dedicated worktree, but no
experiment flag, API, feature, or candidate implementation may enter the
production branch.

Record non-overlapping subspans for:

- selected scalar parsing;
- zero test and selected-term counting;
- compact scalar/base allocation and insertion;
- archived base conversion;
- ICICLE MSM;
- output conversion;
- complete binding boundary.

## Correctness Gates

Before E2E measurement:

- deterministic focused tests must cover all-zero, all-nonzero, first-only,
  last-only, alternating, and representative sparse inputs;
- each focused test must compare exact G1 outputs against the full-vector
  implementation;
- selected-variable count mismatch must still fail even when omitted selected
  values are zero;
- retained base/scalar order must match the original selected order;
- the complete release `timing,testing-mode` parity fixture must pass;
- fresh preprocess, candidate proof, and verification must return `true`.

An all-zero compact input must return the group identity without invoking an
empty ICICLE MSM.

## E2E Benchmark

Benchmark `O_mid` and `O_prv` independently. For each candidate:

1. run one unchanged baseline warm-up and one candidate warm-up;
2. collect five alternating baseline/candidate pairs;
3. start `total_wall` before `Prover::init`;
4. include candidate parsing, scanning, allocation, base conversion, MSM, all
   proof stages, and every other existing timing-table cost;
5. report every sample, mean, median, range, paired mean delta, and paired 95%
   confidence interval;
6. report candidate-owned subspans and retained-term counts for attribution;
7. keep `O_pub_free` unchanged and report it as a control.

Each binding qualifies independently only when its paired E2E improvement is
larger than observed noise and all correctness gates pass. A local binding
reduction alone cannot qualify the candidate. No qualifying result authorizes
production integration without a separate project-owner decision.

## Isolated Correctness Results

The focused helper tests passed for:

- all-zero;
- all-nonzero;
- first-only;
- last-only;
- alternating;
- representative sparse input;
- retained base/scalar order;
- selected-count validation before zero filtering.

The complete `libs` test suite passed with 45 tests passed and 3 ignored. The
release `timing,testing-mode` fixture then ran in `parity` mode on the complete
234-placement fixture. Exact G1 equality passed for both `O_mid` and `O_prv`.
The measured retained counts matched the static profile exactly:

| binding | selected | retained |
| --- | ---: | ---: |
| `O_mid` | 6,820 | 4,391 |
| `O_prv` | 650,925 | 352,160 |

One fresh preprocess artifact was generated. Independent fresh `O_mid` and
`O_prv` compact proofs were then generated and verified. The existing verifier
returned `true` for both proofs.

The parity run executed both full and compact bindings and is not a performance
sample. Its compact-path attribution was:

| binding | parse | zero compaction | base decode | MSM |
| --- | ---: | ---: | ---: | ---: |
| `O_mid` | 0.000631 s | 0.000027 s | 0.000296 s | 0.004134 s |
| `O_prv` | 0.110684 s | 0.002132 s | 0.038703 s | 0.374590 s |

These values establish the expected local boundary but cannot qualify either
candidate without E2E evidence.

## E2E Feature Mismatch And Resolution

The accepted canonical E2E `total_wall` is 37.224994 seconds. The first
benchmark attempt incorrectly enabled both `timing` and `testing-mode` and
produced:

| warm-up | `total_wall` |
| --- | ---: |
| baseline | 56.172021 s |
| `O_mid` candidate | 56.082403 s |

During that attempt, macOS `corespotlightd` was also observed consuming about
222% CPU. The run sequence was interrupted and no measured pair was accepted.
After that process load disappeared, an additional `timing,testing-mode`
baseline still measured 56.314920 seconds.

The diagnostic baseline differed from the canonical table across unrelated
stages:

| stage | canonical | diagnostic | increase |
| --- | ---: | ---: | ---: |
| `init.total` | 4.650655 s | 5.611991 s | 0.961336 s |
| `prove0.total` | 9.033163 s | 10.309062 s | 1.275899 s |
| `prove1.total` | 1.991998 s | 2.105462 s | 0.113464 s |
| `prove2.total` | 12.071667 s | 13.939766 s | 1.868098 s |
| `prove3.total` | 0.629799 s | 1.765250 s | 1.135451 s |
| `prove4.total` | 8.837530 s | 22.571293 s | 13.733762 s |

After a full machine reboot, the initial Spotlight indexing load was allowed to
finish before another diagnostic. The isolated experiment worktree baseline
still measured 55.484695 seconds. The clean `packages/backend` worktree
measured 54.027174 seconds with the same incorrect feature combination.

The project owner then reproduced 41.479473 seconds on `main` using the VS Code
timing configuration. That configuration enables `timing` only. Running the
same `timing`-only command on `packages/backend` measured 37.078758 seconds,
while `timing,testing-mode` on the same source measured 54.027174 seconds:

| stage | `timing` only | `timing,testing-mode` | added time |
| --- | ---: | ---: | ---: |
| `init.total` | 4.579265 s | 5.387713 s | 0.808448 s |
| `prove0.total` | 8.987330 s | 9.878970 s | 0.891640 s |
| `prove1.total` | 2.020562 s | 1.993406 s | -0.027155 s |
| `prove2.total` | 12.008084 s | 13.572975 s | 1.564891 s |
| `prove3.total` | 0.637429 s | 1.726801 s | 1.089372 s |
| `prove4.total` | 8.836300 s | 21.457892 s | 12.621593 s |
| **E2E `total_wall`** | **37.078758 s** | **54.027174 s** | **16.948415 s** |

`testing-mode` executes expensive Lemma, R1CS, polynomial-relation, remainder,
and copy-constraint checks inside the timed prover lifecycle. It is required
for the correctness gate but is not the production timing boundary. The
baseline problem was therefore a benchmark-command defect, not a machine,
Candidate 6, or reboot issue.

The invalid runs above are retained only for audit. All accepted performance
measurements below use `--features timing` and reproduce the canonical
baseline. The experiment baseline warm-up was 37.220255 seconds.

## `O_mid` E2E Results

| pair | baseline `total_wall` | candidate `total_wall` | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 37.096465 s | 37.174970 s | -0.078505 s |
| 2 | 37.313142 s | 37.433051 s | -0.119909 s |
| 3 | 37.596672 s | 37.116100 s | 0.480572 s |
| 4 | 37.100457 s | 37.110498 s | -0.010041 s |
| 5 | 37.273517 s | 37.101357 s | 0.172160 s |
| **mean** | **37.276051 s** | **37.187195 s** | **0.088855 s** |

The paired 95% confidence interval is -0.216398 to 0.394109 seconds. Baseline
and candidate medians are 37.273517 and 37.116100 seconds; their ranges are
0.500207 and 0.331694 seconds.

The target binding decreased from 0.007437 to 0.005875 seconds on mean, a local
reduction of 0.001562 seconds. Candidate preparation averaged 0.000710 seconds
for parsing, 0.000031 seconds for zero compaction, 0.001396 seconds for base
decoding, and 0.003733 seconds for MSM. The unchanged `O_pub_free` control
averaged 0.001231 seconds for baseline and 0.001233 seconds for candidate.

The local saving is much smaller than E2E variance. `O_mid` does not qualify.

## `O_prv` E2E Results

| pair | baseline `total_wall` | candidate `total_wall` | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 38.129231 s | 37.392086 s | 0.737144 s |
| 2 | 37.432527 s | 37.213485 s | 0.219042 s |
| 3 | 37.360184 s | 37.223306 s | 0.136878 s |
| 4 | 38.485557 s | 37.203626 s | 1.281931 s |
| 5 | 38.987475 s | 38.850965 s | 0.136511 s |
| **mean** | **38.078995 s** | **37.576693 s** | **0.502301 s** |

All five pairs favored the candidate, but the paired 95% confidence interval is
-0.121796 to 1.126398 seconds. Baseline and candidate medians are 38.129231 and
37.223306 seconds; their ranges are 1.627292 and 1.647339 seconds.

The target binding decreased from 0.665781 to 0.523916 seconds on mean, a stable
local reduction of 0.141865 seconds. Candidate preparation averaged 0.105671
seconds for parsing, 0.002136 seconds for zero compaction, 0.047255 seconds for
base decoding, and 0.368843 seconds for MSM. The unchanged `O_pub_free` control
averaged 0.001263 seconds for baseline and 0.001239 seconds for candidate.

Unrelated stages contributed materially to the apparent E2E mean difference:
baseline minus candidate averaged 0.214418 seconds in `prove0` and 0.110828
seconds in `prove1`, although Candidate 6 changes only initialization. These
unrelated deltas and the confidence interval show that the 0.502301-second mean
cannot be attributed to zero compaction. `O_prv` therefore does not satisfy the
E2E acceptance gate despite its repeatable local saving.

## Final Decision

The project owner rejected production integration of both Candidate 6
subcandidates:

- `O_mid` saves only 1.562 milliseconds locally and has no E2E evidence;
- `O_prv` saves 141.865 milliseconds locally, but its E2E confidence interval
  crosses zero and unrelated stages dominate the observed mean.

Candidate 6 is complete. No production source, feature, fallback, or runtime
flag was added.
