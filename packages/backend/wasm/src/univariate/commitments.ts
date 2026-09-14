import type { CurveRuntime } from "../runtime/curve/curve.js";
import {
  msmAffineMontgomeryChunks,
  type AffineMontgomeryMsmChunk,
} from "../runtime/group/affine-msm.js";
import { G1_AFFINE_BYTES } from "../runtime/group/group.js";
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

/** Reuse a CRS base range without combining the two transcript commitments. */
export async function commitSharedBases(runtime: CurveRuntime, section: UnivariateCrsChunkSection, first: Uint8Array, second: Uint8Array, chunkPoints: number): Promise<readonly [Uint8Array, Uint8Array]> {
  const count = Math.max(fieldElementCount(runtime, first, "First shared-base coefficients"), fieldElementCount(runtime, second, "Second shared-base coefficients"));
  assertKzgRange(section, count, "Shared-base polynomial");
  assertChunkPoints(chunkPoints);
  const results = [runtime.G1.zero, runtime.G1.zero];
  for (let start = 0; start < count; start += chunkPoints) {
    const take = Math.min(chunkPoints, count - start);
    const scalars = [];
    for (const source of [first, second]) {
      const values = runtime.Fr.createZeroBuffer(take);
      values.set(source.subarray(start * 32, (start + take) * 32));
      scalars.push(await runtime.Fr.batchFromMontgomeryBuffer(values));
    }
    const terms = await runtime.G1.msmAffineRawPair(await section.readElements(start, take), scalars[0]!, scalars[1]!);
    for (let i = 0; i < 2; i++) if (!runtime.G1.isZero(terms[i]!)) results[i] = runtime.G1.isZero(results[i]!) ? terms[i]! : runtime.G1.add(results[i]!, terms[i]!);
  }
  return [results[0]!, results[1]!];
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
