import { createBinaryArtifactFile } from "../../artifacts/binary/binary-artifact-file.js";
import type { BinarySectionInput } from "../../artifacts/binary/binary-format.js";
import {
  UNIVARIATE_PREPROCESS_CRS_V1_SPEC,
  UNIVARIATE_PROVER_CRS_V1_SPEC,
  UNIVARIATE_VERIFIER_CRS_V1_SPEC,
} from "../../generated/browser-artifact-contracts.generated.js";
import { concatBytes } from "../../runtime/bytes.js";
import type { CurveRuntime } from "../../runtime/curve/curve.js";
import { G1_AFFINE_BYTES, type G1Point, type G2Point } from "../../runtime/group/group.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";
import { withCurveRuntime } from "./conversion-runtime.js";
import { isRecord, parseU32 } from "./conversion-utils.js";
import type { ConvertedCrs } from "./types.js";

const UNIVARIATE_CRS_SCHEMA_ID = "tokamak-zk-evm-univariate-v1";
const G2_AFFINE_BYTES = 192;

interface TaggedQuery {
  readonly placementIndex: number;
  readonly subcircuitId: number;
  readonly localWireIndex: number;
  readonly point: unknown;
}

interface PublicQuery {
  readonly bufferSubcircuitId: number;
  readonly localPublicWireIndex: number;
  readonly point: unknown;
}

interface UnivariateCrsJson {
  readonly schemaId: string;
  readonly degreeBound: number;
  readonly tauPowersG1: readonly unknown[];
  readonly oneG2: unknown;
  readonly tauG2: unknown;
  readonly alphaG2: readonly unknown[];
  readonly gammaG2: unknown;
  readonly etaG2: unknown;
  readonly deltaG2: unknown;
  readonly gammaInvPublicQueries: readonly PublicQuery[];
  readonly etaInvInterfaceQueries: readonly TaggedQuery[];
  readonly deltaInvInternalQueries: readonly TaggedQuery[];
  readonly deltaInvArithmeticMaskingQueries: readonly (readonly unknown[])[];
  readonly deltaInvConnectionMaskingQueries: readonly unknown[];
  readonly deltaG1: unknown;
  readonly etaG1: unknown;
}

/**
 * Converts the native U18--U21 JSON projection into the same three
 * role-specific browser artifacts used by the legacy CRS converter.  The
 * distinct artifact kinds prevent a bivariate Sigma from entering a new
 * protocol runtime path.
 */
export async function convertUnivariateCrs(crs: unknown): Promise<ConvertedCrs> {
  return withCurveRuntime(async (runtime) => {
    const parsed = parseUnivariateCrsJson(crs);
    const kzgPowers = parseG1Points(runtime, parsed.tauPowersG1, "tauPowersG1");
    if (kzgPowers.length !== parsed.degreeBound + 1) {
      throw new Error("univariate CRS KZG power count does not match degreeBound.");
    }

    const publicQueries = parseG1Points(
      runtime,
      parsed.gammaInvPublicQueries.map((query) => query.point),
      "gammaInvPublicQueries",
    );
    const interfaceQueries = parseG1Points(
      runtime,
      parsed.etaInvInterfaceQueries.map((query) => query.point),
      "etaInvInterfaceQueries",
    );
    const internalQueries = parseG1Points(
      runtime,
      parsed.deltaInvInternalQueries.map((query) => query.point),
      "deltaInvInternalQueries",
    );
    const arithmeticMasks = parsed.deltaInvArithmeticMaskingQueries.map((queries, index) =>
      parseG1Points(runtime, queries, `deltaInvArithmeticMaskingQueries[${index}]`),
    );
    const connectionMasks = parseG1Points(
      runtime,
      parsed.deltaInvConnectionMaskingQueries,
      "deltaInvConnectionMaskingQueries",
    );
    const bindingSources = parseG1Points(runtime, [parsed.deltaG1, parsed.etaG1], "binding sources");
    const verifierG2 = parseG2Points(runtime, [
      parsed.oneG2,
      parsed.tauG2,
      ...parsed.alphaG2,
      parsed.gammaG2,
      parsed.etaG2,
      parsed.deltaG2,
    ], "verifier G2 points");
    if (verifierG2.length !== 9) {
      throw new Error("univariate CRS must contain exactly four alpha G2 powers.");
    }

    const sourcePackageVersion = BACKEND_WASM_PACKAGE_VERSION;
    const preprocessCrs = await createBinaryArtifactFile({
      kind: UNIVARIATE_PREPROCESS_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: [pointSection(UNIVARIATE_PREPROCESS_CRS_V1_SPEC.sections[0], kzgPowers, G1_AFFINE_BYTES)],
    });
    const proverCrs = await createBinaryArtifactFile({
      kind: UNIVARIATE_PROVER_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: [
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[0], kzgPowers, G1_AFFINE_BYTES),
        metadataSection(
          UNIVARIATE_PROVER_CRS_V1_SPEC.sections[1],
          encodeTaggedQueryKeys(parsed.etaInvInterfaceQueries),
          parsed.etaInvInterfaceQueries.length,
          12,
        ),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[2], interfaceQueries, G1_AFFINE_BYTES),
        metadataSection(
          UNIVARIATE_PROVER_CRS_V1_SPEC.sections[3],
          encodeTaggedQueryKeys(parsed.deltaInvInternalQueries),
          parsed.deltaInvInternalQueries.length,
          12,
        ),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[4], internalQueries, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[5], arithmeticMasks[0], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[6], arithmeticMasks[1], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[7], arithmeticMasks[2], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[8], connectionMasks, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[9], bindingSources, G1_AFFINE_BYTES),
      ],
    });
    const verifierCrs = await createBinaryArtifactFile({
      kind: UNIVARIATE_VERIFIER_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: [
        pointSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[0], [kzgPowers[0]], G1_AFFINE_BYTES),
        metadataSection(
          UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[1],
          encodePublicQueryKeys(parsed.gammaInvPublicQueries),
          parsed.gammaInvPublicQueries.length,
          8,
        ),
        pointSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[2], publicQueries, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[3], verifierG2, G2_AFFINE_BYTES),
      ],
    });

    return { proverCrs, preprocessCrs, verifierCrs };
  });
}

function parseUnivariateCrsJson(raw: unknown): UnivariateCrsJson {
  if (!isRecord(raw)) {
    throw new Error("Univariate CRS JSON must be an object.");
  }
  if (raw.schemaId !== UNIVARIATE_CRS_SCHEMA_ID) {
    throw new Error("CRS does not use the supported univariate schema.");
  }
  const shape = requireRecord(raw.shape, "shape");
  const arithmeticMasks = requireArray(raw.deltaInvArithmeticMaskingQueries, "deltaInvArithmeticMaskingQueries");
  if (arithmeticMasks.length !== 3) {
    throw new Error("univariate CRS must contain exactly three arithmetic mask ranges.");
  }
  return {
    schemaId: UNIVARIATE_CRS_SCHEMA_ID,
    degreeBound: parseU32(shape.degreeBound, "shape.degreeBound"),
    tauPowersG1: requireArray(raw.tauPowersG1, "tauPowersG1"),
    oneG2: raw.oneG2,
    tauG2: raw.tauG2,
    alphaG2: requireArray(raw.alphaG2, "alphaG2"),
    gammaG2: raw.gammaG2,
    etaG2: raw.etaG2,
    deltaG2: raw.deltaG2,
    gammaInvPublicQueries: parsePublicQueries(raw.gammaInvPublicQueries),
    etaInvInterfaceQueries: parseTaggedQueries(raw.etaInvInterfaceQueries, "etaInvInterfaceQueries"),
    deltaInvInternalQueries: parseTaggedQueries(raw.deltaInvInternalQueries, "deltaInvInternalQueries"),
    deltaInvArithmeticMaskingQueries: arithmeticMasks.map((value, index) =>
      requireArray(value, `deltaInvArithmeticMaskingQueries[${index}]`),
    ),
    deltaInvConnectionMaskingQueries: requireArray(
      raw.deltaInvConnectionMaskingQueries,
      "deltaInvConnectionMaskingQueries",
    ),
    deltaG1: raw.deltaG1,
    etaG1: raw.etaG1,
  };
}

function parsePublicQueries(raw: unknown): readonly PublicQuery[] {
  return requireArray(raw, "gammaInvPublicQueries").map((value, index) => {
    const query = requireRecord(value, `gammaInvPublicQueries[${index}]`);
    return {
      bufferSubcircuitId: parseU32(query.bufferSubcircuitId, `gammaInvPublicQueries[${index}].bufferSubcircuitId`),
      localPublicWireIndex: parseU32(query.localPublicWireIndex, `gammaInvPublicQueries[${index}].localPublicWireIndex`),
      point: query.point,
    };
  });
}

function parseTaggedQueries(raw: unknown, label: string): readonly TaggedQuery[] {
  return requireArray(raw, label).map((value, index) => {
    const query = requireRecord(value, `${label}[${index}]`);
    return {
      placementIndex: parseU32(query.placementIndex, `${label}[${index}].placementIndex`),
      subcircuitId: parseU32(query.subcircuitId, `${label}[${index}].subcircuitId`),
      localWireIndex: parseU32(query.localWireIndex, `${label}[${index}].localWireIndex`),
      point: query.point,
    };
  });
}

function parseG1Points(runtime: CurveRuntime, values: readonly unknown[], label: string): readonly G1Point[] {
  return values.map((value, index) => runtime.G1.parseAffine(requireRecord(value, `${label}[${index}]`)));
}

function parseG2Points(runtime: CurveRuntime, values: readonly unknown[], label: string): readonly G2Point[] {
  return values.map((value, index) => runtime.G2.parseAffine(requireRecord(value, `${label}[${index}]`)));
}

function pointSection(
  spec: { readonly type: number; readonly encoding: number; readonly label: string },
  points: readonly Uint8Array[],
  elementByteLength: number,
): BinarySectionInput {
  return {
    type: spec.type,
    encoding: spec.encoding,
    label: spec.label,
    elementCount: points.length,
    elementByteLength,
    data: concatBytes(points),
  } as BinarySectionInput;
}

function metadataSection(
  spec: { readonly type: number; readonly encoding: number; readonly label: string },
  data: Uint8Array,
  elementCount: number,
  elementByteLength: number,
): BinarySectionInput {
  return {
    type: spec.type,
    encoding: spec.encoding,
    label: spec.label,
    elementCount,
    elementByteLength,
    data,
  } as BinarySectionInput;
}

function encodePublicQueryKeys(queries: readonly PublicQuery[]): Uint8Array {
  const output = new Uint8Array(queries.length * 8);
  const view = new DataView(output.buffer);
  for (const [index, query] of queries.entries()) {
    view.setUint32(index * 8, query.bufferSubcircuitId, true);
    view.setUint32(index * 8 + 4, query.localPublicWireIndex, true);
  }
  return output;
}

function encodeTaggedQueryKeys(queries: readonly TaggedQuery[]): Uint8Array {
  const output = new Uint8Array(queries.length * 12);
  const view = new DataView(output.buffer);
  for (const [index, query] of queries.entries()) {
    const offset = index * 12;
    view.setUint32(offset, query.placementIndex, true);
    view.setUint32(offset + 4, query.subcircuitId, true);
    view.setUint32(offset + 8, query.localWireIndex, true);
  }
  return output;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}
