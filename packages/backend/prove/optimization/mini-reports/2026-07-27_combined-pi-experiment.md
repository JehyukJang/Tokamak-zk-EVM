# Combined Pi Opening Experiment

## Decision Status

The project owner approved Candidate 1A for production integration. The
isolated implementation passed coefficient, remainder, G1, proof, and verifier
parity checks. It reduced mean CPU end-to-end `total_wall` by 2.520969 seconds,
or 6.034%.

The production implementation, fresh-artifact verification, and production CPU
timing gate are complete.

## Source And Environment

- Source revision: `c13e8067dc538ee78504514f1dc82f5652bf4e93`
- Branch baseline: local `packages/backend`, fast-forwarded to `origin/main`
- Experiment isolation: detached temporary worktree; no experiment code was
  added to the production branch
- OS: macOS 26.5.2, build 25F84
- CPU: Apple M4 Pro
- Memory: 48 GiB
- Rust: `rustc 1.95.0 (59807616e 2026-04-14)`
- Cargo: `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`
- ICICLE runtime result: no GPU backend found; CPU fallback used
- Build profile: Cargo `release`
- Timing feature: `timing`

The QAP library came from the source revision's
`packages/frontend/qap-compiler/subcircuits/library`. Synthesizer and CRS
artifacts came from the existing matching local end-to-end fixture used by the
fresh baseline. Raw timing reports are retained under the ignored
`tmp/native-prover-optimization/` directory.

## Candidate Boundary

Before this optimization, production constructed three opening numerators in
`prove4`:

- `pA_XY`;
- `LHS_for_copy`;
- `Pi_B_numerator`.

It independently performs three bivariate Ruffini splits and commits five
quotients:

- `Pi_AX` and `Pi_AY`;
- `Pi_CX` and `Pi_CY`;
- X-only `Pi_B`, followed by multiplication by `kappa1^4`.

The final proof points are:

```text
Pi_X = Pi_AX + Pi_CX + kappa1^4 * Pi_B_unscaled
Pi_Y = Pi_AY + Pi_CY
```

Ruffini splitting and KZG commitment are linear. The candidate therefore forms:

```text
p_combined =
    pA_XY
    + LHS_for_copy
    + kappa1^4 * Pi_B_numerator
```

It performs one bivariate Ruffini split at `(chi, zeta)` and commits the
resulting X and Y quotients directly as final `Pi_X` and `Pi_Y`.

The candidate removes two Ruffini calls, three commitment jobs, and the final
G1 additions. It adds one full polynomial combination. Proof schema, field
ordering, transcript inputs, CRS format, and verifier equations remain
unchanged.

The parity oracle is exact equality of both final G1 points against the legacy
path for the same witness and challenges. The end-to-end oracle is acceptance
of the candidate proof by the existing verifier.

## Isolated Implementation

The experiment used an environment-selected `legacy`, `candidate`, or `parity`
path only inside a detached temporary worktree. `parity` calculated both paths
from the same three numerators and asserted exact equality of final `Pi_X` and
`Pi_Y`. `candidate` omitted all legacy splits and commitments.

This experiment mechanism is intentionally not suitable for production. An
approved production implementation should contain only the combined path and
must not retain a runtime mode or legacy fallback.

## Correctness Results

The isolated unit suite passed:

- a deterministic 4-by-4 linearity case;
- zero and constant polynomials;
- X-only and Y-only polynomials;
- sparse and dense bivariate polynomials;
- equal storage shapes with different logical degrees;
- a representative 1024-by-32 dense shape;
- challenge pairs `(0, 0)`, `(1, 1)`, and `(5, 7)`;
- all-zero, all-one, negative-one, and nontrivial scale sets;
- exact X quotient coefficient parity;
- exact Y quotient coefficient parity;
- exact remainder parity;
- Ruffini reconstruction at independent points.

The full fixture `parity` run completed without a G1 mismatch. A proof generated
with the candidate-only path was then passed to the existing verifier, which
returned `true`.

## Benchmark Procedure

Both paths used the same temporary binary, source revision, release profile,
fixture, timing instrumentation, CPU fallback, and output location.

Each measured process executed the complete timing test:

```text
cargo test --release -q -p prove --features timing \
  --test timing timing_prove_stages -- --nocapture
```

The common environment supplied `PROVE_QAP_PATH`,
`PROVE_SYNTHESIZER_PATH`, `PROVE_SETUP_PATH`, `PROVE_OUT_PATH`, and
`TIMING_OUT`. `TOKAMAK_COMBINED_PI_EXPERIMENT` selected `legacy` or
`candidate` in the isolated worktree.

Both paths were warmed before measurement. The ten measured runs used this
order:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

This is five paired comparisons with alternating `L-C`, `C-L`, `L-C`, `C-L`,
and `L-C` order.

## End-To-End Results

`total_wall` is the primary metric.

| sample | legacy | candidate | delta | speedup |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 41.950181 s | 39.444112 s | -2.506069 s | 5.974% |
| 2 | 42.065349 s | 39.318267 s | -2.747082 s | 6.531% |
| 3 | 41.598704 s | 39.101713 s | -2.496990 s | 6.003% |
| 4 | 41.695507 s | 39.199333 s | -2.496175 s | 5.987% |
| 5 | 41.592121 s | 39.233594 s | -2.358527 s | 5.671% |

| statistic | legacy | candidate | candidate delta |
| --- | ---: | ---: | ---: |
| mean | 41.780372 s | 39.259404 s | -2.520969 s (-6.034%) |
| median | 41.695507 s | 39.233594 s | -2.461913 s (-5.905%) |
| minimum | 41.592121 s | 39.101713 s | |
| maximum | 42.065349 s | 39.444112 s | |
| range | 0.473228 s | 0.342399 s | |

Every measured pair favored the candidate. The smallest paired improvement was
2.358527 seconds, which is substantially larger than either path's measured
range.

## Supporting Attribution

Mean `prove4.total` changed from 12.601147 seconds to 10.093034 seconds:

- delta: -2.508113 seconds;
- `prove4` speedup: 19.904%.

Mean outer call-boundary and polynomial timings were:

| operation | legacy | candidate |
| --- | ---: | ---: |
| Pi Ruffini work | 0.666634 s across 3 calls | 0.327301 s across 1 call |
| combined numerator construction | none | 0.052045 s |
| Pi commitment call boundaries | 6.309228 s across 5 calls | 4.086474 s across 2 calls |

The removed commitment boundary accounts for approximately 2.223 seconds. Net
Ruffini savings after paying for combined numerator construction account for
approximately 0.287 seconds. Their sum agrees with the observed 2.508-second
`prove4` reduction and the 2.521-second end-to-end reduction.

## Complexity And CUDA Implications

The production change would be localized to `prove4`, but testing-mode
diagnostics must be updated so decomposed arithmetic and copy checks remain
available without executing redundant production commitments. The combined
path retains three large numerators until the final combination and therefore
uses more transient memory. This is consistent with the execution-time policy.

The algebra and ICICLE interfaces are backend-independent, so no separate CUDA
implementation is justified. However, most of the measured CPU gain comes from
removing one large X commitment. CUDA MSM is substantially faster in the
historical timing table, so the CUDA end-to-end gain may be smaller. CUDA
compatibility should be preserved, and CUDA performance must remain unclaimed
until suitable hardware is available.

## Production Integration

The approved production implementation contains only the combined Pi path. It
does not contain the experiment's environment switch or a legacy runtime
fallback.

Normal builds retain the three opening numerators, construct one combined
numerator, perform one Ruffini split, and commit final `Pi_X` and `Pi_Y`.
`testing-mode` additionally computes the decomposed legacy commitments and
asserts:

```text
Pi_X == Pi_AX + Pi_CX + Pi_B
Pi_Y == Pi_AY + Pi_CY
```

This preserves `Proof4Test` diagnostics without adding redundant commitment
work to normal production builds.

The following production checks passed:

- `cargo check -p prove --features timing`;
- `cargo check -p prove --features testing-mode`;
- `cargo test -p prove --lib`;
- `cargo test -p prove --features testing-mode --lib`;
- timing integration-test compilation;
- full release fixture execution with `timing,testing-mode`;
- fresh release preprocess generation;
- fresh release proof generation;
- verification using the fresh preprocess and proof: `true`.

The standalone release prover reported 39.302 seconds for the fresh proof run.

## Production Timing

Five warmed production timing runs produced:

| sample | `total_wall` | `prove4.total` |
| ---: | ---: | ---: |
| 1 | 39.194337 s | 10.178372 s |
| 2 | 39.342246 s | 10.140701 s |
| 3 | 40.024063 s | 10.087872 s |
| 4 | 39.509995 s | 10.071134 s |
| 5 | 39.956981 s | 10.180891 s |

| statistic | `total_wall` | `prove4.total` |
| --- | ---: | ---: |
| mean | 39.605524 s | 10.131794 s |
| median | 39.509995 s | 10.140701 s |
| minimum | 39.194337 s | 10.071134 s |
| maximum | 40.024063 s | 10.180891 s |
| range | 0.829727 s | 0.109757 s |

The production `prove4` mean is 0.038760 seconds slower than the isolated
candidate mean and remains 2.469353 seconds faster than the paired legacy mean.
This confirms that the measured optimization survived production integration.
The larger end-to-end variation is outside `prove4` and does not indicate loss
of the combined-opening gain.

The median end-to-end sample, sample 4, is recorded in:

- `prove/optimization/timing.local.cpu.current.json`;
- `prove/optimization/timing.local.cpu.current.md`.

The canonical sample records:

- `total_wall`: 39.509995 seconds;
- `prove4.total`: 10.071134 seconds;
- one `Pi_combined` Ruffini call;
- two final Pi commitment call boundaries;
- no normal-build `Pi_A`, `Pi_C`, or `Pi_B` Ruffini/commitment calls.

## Final Decision

Candidate 1A is accepted and retained in production. Its correctness,
end-to-end gain, production proof verification, and production timing gate all
passed.

## Corrected July Rebenchmark

The same-revision five-run comparison measured current versus legacy
first-proof means of `38.331634` versus `39.997688` seconds on CPU and
`23.682864` versus `23.878389` seconds on CUDA. Both CPU paths retained their
slow samples; the medians also favored the current path.

See
[July Rebenchmark And Final Disposition](2026-07-30_july-rebenchmark-and-final-disposition.md)
for all samples, controls, invalidated evidence, and final classifications.
