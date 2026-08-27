import { getCurveFromName } from "ffjavascript";

import { createBinaryArtifactFile } from "../../artifacts/binary/binary-artifact-file.js";
import {
  BinarySectionEncoding,
  BinarySectionType,
  type BinarySectionInput,
} from "../../artifacts/binary/binary-format.js";
import { BACKEND_BROWSER_ARTIFACT_CONTRACT } from "../../generated/backend-browser-artifact-contract.generated.js";
import {
  PREPROCESS_CRS_V1_SPEC,
  PROVER_CRS_V1_SPEC,
  SIGMA_VERIFY_V1_SPEC,
} from "../../generated/browser-artifact-contracts.generated.js";
import { G1_AFFINE_BYTES } from "../../runtime/group/group.js";
import type { RuntimeArtifactSectionSpec } from "../../artifacts/specs/types.js";

const G2_AFFINE_BYTES = 192;
const FQ_BYTES = 48;
const FQ_BATCH_CONVERSION_CHUNK_ELEMENTS = 1 << 18;
const combinedSigmaPayloadContract = BACKEND_BROWSER_ARTIFACT_CONTRACT.combinedSigmaPayload;

interface RawBaseField {
  batchToMontgomery(input: Uint8Array): Promise<Uint8Array>;
}

interface ConverterCurve {
  readonly F1: RawBaseField;
  terminate?(): Promise<void>;
}

interface PointSectionDefinition {
  readonly label: string;
  readonly data: Uint8Array;
  readonly expectedElementCount?: number;
  readonly elementByteLength: number;
  readonly type: BinarySectionType;
  readonly encoding: BinarySectionEncoding;
}

export interface RkyvToBinaryConverterOptions {
  readonly sourcePackageVersion: string;
  readonly decoder: RkyvArchiveDecoder;
  readonly setup: CsrSetupShape;
}

export interface CsrSetupShape {
  readonly l: number;
  readonly l_free: number;
  readonly l_D: number;
  readonly n: number;
  readonly s_max: number;
}

export interface ConvertedCrsBinaries {
  readonly proverCrs: Uint8Array;
  readonly preprocessCrs: Uint8Array;
  readonly verifierCrs: Uint8Array;
}

export interface RkyvArchiveDecoder {
  decodeCombinedSigma(input: Uint8Array): Promise<DecodedCombinedSigmaRkyv> | DecodedCombinedSigmaRkyv;
}

export interface DecodedCombinedSigmaRkyv {
  readonly g1: Uint8Array;
  readonly sigma1XyPowers: Uint8Array;
  readonly sigma1GammaInvOInst: Uint8Array;
  readonly sigma1EtaInvLiOInterAlpha4Kj: Uint8Array;
  readonly sigma1DeltaInvLiOPrv: Uint8Array;
  readonly sigma1DeltaInvAlphakXhTx: Uint8Array;
  readonly sigma1DeltaInvAlpha4XjTx: Uint8Array;
  readonly sigma1DeltaInvAlphakYiTy: Uint8Array;
  readonly g2: Uint8Array;
}

export async function convertCombinedSigmaRkyvToCrsBinaries(
  input: Uint8Array,
  options: RkyvToBinaryConverterOptions,
): Promise<ConvertedCrsBinaries> {
  const decoded = await options.decoder.decodeCombinedSigma(input);
  const shape = requireCrsSetupShape(options.setup);
  const curve = await getCurveFromName("bls12381") as ConverterCurve;

  try {
    const sourceDefinitions = PROVER_CRS_V1_SPEC.sections.map((sectionSpec, index) =>
      pointDefinition(sectionSpec, combinedSigmaDecodedSection(decoded, index)));
    const convertedDefinitions: PointSectionDefinition[] = [];
    for (const definition of sourceDefinitions) {
      assertPointSectionShape(definition);
      const data = await batchToMontgomeryInChunks(curve.F1, definition.data);
      convertedDefinitions.push({
        ...definition,
        data,
      });
    }

    const sourcePackageVersion = requireSourcePackageVersion(options.sourcePackageVersion);
    const proverCrs = await createBinaryArtifactFile({
      kind: PROVER_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: convertedDefinitions.map(toBinarySectionInput),
    });
    const preprocessCrs = await createPreprocessCrs(
      requireConvertedDefinition(convertedDefinitions, "sigma1.xy-powers").data,
      requireConvertedDefinition(convertedDefinitions, "sigma1.gamma-inv-o-inst").data,
      shape,
      sourcePackageVersion,
    );
    const verifierCrs = await createVerifierCrs(
      requireConvertedDefinition(convertedDefinitions, "sigma.g1").data,
      requireConvertedDefinition(convertedDefinitions, "sigma.g2").data,
      sourcePackageVersion,
    );

    return { proverCrs, preprocessCrs, verifierCrs };
  } finally {
    await curve.terminate?.();
  }
}

async function batchToMontgomeryInChunks(
  field: RawBaseField,
  input: Uint8Array,
): Promise<Uint8Array> {
  if (input.byteLength % FQ_BYTES !== 0) {
    throw new Error("CRS base-field buffer byte length must be divisible by 48.");
  }

  const chunkBytes = FQ_BATCH_CONVERSION_CHUNK_ELEMENTS * FQ_BYTES;
  const output = new Uint8Array(input.byteLength);
  for (let offset = 0; offset < input.byteLength; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, input.byteLength);
    output.set(await field.batchToMontgomery(input.subarray(offset, end)), offset);
  }
  return output;
}

function toBinarySectionInput(definition: PointSectionDefinition): BinarySectionInput {
  return {
    type: definition.type,
    encoding: definition.encoding,
    label: definition.label,
    elementCount: definition.data.byteLength / definition.elementByteLength,
    elementByteLength: definition.elementByteLength,
    data: definition.data,
  };
}

async function createPreprocessCrs(
  xyPowers: Uint8Array,
  gammaInvOInst: Uint8Array,
  shape: CsrSetupShape,
  sourcePackageVersion: string,
): Promise<Uint8Array> {
  const mI = shape.l_D - shape.l;
  const mFunction = shape.l - shape.l_free;
  const sourceXSize = Math.max(shape.n * 2, mI * 2);
  const sourceYSize = shape.s_max * 2;
  assertPointCount(xyPowers, sourceXSize * sourceYSize, G1_AFFINE_BYTES, "sigma1.xy-powers");
  assertPointCount(gammaInvOInst, shape.l, G1_AFFINE_BYTES, "sigma1.gamma-inv-o-inst");

  const compactXyPowers = compactPointRectangle(
    xyPowers,
    sourceYSize,
    mI,
    shape.s_max,
  );
  const compactGammaInvOInst = pointTail(gammaInvOInst, mFunction);

  return createBinaryArtifactFile({
    kind: PREPROCESS_CRS_V1_SPEC.kind,
    sourcePackageVersion,
    sections: [
      toBinarySectionInput(pointDefinition(PREPROCESS_CRS_V1_SPEC.sections[0], compactXyPowers)),
      toBinarySectionInput(pointDefinition(PREPROCESS_CRS_V1_SPEC.sections[1], compactGammaInvOInst)),
    ],
  });
}

async function createVerifierCrs(
  sigmaG1: Uint8Array,
  sigmaG2: Uint8Array,
  sourcePackageVersion: string,
): Promise<Uint8Array> {
  assertPointCount(sigmaG1, 6, G1_AFFINE_BYTES, "sigma.g1");
  assertPointCount(sigmaG2, 10, G2_AFFINE_BYTES, "sigma.g2");

  return createBinaryArtifactFile({
    kind: SIGMA_VERIFY_V1_SPEC.kind,
    sourcePackageVersion,
    sections: [
      toBinarySectionInput(pointDefinition(SIGMA_VERIFY_V1_SPEC.sections[0], selectPoints(sigmaG1, [0, 1, 2, 5]))),
      toBinarySectionInput(pointDefinition(SIGMA_VERIFY_V1_SPEC.sections[1], sigmaG2)),
    ],
  });
}

function compactPointRectangle(
  points: Uint8Array,
  sourceColumns: number,
  outputRows: number,
  outputColumns: number,
): Uint8Array {
  if (outputColumns > sourceColumns) {
    throw new Error("Preprocess CRS compact column count exceeds the source row width.");
  }

  const output = new Uint8Array(outputRows * outputColumns * G1_AFFINE_BYTES);
  const sourceRowBytes = sourceColumns * G1_AFFINE_BYTES;
  const outputRowBytes = outputColumns * G1_AFFINE_BYTES;
  for (let row = 0; row < outputRows; row += 1) {
    const sourceOffset = row * sourceRowBytes;
    output.set(
      points.subarray(sourceOffset, sourceOffset + outputRowBytes),
      row * outputRowBytes,
    );
  }
  return output;
}

function pointTail(points: Uint8Array, pointCount: number): Uint8Array {
  const byteLength = pointCount * G1_AFFINE_BYTES;
  return points.slice(points.byteLength - byteLength);
}

function selectPoints(points: Uint8Array, indexes: readonly number[]): Uint8Array {
  const output = new Uint8Array(indexes.length * G1_AFFINE_BYTES);
  for (let outputIndex = 0; outputIndex < indexes.length; outputIndex += 1) {
    const sourceOffset = indexes[outputIndex] * G1_AFFINE_BYTES;
    output.set(
      points.subarray(sourceOffset, sourceOffset + G1_AFFINE_BYTES),
      outputIndex * G1_AFFINE_BYTES,
    );
  }
  return output;
}

function assertPointCount(
  points: Uint8Array,
  expected: number,
  elementByteLength: number,
  label: string,
): void {
  const actual = points.byteLength / elementByteLength;
  if (points.byteLength % elementByteLength !== 0 || actual !== expected) {
    throw new Error(`${label} must contain exactly ${expected} points; received ${actual}.`);
  }
}

function requireCrsSetupShape(shape: CsrSetupShape): CsrSetupShape {
  for (const [name, value] of Object.entries(shape)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`CRS setup shape '${name}' must be a positive safe integer.`);
    }
  }
  if (shape.l_free > shape.l || shape.l > shape.l_D) {
    throw new Error("CRS setup shape must satisfy l_free <= l <= l_D.");
  }
  return shape;
}

export function createCombinedSigmaRkyvPayloadDecoder(
  decodePayload: (input: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): RkyvArchiveDecoder {
  return {
    async decodeCombinedSigma(input) {
      return decodeCombinedSigmaRkyvPayload(await decodePayload(input));
    },
  };
}

export function decodeCombinedSigmaRkyvPayload(payload: Uint8Array): DecodedCombinedSigmaRkyv {
  const sections = readCombinedSigmaPayloadSections(payload);

  return {
    g1: combinedSigmaPayloadSection(sections, "g1"),
    sigma1XyPowers: combinedSigmaPayloadSection(sections, "sigma1XyPowers"),
    sigma1GammaInvOInst: combinedSigmaPayloadSection(sections, "sigma1GammaInvOInst"),
    sigma1EtaInvLiOInterAlpha4Kj: combinedSigmaPayloadSection(sections, "sigma1EtaInvLiOInterAlpha4Kj"),
    sigma1DeltaInvLiOPrv: combinedSigmaPayloadSection(sections, "sigma1DeltaInvLiOPrv"),
    sigma1DeltaInvAlphakXhTx: combinedSigmaPayloadSection(sections, "sigma1DeltaInvAlphakXhTx"),
    sigma1DeltaInvAlpha4XjTx: combinedSigmaPayloadSection(sections, "sigma1DeltaInvAlpha4XjTx"),
    sigma1DeltaInvAlphakYiTy: combinedSigmaPayloadSection(sections, "sigma1DeltaInvAlphakYiTy"),
    g2: combinedSigmaPayloadSection(sections, "g2"),
  };
}

function pointDefinition(sectionSpec: RuntimeArtifactSectionSpec, data: Uint8Array): PointSectionDefinition {
  return {
    label: sectionSpec.label,
    data,
    expectedElementCount: sectionSpec.elementCount ?? undefined,
    elementByteLength: pointByteLength(sectionSpec),
    type: sectionSpec.type,
    encoding: sectionSpec.encoding,
  };
}

function pointByteLength(sectionSpec: RuntimeArtifactSectionSpec): number {
  if (sectionSpec.encoding === BinarySectionEncoding.FfjsG1Affine96) {
    return G1_AFFINE_BYTES;
  }
  if (sectionSpec.encoding === BinarySectionEncoding.FfjsG2Affine192) {
    return G2_AFFINE_BYTES;
  }
  throw new Error(`Combined-Sigma contract section '${sectionSpec.label}' must contain affine points.`);
}

function combinedSigmaDecodedSection(decoded: DecodedCombinedSigmaRkyv, index: number): Uint8Array {
  const section = combinedSigmaPayloadContract.sections[index];
  if (section === undefined) {
    throw new Error(`Combined-Sigma contract does not define section ${index}.`);
  }
  return decoded[section.decoderField as keyof DecodedCombinedSigmaRkyv];
}

function combinedSigmaPayloadSection(sections: readonly Uint8Array[], decoderField: string): Uint8Array {
  const section = combinedSigmaPayloadContract.sections.find(
    (candidate) => candidate.decoderField === decoderField,
  );
  if (section === undefined) {
    throw new Error(`Combined-Sigma contract does not define decoder field '${decoderField}'.`);
  }
  const data = sections[section.proverCrsSectionIndex];
  if (data === undefined) {
    throw new Error(`Combined-Sigma payload does not contain decoder field '${decoderField}'.`);
  }
  return data;
}

function requireConvertedDefinition(
  definitions: readonly PointSectionDefinition[],
  label: string,
): PointSectionDefinition {
  const definition = definitions.find((candidate) => candidate.label === label);
  if (definition === undefined) {
    throw new Error(`Combined-Sigma contract does not define CRS section '${label}'.`);
  }
  return definition;
}

function assertPointSectionShape(definition: PointSectionDefinition): void {
  if (definition.data.byteLength % definition.elementByteLength !== 0) {
    throw new Error(
      `${definition.label} byte length must be a multiple of ${definition.elementByteLength}.`,
    );
  }

  const elementCount = definition.data.byteLength / definition.elementByteLength;
  if (
    definition.expectedElementCount !== undefined
    && elementCount !== definition.expectedElementCount
  ) {
    throw new Error(
      `${definition.label} must contain exactly ${definition.expectedElementCount} points.`,
    );
  }
}

function readCombinedSigmaPayloadSections(payload: Uint8Array): readonly Uint8Array[] {
  const magicBytes = new TextEncoder().encode(combinedSigmaPayloadContract.magic);

  if (payload.byteLength < 12) {
    throw new Error("combined_sigma decoder payload is shorter than the fixed header.");
  }

  for (let index = 0; index < magicBytes.byteLength; index += 1) {
    if (payload[index] !== magicBytes[index]) {
      throw new Error("combined_sigma decoder payload magic mismatch.");
    }
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const sectionCount = view.getUint32(8, true);
  if (sectionCount !== combinedSigmaPayloadContract.sections.length) {
    throw new Error(`combined_sigma decoder payload must contain ${combinedSigmaPayloadContract.sections.length} sections.`);
  }

  const lengthsOffset = 12;
  const dataOffset = lengthsOffset + sectionCount * 4;
  if (payload.byteLength < dataOffset) {
    throw new Error("combined_sigma decoder payload is shorter than its section length table.");
  }

  const lengths: number[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    lengths.push(view.getUint32(lengthsOffset + index * 4, true));
  }

  const sections: Uint8Array[] = [];
  let offset = dataOffset;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (offset + length > payload.byteLength) {
      throw new Error(`combined_sigma decoder payload section ${index} exceeds the payload length.`);
    }
    sections.push(payload.subarray(offset, offset + length));
    offset += length;
  }

  if (offset !== payload.byteLength) {
    throw new Error("combined_sigma decoder payload contains trailing bytes.");
  }

  return sections;
}

function requireSourcePackageVersion(value: string): string {
  if (value.trim() !== value || value === "") {
    throw new Error("rkyv converter sourcePackageVersion must be a non-empty trimmed string.");
  }

  return value;
}
