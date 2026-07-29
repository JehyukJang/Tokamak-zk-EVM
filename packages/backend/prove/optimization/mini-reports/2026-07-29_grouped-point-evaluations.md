# Grouped Same-Point Evaluations

## Decision Status

Candidate 2D is complete and integrated into production.

The project owner approved the unified backend-neutral path after reviewing the
conflicting experiment result: CPU end-to-end time improved materially, while
the CUDA candidate boundary regressed but the paired CUDA end-to-end interval
included zero. Production does not inspect the active ICICLE device and has no
legacy runtime fallback.

## Boundary

Prove4 previously evaluated three equal-shape 4096-by-256 polynomials
independently at `(chi, zeta)`:

```text
R(chi, zeta)
scaleX(R, omega_m_i^-1)(chi, zeta)
scaleXY(R, omega_m_i^-1, omega_s_max^-1)(chi, zeta)
```

The production path concatenates their coefficient grids in polynomial-major
order and executes two ICICLE row batches:

1. all Y rows at `zeta`, with `batch_size = 3 * x_size`;
2. the resulting three X polynomials at `chi`, with `batch_size = 3`.

Both stages use `columns_batch = false`. Coefficients and first-stage outputs
remain in typed ICICLE device memory, while the three final scalars are written
directly to host memory. The same calls are submitted to ICICLE on CPU and
CUDA.

For each polynomial `P_k(X,Y) = sum_i sum_j p[k,i,j] X^i Y^j`, the operation
preserves:

```text
P_k(chi, zeta) = sum_i (sum_j p[k,i,j] zeta^j) chi^i.
```

The generic `DensePolynomialExt::eval` implementation is unchanged.
Candidate 2C's rejected derived `r_D1` and `r_D2` evaluations are not included.

## Isolated Correctness

The isolated experiment used revision `412aadebf`. Exact grouped-versus-legacy
field equality passed on CPU and CUDA for:

- zero, constant, sparse, and dense polynomials;
- 1-by-1, X-only, Y-only, 8-by-4, 64-by-16, and 4096-by-256 shapes;
- zero, one, negative-one, and nontrivial evaluation points;
- empty-input and mismatched-shape rejection.

The complete CUDA `libs` suite reported `45 passed`, `0 failed`, and
`3 ignored`. The CUDA `timing,testing-mode` Parity fixture passed, and a fresh
Candidate proof verified successfully.

## Isolated CPU Benchmark

Legacy and Candidate were warmed once. Five measured first-proof pairs used:

```text
L1, C1, C2, L2, L3, C3, C4, L4, L5, C5
```

| pair | Legacy `total_wall` | Candidate `total_wall` | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 35.754001 s | 35.208615 s | 0.545386 s |
| 2 | 35.781605 s | 35.307416 s | 0.474190 s |
| 3 | 35.748248 s | 35.263053 s | 0.485194 s |
| 4 | 35.676971 s | 35.425042 s | 0.251929 s |
| 5 | 35.563530 s | 35.243085 s | 0.320445 s |

Mean `total_wall` changed from `35.704871 s` to `35.289442 s`, an improvement
of `0.415429 s` or `1.164%`. The paired 95% Student-t interval was
`0.262141 s` to `0.568717 s`, and all five pairs favored Candidate.

The three-evaluation boundary changed from `0.440456 s` to `0.088505 s` on
mean. Mean `prove4.total` changed from `8.390605 s` to `7.998948 s`.

## Isolated CUDA Benchmark

Five CUDA pairs used the same execution order, source, fixture, CRS, NVIDIA A10
host, and timing instrumentation. The host was later found to be in a degraded
execution state. The paired deltas remain useful because each pair used the same
host state, but the absolute `35 s` values below are not a valid CUDA baseline.

| pair | Legacy `total_wall` | Candidate `total_wall` | improvement |
| ---: | ---: | ---: | ---: |
| 1 | 35.408827 s | 35.670730 s | -0.261902 s |
| 2 | 35.550880 s | 35.612880 s | -0.062000 s |
| 3 | 35.300071 s | 35.457078 s | -0.157007 s |
| 4 | 35.312387 s | 35.934529 s | -0.622142 s |
| 5 | 35.603514 s | 35.414510 s | 0.189003 s |

Mean `total_wall` changed from `35.435136 s` to `35.617946 s`, a regression of
`0.182810 s`. The paired 95% interval ranged from a `0.551552 s` regression to
a `0.185932 s` improvement and therefore included zero.

The candidate-owned boundary regressed reproducibly from `0.061781 s` to
`0.134321 s` on mean because the three full-grid coefficient copies and batch
dispatcher overhead exceeded the three legacy CUDA evaluation costs.

The project owner classified the CUDA end-to-end movement as noise and approved
the unified path rather than a backend-specific branch.

## Production Integration

Production:

- exposes `DensePolynomialExt::eval_same_point_batch`;
- evaluates the R family through the grouped path unconditionally;
- retains exact comparison with the three independent evaluations only under
  `testing-mode`;
- contains no experiment selector, active-device branch, or silent fallback.

Focused exact parity ran once and passed. The complete production CUDA
`timing,testing-mode` fixture ran once and passed. One fresh matching
preprocess/prove/verify sequence returned `true`.

## Production Timing

Per project-owner direction, production timing was measured three times per
backend. Correctness and exact parity were not repeated as timing samples.

### CPU

| sample | `total_wall` | `prove4.total` | grouped boundary |
| ---: | ---: | ---: | ---: |
| 1 | 36.839226 s | 8.359907 s | 0.090785 s |
| 2 | 37.078975 s | 8.418260 s | 0.090658 s |
| 3 | 37.102702 s | 8.381713 s | 0.090594 s |
| mean | 37.006968 s | 8.386627 s | 0.090679 s |
| median | 37.078975 s | 8.381713 s | 0.090658 s |

The median `total_wall` sample regenerated
`timing.local.cpu.current.json` and `timing.local.cpu.current.md`.

### CUDA

| sample | `total_wall` | `prove4.total` | grouped boundary |
| ---: | ---: | ---: | ---: |
| 1 | 23.648456 s | 7.966462 s | 0.086485 s |
| 2 | 23.336629 s | 7.773833 s | 0.086314 s |
| 3 | 23.155058 s | 7.712419 s | 0.087091 s |
| mean | 23.380048 s | 7.817571 s | 0.086630 s |
| median | 23.336629 s | 7.773833 s | 0.086485 s |

The first production CUDA set measured `35.910590 s`, `35.034587 s`, and
`35.238560 s`. Those samples were rejected because the same 234-placement
fixture had previously completed in approximately `22.8-23.7 s`, and a
published prebuilt prover also regressed to `41.872 s` on the affected host.
The slowdown was distributed across all prove stages rather than concentrated
in the grouped evaluation.

The CUDA environment was rebuilt on a fresh Lambda Cloud A10 instance with the
same 30-vCPU Intel Xeon Platinum 8358 profile, NVIDIA driver `580.105.08`, CUDA
toolkit `12.8`, ICICLE `3.8.0` Ubuntu 22 CUDA 12.2 backend, and published
`tokamak-backend-crs-v2.1-20260502T085053Z.zip` CRS. A continuously monitored
run measured `23.692819 s`. It observed no competing workload, CPU steal, I/O
wait, swap activity, or memory pressure; the GPU ran at PCIe Gen4 x16 and up to
1695 MHz. Three subsequent unmonitored timing-only runs produced the table
above and restored the previous same-fixture range.

The exact degraded-host cause was not recoverable after the instance was
replaced. The clean-instance reproduction establishes that the `35 s` set was
an environment failure rather than a Candidate 2D production regression.

## Final Result

Candidate 2D is accepted as a unified backend-neutral optimization. Its CPU
end-to-end benefit is established by the isolated paired benchmark. The known
CUDA local-boundary regression is retained by explicit project-owner decision
because the paired CUDA end-to-end result did not exceed noise.
