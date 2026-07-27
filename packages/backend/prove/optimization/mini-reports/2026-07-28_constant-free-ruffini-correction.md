# Constant-Free Combined Pi Ruffini Correction

## Decision Status

Candidate 3A is defined but not yet implemented or benchmarked. No production
code has changed.

## Source And Environment

- Production baseline: `26a771404`
- Candidate owner: `Prover::prove4`
- Current benchmark backend: ICICLE CPU fallback
- Primary metric: end-to-end `total_wall`
- Experiment isolation: detached worktree

## Candidate Boundary

The production combined Pi numerator contains three explicit scalar
subtractions:

```text
kappa1 * (VXY - V_eval)
kappa1^3 * (RXY - R_eval)
kappa1^4 * (a_free_X - A_eval)
```

The remaining terms are unchanged. Candidate 3A constructs the same combined
numerator without these scalar subtractions:

```text
kappa1 * VXY
kappa1^3 * RXY
kappa1^4 * a_free_X
```

and records the combined scalar correction:

```text
c = kappa1 * V_eval + kappa1^3 * R_eval + kappa1^4 * A_eval
```

It then runs the existing bivariate Ruffini split once on the constant-free
numerator.

## Algebraic Basis

For any bivariate polynomial `P`, scalar `c`, and split point `(x, y)`:

```text
P - c = Q_X(X, Y) * (X - x) + Q_Y(Y) * (Y - y) + (P(x, y) - c)
```

Subtracting `c` changes only the final scalar remainder. It does not change
either quotient. Therefore:

```text
ruffini(P - c).Q_X = ruffini(P).Q_X
ruffini(P - c).Q_Y = ruffini(P).Q_Y
ruffini(P - c).remainder = ruffini(P).remainder - c
```

The production numerator evaluates to zero at `(chi, zeta)`, so the
constant-free numerator must return remainder `c`. Its two quotient
polynomials, and therefore its two KZG commitments, must exactly match
production.

## Current Cost And Allocation

The canonical CPU timing table records:

| operation | time | shape |
| --- | ---: | --- |
| scalar subtraction inside `Pi_A` | 0.007889 s | `VXY` |
| `poly.add.prove4.R_minus_eval` | 0.013193 s | 4096 by 256 |
| `poly.add.prove4.Pi_B_numerator` | 0.000007 s | 128 by 1 |
| directly removable work | 0.021089 s | |
| `poly.combine.prove4.Pi_combined_numerator` | 0.051091 s | 4096 by 256 |
| `poly.div_by_ruffini.prove4.Pi_combined` | 0.352879 s | 4096 by 256 |

Each scalar subtraction clones or reconstructs a polynomial even though only
coefficient `(0, 0)` changes. The candidate removes those intermediate
polynomials and adds only scalar field arithmetic and a remainder comparison.

The expected saving is substantially smaller than normal E2E variance. The
candidate must not be promoted from algebraic correctness or boundary timing
alone.

## ICICLE And Backend Constraints

Candidate 3A does not replace the Ruffini kernel. It continues to invoke the
same `DensePolynomialExt::div_by_ruffini` operation and changes only the input
constant and expected remainder.

No additional ICICLE primitive, CPU implementation, active-device branch,
transfer, or fallback is required. The same prove control flow applies to
every backend. ICICLE-native batched Ruffini work remains independently owned
by Candidate 3C and must not be combined with this experiment.

## Correctness Gates

Focused tests must compare:

- Legacy split of `P - c`;
- Candidate split of `P` followed by scalar remainder correction.

They must establish exact equality of both quotient coefficient arrays and:

```text
legacy_remainder = candidate_remainder - c
```

Coverage must include zero, constant, X-only, Y-only, sparse, dense,
mismatched logical degree, and representative 4096-by-256 polynomials. Split
points and corrections must include zero, one, negative one, and nontrivial
field values. The reconstruction identity must pass at independent points.

The full fixture Parity mode must assert exact equality of:

- constant-free and Legacy combined Pi quotient polynomials;
- `Pi_X` and `Pi_Y`;
- corrected and Legacy remainders;
- the complete `Proof4` and `Proof4Test` outputs.

A fresh Candidate-only proof must pass the existing verifier with a fresh
matching preprocess artifact.

## Benchmark Protocol

The detached experiment will expose Legacy, Candidate, and Parity modes only
inside its isolated worktree. Legacy retains all three scalar-subtracted
numerators. Candidate removes them and checks the combined correction.

After warming both measured paths, collect five alternating E2E pairs using
the same release binary, source revision, fixture, CRS, ICICLE backend, timing
instrumentation, and output location. Report:

- every `total_wall` sample;
- mean, median, range, paired delta, and 95% paired interval;
- `prove4.total`;
- all three removed scalar-subtraction spans;
- combined numerator construction and Ruffini timing;
- movement in unchanged neighboring stages.

End-to-end `total_wall` remains the acceptance metric. The candidate qualifies
for project-owner review only if exact parity and fresh verification pass and
the E2E improvement exceeds observed noise. No production integration may
begin without explicit project-owner approval.
