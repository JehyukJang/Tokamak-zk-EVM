import assert from "node:assert/strict";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import { commitDenseUnivariatePolynomial, commitSharedBases } from "../../../src/univariate/commitments.js";
import type { UnivariateCrsChunkSection } from "../../../src/univariate/chunked-crs.js";
const runtime = await createCurveRuntime();
try {
  const f = runtime.Fr, g = runtime.G1;
  const section = (count: number): UnivariateCrsChunkSection => ({
    label: "test", encoding: "g1", elementCount: count, elementByteLength: 96,
    async readElements(start, n) {
      assert(start >= 0 && start + n <= count);
      const out = new Uint8Array(n * 96); for (let i = 0; i < n; i++) out.set(g.generator, i * 96); return out;
    },
    async readElement() { throw Error("unused"); }, async readStridedElements() { throw Error("unused"); },
  });
  for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1], [17, 3], [3, 33], [33, 33]]) for (const size of [1, 4, 32]) for (const zero of [false, true]) {
    const first = f.concat(Array.from({ length: a! }, (_, i) => zero ? f.zero : f.fromBigInt(BigInt(i + 1))));
    const second = f.concat(Array.from({ length: b! }, (_, i) => zero ? f.zero : f.neg(f.fromBigInt(BigInt(i + 1)))));
    const bases = section(Math.max(a!, b!));
    const expected = [await commitDenseUnivariatePolynomial(runtime, bases, first, size), await commitDenseUnivariatePolynomial(runtime, bases, second, size)];
    const actual = await commitSharedBases(runtime, bases, first, second, size);
    actual.forEach((point, i) => assert(g.eq(point, expected[i]!)));
  }
  await assert.rejects(() => commitSharedBases(runtime, section(0), f.one, f.one, 1), /requires/);
  await assert.rejects(() => commitSharedBases(runtime, section(1), f.one, f.one, 0), /positive/);
  await assert.rejects(() => g.msmAffineRawPair(new Uint8Array(1), f.one, f.one), /length mismatch/);
  const pool = [g.zero, g.generator, g.toAffine(g.neg(g.generator)), g.toAffine(g.mulScalar(g.generator, f.fromBigInt(7n)))];
  for (const count of [1, 2, 3, 17, 257, 1025, 4097, 262144]) {
    const bases = new Uint8Array(count * 96), first = f.createZeroBuffer(count), second = f.createZeroBuffer(count);
    let state = 19n;
    for (let i = 0; i < count; i++) {
      state = (state * 6364136223846793005n + 1442695040888963407n) % f.modulus;
      bases.set(pool[i % pool.length]!, i * 96);
      first.set(f.toRawLittleEndian(f.fromBigInt(i % 7 === 0 ? 0n : i % 7 === 1 ? f.modulus - 1n : state)), i * 32);
      second.set(f.toRawLittleEndian(f.fromBigInt((state * 31n) % f.modulus)), i * 32);
    }
    const control = async () => [await g.msmAffineRaw(bases, first), await g.msmAffineRaw(bases, second)];
    const candidate = () => g.msmAffineRawPair(bases, first, second);
    const expected = await control(), actual = await candidate();
    actual.forEach((p, i) => assert(g.eq(p, expected[i]!)));
    if (count === 262144) {
      const samples = [];
      for (let i = 0; i < 5; i++) for (const [mode, run] of [["control", control], ["candidate", candidate]] as const) {
        const start = performance.now(), out = await run(); samples.push({ mode, ms: performance.now() - start });
        out.forEach((p, j) => assert(g.eq(p, expected[j]!)));
      }
      console.log(JSON.stringify({ count, samples }));
    }
  }
} finally { await runtime.terminate(); }
console.log("Checked independent shared-base commitments, full scalars, unequal lengths, identities and chunk tails.");
