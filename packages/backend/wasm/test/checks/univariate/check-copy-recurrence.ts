import assert from "node:assert/strict";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import { buildCopyRecurrence } from "../../../src/univariate/reference-prover.js";
const runtime = await createCurveRuntime();
try {
  const f = runtime.Fr;
  const old = (root: Uint8Array, n: number, b: Uint8Array, sc: Uint8Array, beta: Uint8Array, gamma: Uint8Array) => {
    const out = f.createZeroBuffer(n); f.writeBufferElement(out, 0, f.one);
    let point = f.one;
    for (let i = 0; i < n; i++) {
      const numerator = f.add(f.add(f.readBufferElement(b, i), f.mul(beta, f.readBufferElement(sc, i))), gamma);
      const denominator = f.add(f.add(f.readBufferElement(b, i), f.mul(beta, point)), gamma);
      if (f.isZero(denominator)) throw Error("denominator");
      if (i + 1 < n) f.writeBufferElement(out, i + 1, f.div(f.mul(f.readBufferElement(out, i), numerator), denominator));
      else assert(f.eq(f.mul(f.readBufferElement(out, i), numerator), denominator));
      point = f.mul(point, root);
    }
    return out;
  };
  for (const n of [1, 2, 8, 32, 262144]) {
    const root = f.rootOfUnity(n), beta = f.fromBigInt(2n), gamma = f.fromBigInt(3n);
    const b = f.concat(Array.from({ length: n }, () => f.fromBigInt(7n)));
    const sc = f.createZeroBuffer(n);
    let point = f.one;
    for (let i = 0; i < n; i++) { f.writeBufferElement(sc, n - i - 1, point); point = f.mul(point, root); }
    const samples = [];
    let expected: Uint8Array | undefined;
    for (let repeat = 0; repeat < 4; repeat++) {
      const start = performance.now();
      const out = repeat % 2 ? await buildCopyRecurrence(f, root, n, b, sc, beta, gamma) : old(root, n, b, sc, beta, gamma);
      samples.push({ candidate: Boolean(repeat % 2), ms: performance.now() - start });
      expected ??= out;
      assert.deepEqual(out, expected);
    }
    if (n === 262144) console.log(JSON.stringify({ n, samples }));
    else {
      const invalid = sc.slice(); f.writeBufferElement(invalid, 0, f.zero);
      await assert.rejects(() => buildCopyRecurrence(f, root, n, b, invalid, beta, gamma), /does not close/);
      for (const index of [0, n - 1]) {
        const zeroGamma = f.neg(f.add(f.fromBigInt(7n), f.mul(beta, f.pow(root, index))));
        await assert.rejects(() => buildCopyRecurrence(f, root, n, b, sc, beta, zeroGamma), /denominator vanishes/);
      }
    }
  }
  await assert.rejects(() => f.orderedRecurrenceBuffer(new Uint8Array(), new Uint8Array()), /positive/);
} finally { await runtime.terminate(); }
console.log("Checked forward univariate recurrence, batch inversion, zero rejection and closure.");
