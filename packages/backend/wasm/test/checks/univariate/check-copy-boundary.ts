import assert from "node:assert/strict";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import { DenseUnivariatePolynomial as P } from "../../../src/univariate/polynomial.js";
import { copyBoundaryQuotient } from "../../../src/univariate/reference-prover.js";
const runtime = await createCurveRuntime();
try {
  const f = runtime.Fr, constant = (x: bigint) => P.fromCoefficients(f, f.concat([f.fromBigInt(x)]));
  const old = async (p: P, n: number) => {
    const l0 = P.fromCoefficients(f, f.concat(Array.from({ length: n }, () => f.inv(f.fromBigInt(BigInt(n))))));
    return (await p.sub(constant(1n)).multiply(l0)).divideVanishingExact(n);
  };
  for (const n of [1, 2, 8, 64]) {
    const mask = P.fromCoefficients(f, f.concat([f.fromBigInt(2n), f.fromBigInt(3n), f.fromBigInt(4n), f.fromBigInt(5n)]));
    const r = constant(1n).add(mask.multiplyVanishing(n));
    assert.deepEqual(copyBoundaryQuotient(f, r, n).coefficients, (await old(r, n)).coefficients);
    assert.deepEqual(copyBoundaryQuotient(f, constant(1n), n).coefficients, P.zero(f).coefficients);
    assert.throws(() => copyBoundaryQuotient(f, r.add(constant(1n)), n), /must equal one/);
    await assert.rejects(() => old(r.add(constant(1n)), n), /not divisible/);
  }
  const n = 262144;
  const r = P.fromCoefficients(f, f.concat(Array.from({ length: n }, (_, i) => f.fromBigInt(BigInt(i)))));
  const admissible = r.sub(P.fromCoefficients(f, f.concat([r.evaluate(f.one)]))).add(constant(1n)).add(constant(5n).multiplyVanishing(n));
  const samples = [];
  for (let i = 0; i < 4; i++) {
    const start = performance.now();
    const value = i % 2 ? copyBoundaryQuotient(f, admissible, n) : await old(admissible, n);
    samples.push({ candidate: Boolean(i % 2), ms: performance.now() - start });
    assert.deepEqual(value.coefficients, copyBoundaryQuotient(f, admissible, n).coefficients);
  }
  console.log(JSON.stringify({ n, samples }));
} finally { await runtime.terminate(); }
