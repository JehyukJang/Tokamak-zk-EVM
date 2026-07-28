# Zero-Compacted Statement Binding Experiment

## Decision Status

Candidate 6 Stage 0 is complete. The experiment will evaluate `O_mid` and
`O_prv` independently by removing zero-scalar terms before their MSMs.
`O_pub_free` remains unchanged as a small-input control. No candidate code or
production optimization has been implemented.

## Audience

This report is for maintainers benchmarking and optimizing the native
Rust/ICICLE prover in `packages/backend`.

## Source And Environment

- Production baseline: `6d0631148`
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
