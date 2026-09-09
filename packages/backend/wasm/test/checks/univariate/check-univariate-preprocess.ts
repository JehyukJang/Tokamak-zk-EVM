import assert from "node:assert/strict";

import { decodeBinaryArtifactFile } from "../../../src/artifacts/binary/binary-artifact-file.js";
import { BinaryArtifactFileKind } from "../../../src/artifacts/binary/binary-format.js";
import { createPreprocessOutput } from "../../../src/preprocess/api/output.js";
import { preprocessSnark } from "../../../src/preprocess/protocol/preprocess-snark.js";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import { concatBytes } from "../../../src/runtime/bytes.js";
import { deriveUnivariateDomainShape } from "../../../src/univariate/domain.js";
import { buildConnectionPermutationPolynomial } from "../../../src/univariate/relation.js";
import { placementSelectorPolynomial } from "../../../src/univariate/selectors.js";
import type { UnivariateCrsChunkSection } from "../../../src/univariate/chunked-crs.js";

const setup = {
  l_free: 0,
  l: 1,
  l_user_out: 0,
  l_user: 0,
  l_D: 3,
  m_D: 3,
  n: 2,
  s_D: 1,
  s_max: 2,
} as const;
const selector = [0, null] as const;
const permutation = [
  { row: 0, col: 0, X: 1, Y: 1 },
  { row: 1, col: 1, X: 0, Y: 0 },
] as const;

const runtime = await createCurveRuntime();
try {
  const tau = runtime.Fr.fromBigInt(2n);
  const kzgPowers = makeKzgPowers(tau, 8);
  const computation = await preprocessSnark(runtime, {
    setup,
    selector,
    permutation,
    crs: { s0: kzgPowers },
  }, { denseMsmChunkPoints: 2 });

  const domain = deriveUnivariateDomainShape(runtime.Fr, setup);
  const [selectorPolynomial, permutationPolynomial] = await Promise.all([
    placementSelectorPolynomial(runtime.Fr, domain, setup, selector),
    buildConnectionPermutationPolynomial(runtime.Fr, domain, setup, permutation),
  ]);
  const expectedSelector = runtime.G1.mulAffineScalar(
    runtime.G1.generator,
    evaluateStrided(selectorPolynomial.coefficients, selectorPolynomial.stride, tau),
  );
  const expectedPermutation = runtime.G1.mulAffineScalar(
    runtime.G1.generator,
    evaluateDense(permutationPolynomial.coefficients, tau),
  );
  assert.ok(runtime.G1.eq(computation.sKappa, expectedSelector), "S_kappa must commit U9a at tau");
  assert.ok(runtime.G1.eq(computation.sC, expectedPermutation), "S_C must commit U12 at tau");

  const encoded = await createPreprocessOutput(runtime, computation.sKappa, computation.sC);
  const decoded = await decodeBinaryArtifactFile(encoded);
  assert.equal(decoded.kind, BinaryArtifactFileKind.UnivariateVerifierPreprocess);
  assert.equal(decoded.sections.length, 1);
  assert.equal(decoded.sections[0]?.elementCount, 2);
  assert.equal(decoded.sections[0]?.label, "preprocess.g1");

  await assert.rejects(
    preprocessSnark(runtime, { setup, selector: [1, null], permutation, crs: { s0: kzgPowers } }),
    /subcircuit index is outside its admitted range/,
  );
  await assert.rejects(
    preprocessSnark(runtime, {
      setup,
      selector,
      permutation: [{ row: 0, col: 0, X: 1, Y: 1 }],
      crs: { s0: kzgPowers },
    }),
    /more than one source/,
  );
} finally {
  await runtime.terminate();
}

console.log("Checked univariate preprocess commitments, output format, and statement admission");

function makeKzgPowers(tau: ReturnType<typeof runtime.Fr.fromBigInt>, count: number): UnivariateCrsChunkSection {
  const powers = [];
  let tauPower = runtime.Fr.one;
  for (let index = 0; index < count; index += 1) {
    powers.push(runtime.G1.toAffine(runtime.G1.mulScalar(runtime.G1.generator, tauPower)));
    tauPower = runtime.Fr.mul(tauPower, tau);
  }
  const data = concatBytes(powers);
  return {
    encoding: "ffjs-g1-affine-96",
    label: "crs.s0",
    elementCount: count,
    elementByteLength: 96,
    async readElement(index) {
      return this.readElements(index, 1);
    },
    async readElements(first, elementCount) {
      return data.slice(first * 96, (first + elementCount) * 96);
    },
    async readStridedElements(first, stride, elementCount) {
      const output = new Uint8Array(elementCount * 96);
      for (let index = 0; index < elementCount; index += 1) {
        output.set(data.subarray((first + index * stride) * 96, (first + index * stride + 1) * 96), index * 96);
      }
      return output;
    },
  };
}

function evaluateStrided(
  coefficients: readonly ReturnType<typeof runtime.Fr.fromBigInt>[],
  stride: number,
  point: ReturnType<typeof runtime.Fr.fromBigInt>,
): ReturnType<typeof runtime.Fr.fromBigInt> {
  return evaluateElements(coefficients, runtime.Fr.pow(point, stride));
}

function evaluateDense(
  coefficients: Uint8Array,
  point: ReturnType<typeof runtime.Fr.fromBigInt>,
): ReturnType<typeof runtime.Fr.fromBigInt> {
  const terms = Array.from({ length: runtime.Fr.bufferElementCount(coefficients) }, (_, index) =>
    runtime.Fr.readBufferElement(coefficients, index),
  );
  return evaluateElements(terms, point);
}

function evaluateElements(
  coefficients: readonly ReturnType<typeof runtime.Fr.fromBigInt>[],
  point: ReturnType<typeof runtime.Fr.fromBigInt>,
): ReturnType<typeof runtime.Fr.fromBigInt> {
  return coefficients.reduceRight(
    (accumulator, coefficient) => runtime.Fr.add(runtime.Fr.mul(accumulator, point), coefficient),
    runtime.Fr.zero,
  );
}
