import type { CurveRuntime } from "../runtime/curve/curve.js";
import {
  msmAffineMontgomeryChunks,
  type AffineMontgomeryMsmChunk,
} from "../runtime/group/affine-msm.js";
import { G1_AFFINE_BYTES } from "../runtime/group/group.js";
import type { StridedPolynomial } from "./selectors.js";
import type { UnivariateCrsChunkSection } from "./chunked-crs.js";

/** Commits a dense coefficient vector with the ordinary KZG power section. */
export async function commitDenseUnivariatePolynomial(
  runtime: CurveRuntime,
  kzgPowers: UnivariateCrsChunkSection,
  coefficients: Uint8Array,
  chunkPoints: number,
  firstPower = 0,
): Promise<Uint8Array> {
  const coefficientCount = fieldElementCount(runtime, coefficients, "Dense polynomial coefficients");
  assertKzgRange(kzgPowers, firstPower + coefficientCount, "Dense polynomial");
  return msmAffineMontgomeryChunks(
    runtime,
    contiguousChunks(kzgPowers, coefficients, firstPower, coefficientCount, runtime.Fr.byteLength, chunkPoints),
  );
}

/**
 * Commits `sum_q coefficients[q] * tau^(q * stride)` without expanding the
 * sparse polynomial into the arithmetic domain.  The temporary base chunks
 * contain only the selected ordinary KZG powers.
 */
export async function commitStridedUnivariatePolynomial(
  runtime: CurveRuntime,
  kzgPowers: UnivariateCrsChunkSection,
  polynomial: StridedPolynomial,
  chunkPoints: number,
): Promise<Uint8Array> {
  assertChunkPoints(chunkPoints);
  if (!Number.isSafeInteger(polynomial.stride) || polynomial.stride <= 0) {
    throw new Error("Strided polynomial stride must be a positive safe integer.");
  }
  const coefficientCount = polynomial.coefficients.length;
  if (coefficientCount === 0) {
    return runtime.G1.zero;
  }
  const maximumDegree = (coefficientCount - 1) * polynomial.stride;
  if (!Number.isSafeInteger(maximumDegree)) {
    throw new Error("Strided polynomial degree is not a safe integer.");
  }
  assertKzgRange(kzgPowers, maximumDegree + 1, "Strided polynomial");
  const coefficients = runtime.Fr.concat(polynomial.coefficients);
  return msmAffineMontgomeryChunks(
    runtime,
    stridedChunks(kzgPowers, coefficients, polynomial.stride, coefficientCount, runtime.Fr.byteLength, chunkPoints),
  );
}

async function* contiguousChunks(
  bases: UnivariateCrsChunkSection,
  coefficients: Uint8Array,
  firstPower: number,
  count: number,
  fieldElementBytes: number,
  chunkPoints: number,
): AsyncIterable<AffineMontgomeryMsmChunk> {
  assertChunkPoints(chunkPoints);
  for (let start = 0; start < count; start += chunkPoints) {
    const end = Math.min(start + chunkPoints, count);
    yield {
      bases: await bases.readElements(firstPower + start, end - start),
      montgomeryScalars: coefficients.subarray(start * fieldElementBytes, end * fieldElementBytes),
    };
  }
}

async function* stridedChunks(
  allBases: UnivariateCrsChunkSection,
  coefficients: Uint8Array,
  stride: number,
  count: number,
  fieldElementBytes: number,
  chunkPoints: number,
): AsyncIterable<AffineMontgomeryMsmChunk> {
  for (let start = 0; start < count; start += chunkPoints) {
    const end = Math.min(start + chunkPoints, count);
    const bases = await allBases.readStridedElements(start * stride, stride, end - start);
    yield {
      bases,
      montgomeryScalars: coefficients.subarray(start * fieldElementBytes, end * fieldElementBytes),
    };
  }
}

function fieldElementCount(runtime: CurveRuntime, values: Uint8Array, label: string): number {
  if (values.byteLength % runtime.Fr.byteLength !== 0) {
    throw new Error(`${label} must contain whole field elements.`);
  }
  return values.byteLength / runtime.Fr.byteLength;
}

function assertKzgRange(section: UnivariateCrsChunkSection, requiredCount: number, label: string): void {
  if (
    section.elementByteLength !== G1_AFFINE_BYTES
    || section.elementCount < requiredCount
  ) {
    throw new Error(`${label} requires ${requiredCount} ordinary KZG powers.`);
  }
}

function assertChunkPoints(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Preprocess MSM chunk size must be a positive safe integer.");
  }
}
