import type { BinarySectionView } from "../artifacts/binary/binary-format.js";
import type { CurveRuntime } from "../runtime/curve/curve.js";
import {
  msmAffineMontgomeryChunks,
  type AffineMontgomeryMsmChunk,
} from "../runtime/group/affine-msm.js";
import { G1_AFFINE_BYTES } from "../runtime/group/group.js";
import type { StridedPolynomial } from "./selectors.js";

/** Commits a dense coefficient vector with the ordinary KZG power section. */
export async function commitDenseUnivariatePolynomial(
  runtime: CurveRuntime,
  kzgPowers: BinarySectionView,
  coefficients: Uint8Array,
  chunkPoints: number,
): Promise<Uint8Array> {
  const coefficientCount = fieldElementCount(runtime, coefficients, "Dense polynomial coefficients");
  assertKzgRange(kzgPowers, coefficientCount, "Dense polynomial");
  return msmAffineMontgomeryChunks(
    runtime,
    contiguousChunks(kzgPowers.data, coefficients, coefficientCount, runtime.Fr.byteLength, chunkPoints),
  );
}

/**
 * Commits `sum_q coefficients[q] * tau^(q * stride)` without expanding the
 * sparse polynomial into the arithmetic domain.  The temporary base chunks
 * contain only the selected ordinary KZG powers.
 */
export async function commitStridedUnivariatePolynomial(
  runtime: CurveRuntime,
  kzgPowers: BinarySectionView,
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
    stridedChunks(kzgPowers.data, coefficients, polynomial.stride, coefficientCount, runtime.Fr.byteLength, chunkPoints),
  );
}

function* contiguousChunks(
  bases: Uint8Array,
  coefficients: Uint8Array,
  count: number,
  fieldElementBytes: number,
  chunkPoints: number,
): Iterable<AffineMontgomeryMsmChunk> {
  assertChunkPoints(chunkPoints);
  for (let start = 0; start < count; start += chunkPoints) {
    const end = Math.min(start + chunkPoints, count);
    yield {
      bases: bases.subarray(start * G1_AFFINE_BYTES, end * G1_AFFINE_BYTES),
      montgomeryScalars: coefficients.subarray(start * fieldElementBytes, end * fieldElementBytes),
    };
  }
}

function* stridedChunks(
  allBases: Uint8Array,
  coefficients: Uint8Array,
  stride: number,
  count: number,
  fieldElementBytes: number,
  chunkPoints: number,
): Iterable<AffineMontgomeryMsmChunk> {
  for (let start = 0; start < count; start += chunkPoints) {
    const end = Math.min(start + chunkPoints, count);
    const bases = new Uint8Array((end - start) * G1_AFFINE_BYTES);
    for (let index = start; index < end; index += 1) {
      const sourceOffset = index * stride * G1_AFFINE_BYTES;
      bases.set(allBases.subarray(sourceOffset, sourceOffset + G1_AFFINE_BYTES), (index - start) * G1_AFFINE_BYTES);
    }
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

function assertKzgRange(section: BinarySectionView, requiredCount: number, label: string): void {
  if (
    section.elementByteLength !== G1_AFFINE_BYTES
    || section.data.byteLength !== section.elementCount * G1_AFFINE_BYTES
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
