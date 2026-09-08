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

const UNIVARIATE_CRS_SCHEMA_ID = "tokamak-zk-evm-univariate";
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
  readonly declaredCapacity: readonly number[];
  readonly k: number;
  readonly s0G1: readonly unknown[];
  readonly sxiG1: readonly unknown[];
  readonly spsiG1: readonly unknown[];
  readonly oneG2: unknown;
  readonly tauG2: unknown;
  readonly tauKG2: unknown;
  readonly gammaG2: unknown;
  readonly etaG2: unknown;
  readonly deltaG2: unknown;
  readonly gammaInvPublicQueries: readonly PublicQuery[];
  readonly etaInvInterfaceQueries: readonly TaggedQuery[];
  readonly deltaInvInternalQueries: readonly TaggedQuery[];
  readonly deltaInvUMaskingQueries: readonly unknown[];
  readonly deltaInvVMaskingQueries: readonly unknown[];
  readonly deltaInvWMaskingQueries: readonly unknown[];
  readonly deltaInvBMaskingQueries: readonly unknown[];
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
    const s0 = parseG1Points(runtime, parsed.s0G1, "s0G1");
    const sxi = parseG1Points(runtime, parsed.sxiG1, "sxiG1");
    const spsi = parseG1Points(runtime, parsed.spsiG1, "spsiG1");
    for (const [name, sequence, capacity] of [
      ["S0", s0, parsed.declaredCapacity[0]],
      ["Sxi", sxi, parsed.declaredCapacity[1]],
      ["Spsi", spsi, parsed.declaredCapacity[2]],
    ] as const) {
      if (sequence.length !== capacity + 1) {
        throw new Error(`${name} power count does not match declared CRS capacity.`);
      }
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
    const masks = [
      parseG1Points(runtime, parsed.deltaInvUMaskingQueries, "deltaInvUMaskingQueries"),
      parseG1Points(runtime, parsed.deltaInvVMaskingQueries, "deltaInvVMaskingQueries"),
      parseG1Points(runtime, parsed.deltaInvWMaskingQueries, "deltaInvWMaskingQueries"),
      parseG1Points(runtime, parsed.deltaInvBMaskingQueries, "deltaInvBMaskingQueries"),
    ] as const;
    if (masks.some((mask) => mask.length !== 2)) {
      throw new Error("univariate CRS must contain exactly two U22 mask points per polynomial.");
    }
    const bindingSources = parseG1Points(runtime, [parsed.deltaG1, parsed.etaG1], "binding sources");
    const verifierG2 = parseG2Points(runtime, [
      parsed.oneG2,
      parsed.tauG2,
      parsed.tauKG2,
      parsed.gammaG2,
      parsed.etaG2,
      parsed.deltaG2,
    ], "verifier G2 points");
    if (verifierG2.length !== 6) {
      throw new Error("univariate CRS must contain exactly six U18 verifier G2 points.");
    }

    const sourcePackageVersion = BACKEND_WASM_PACKAGE_VERSION;
    const preprocessCrs = await createBinaryArtifactFile({
      kind: UNIVARIATE_PREPROCESS_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: [pointSection(UNIVARIATE_PREPROCESS_CRS_V1_SPEC.sections[0], s0, G1_AFFINE_BYTES)],
    });
    const proverCrs = await createBinaryArtifactFile({
      kind: UNIVARIATE_PROVER_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: [
        metadataSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[0], encodeCapacity(parsed), 4, 8),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[1], s0, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[2], sxi, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[3], spsi, G1_AFFINE_BYTES),
        metadataSection(
          UNIVARIATE_PROVER_CRS_V1_SPEC.sections[4],
          encodeTaggedQueryKeys(parsed.etaInvInterfaceQueries),
          parsed.etaInvInterfaceQueries.length,
          12,
        ),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[5], interfaceQueries, G1_AFFINE_BYTES),
        metadataSection(
          UNIVARIATE_PROVER_CRS_V1_SPEC.sections[6],
          encodeTaggedQueryKeys(parsed.deltaInvInternalQueries),
          parsed.deltaInvInternalQueries.length,
          12,
        ),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[7], internalQueries, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[8], masks[0], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[9], masks[1], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[10], masks[2], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[11], masks[3], G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_PROVER_CRS_V1_SPEC.sections[12], bindingSources, G1_AFFINE_BYTES),
      ],
    });
    const verifierCrs = await createBinaryArtifactFile({
      kind: UNIVARIATE_VERIFIER_CRS_V1_SPEC.kind,
      sourcePackageVersion,
      sections: [
        metadataSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[0], encodeCapacity(parsed), 4, 8),
        pointSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[1], [s0[0], sxi[0], spsi[0]], G1_AFFINE_BYTES),
        metadataSection(
          UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[2],
          encodePublicQueryKeys(parsed.gammaInvPublicQueries),
          parsed.gammaInvPublicQueries.length,
          8,
        ),
        pointSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[3], publicQueries, G1_AFFINE_BYTES),
        pointSection(UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections[4], verifierG2, G2_AFFINE_BYTES),
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
  const declaredCapacity = requireArray(shape.declaredCapacity, "shape.declaredCapacity").map((value, index) =>
    parseU32(value, `shape.declaredCapacity[${index}]`),
  );
  if (declaredCapacity.length !== 3) {
    throw new Error("univariate CRS declaredCapacity must contain exactly M0, Mxi, and Mpsi.");
  }
  return {
    schemaId: UNIVARIATE_CRS_SCHEMA_ID,
    declaredCapacity,
    k: parseU32(shape.k, "shape.k"),
    s0G1: requireArray(raw.s0G1, "s0G1"),
    sxiG1: requireArray(raw.sxiG1, "sxiG1"),
    spsiG1: requireArray(raw.spsiG1, "spsiG1"),
    oneG2: raw.oneG2,
    tauG2: raw.tauG2,
    tauKG2: raw.tauKG2,
    gammaG2: raw.gammaG2,
    etaG2: raw.etaG2,
    deltaG2: raw.deltaG2,
    gammaInvPublicQueries: parsePublicQueries(raw.gammaInvPublicQueries),
    etaInvInterfaceQueries: parseTaggedQueries(raw.etaInvInterfaceQueries, "etaInvInterfaceQueries"),
    deltaInvInternalQueries: parseTaggedQueries(raw.deltaInvInternalQueries, "deltaInvInternalQueries"),
    deltaInvUMaskingQueries: requireArray(raw.deltaInvUMaskingQueries, "deltaInvUMaskingQueries"),
    deltaInvVMaskingQueries: requireArray(raw.deltaInvVMaskingQueries, "deltaInvVMaskingQueries"),
    deltaInvWMaskingQueries: requireArray(raw.deltaInvWMaskingQueries, "deltaInvWMaskingQueries"),
    deltaInvBMaskingQueries: requireArray(raw.deltaInvBMaskingQueries, "deltaInvBMaskingQueries"),
    deltaG1: raw.deltaG1,
    etaG1: raw.etaG1,
  };
}

function encodeCapacity(crs: UnivariateCrsJson): Uint8Array {
  const output = new Uint8Array(32);
  const view = new DataView(output.buffer);
  for (const [index, value] of [...crs.declaredCapacity, crs.k].entries()) {
    view.setBigUint64(index * 8, BigInt(value), true);
  }
  return output;
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
