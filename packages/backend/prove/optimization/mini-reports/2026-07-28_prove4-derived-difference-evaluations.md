# Prove4 Derived Difference Evaluations

## Decision Status

Candidate 2C is defined but not yet implemented or benchmarked. No production
code has changed.

## Source And Environment

- Production baseline: `855f0348a`
- Candidate owner: `Prover::prove4`
- Current benchmark backend: ICICLE CPU fallback
- Primary metric: end-to-end `total_wall`
- Experiment isolation: detached worktree

## Candidate Boundary

Prove4 constructs and retains:

```text
r_D1 = r - r_omegaX
r_D2 = r - r_omegaX_omegaY
```

These polynomials are required later by the `LHS_zk1` and `LHS_zk2`
expressions, so Candidate 2C does not remove their construction.

The current implementation also evaluates both difference polynomials at
`(chi, zeta)`, even though it has already computed:

```text
small_r_eval
small_r_omegaX_eval
small_r_omegaX_omegaY_eval
```

By linearity of polynomial evaluation:

```text
r_D1_eval = small_r_eval - small_r_omegaX_eval
r_D2_eval = small_r_eval - small_r_omegaX_omegaY_eval
```

The candidate replaces only the two full-grid difference-polynomial
evaluations with these scalar subtractions.

## Current Cost

The canonical CPU timing table at baseline `855f0348a` records:

| operation | time |
| --- | ---: |
| `poly.eval.prove4.r_D1` | 0.146065 s |
| `poly.eval.prove4.r_D2` | 0.146350 s |
| combined removable boundary | 0.292415 s |

The candidate removes two polynomial evaluations without adding allocation,
coefficient traversal, transfer, or dispatcher calls. The retained
difference-polynomial construction and downstream expressions are unchanged.

## Correctness Gates

The isolated experiment must establish exact scalar equality between:

- direct evaluation of `r - r_omegaX` and the corresponding evaluation
  difference;
- direct evaluation of `r - r_omegaX_omegaY` and the corresponding evaluation
  difference.

Focused tests must cover zero, constant, X-only, Y-only, sparse, dense, and
representative shapes with zero, one, negative-one, and random evaluation
points and scale values.

The full fixture must compare the complete Legacy and Candidate `Proof4`
outputs exactly. A fresh candidate proof must pass the existing verifier.

## Benchmark Protocol

The detached experiment will provide Legacy, Candidate, and Parity modes only
inside the isolated worktree.

After warming both measured paths, collect at least five alternating E2E runs
using the same release binary, source revision, fixture, CRS, ICICLE backend,
and timing instrumentation. Report:

- every `total_wall` sample;
- mean, median, range, and paired delta;
- `prove4.total`;
- the two removed Legacy evaluation spans;
- the Candidate scalar-derivation span;
- movement in unchanged neighboring stages.

The candidate qualifies for project-owner review only if exact parity and
fresh verification pass and the E2E improvement exceeds observed noise. No
production integration may begin without explicit project-owner approval.
