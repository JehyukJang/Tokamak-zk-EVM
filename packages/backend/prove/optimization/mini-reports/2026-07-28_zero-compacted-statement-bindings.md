# Zero-Compacted Statement Binding Experiment

## Decision Status

Candidate 6 Stage 0 and the isolated correctness gates are complete. E2E
benchmarking is blocked because the current environment cannot reproduce the
accepted CPU baseline. No measured candidate pair is accepted, and no
candidate code or production optimization has entered the production branch.

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

## E2E Baseline Blocker

The accepted canonical E2E `total_wall` is 37.224994 seconds. The first
benchmark attempt produced:

| warm-up | `total_wall` |
| --- | ---: |
| baseline | 56.172021 s |
| `O_mid` candidate | 56.082403 s |

During that attempt, macOS `corespotlightd` was observed consuming about 222%
CPU. The run sequence was interrupted and no measured pair was accepted.
After that process load disappeared, an additional baseline-only diagnostic
still measured 56.314920 seconds. The external indexing load was therefore not
a sufficient explanation for the persistent slowdown.

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

The machine was on AC power in automatic power mode, macOS reported no thermal
or performance warning, and no competing high-CPU process was present during
the baseline-only diagnostic. The current slowdown remains unexplained.

After a full machine reboot, the initial Spotlight indexing load was allowed to
finish before another diagnostic. The isolated experiment worktree baseline
still measured 55.484695 seconds. To exclude the experiment implementation
itself, the same command and fixture were then run from the clean
`packages/backend` production worktree, which contains no Candidate 6 code.
That baseline measured 54.027174 seconds. The production-worktree result
confirms that the persistent slowdown is outside the Candidate 6 implementation
and was not resolved by rebooting.

The campaign plan requires reproducing the accepted baseline within normal
variance before evaluating a candidate. Candidate 6 therefore stops at this
environment blocker. The two warm-ups and diagnostic run are retained only for
audit and must not be used to accept or reject either binding. The post-reboot
diagnostics are likewise excluded from candidate evaluation.
