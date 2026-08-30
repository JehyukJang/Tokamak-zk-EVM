import { createBinaryArtifactFile } from "../../artifacts/binary/binary-artifact-file.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";
import { BACKEND_BROWSER_ARTIFACT_CONTRACT } from "../../generated/backend-browser-artifact-contract.generated.js";
import { VERIFIER_PREPROCESS_V1_SPEC } from "../../generated/browser-artifact-contracts.generated.js";
import { concatBytes } from "../../runtime/bytes.js";
import type { CurveRuntime } from "../../runtime/curve/curve.js";
import { isRecord, parseHexStringArray } from "./conversion-utils.js";
import { withCurveRuntime } from "./conversion-runtime.js";
import { recoverG1Points } from "./g1-coordinate-format.js";
import {
  requireProducerSourceField,
  requireProducerSourceFields,
} from "./producer-artifact-contract.js";

interface FormattedPreprocessJson {
  readonly preprocess_entries_part1: readonly string[];
  readonly preprocess_entries_part2: readonly string[];
}

const PREPROCESS_ARTIFACT_NAME = "verifier_preprocess";
const preprocessSourceFields = requireProducerSourceFields(
  BACKEND_BROWSER_ARTIFACT_CONTRACT,
  PREPROCESS_ARTIFACT_NAME,
);
const preprocessCoordinatesPart1Field = requireProducerSourceField(
  preprocessSourceFields,
  "coordinatesPart1",
  PREPROCESS_ARTIFACT_NAME,
);
const preprocessCoordinatesPart2Field = requireProducerSourceField(
  preprocessSourceFields,
  "coordinatesPart2",
  PREPROCESS_ARTIFACT_NAME,
);
const [preprocessSectionSpec] = VERIFIER_PREPROCESS_V1_SPEC.sections;

export async function convertVerifierPreprocess(preprocess: unknown): Promise<Uint8Array> {
  return withCurveRuntime((runtime) =>
    createVerifierPreprocessArtifact(runtime, preprocess, BACKEND_WASM_PACKAGE_VERSION));
}

async function createVerifierPreprocessArtifact(
  runtime: CurveRuntime,
  raw: unknown,
  sourcePackageVersion: string,
): Promise<Uint8Array> {
  const preprocess = parseFormattedPreprocessJson(raw);
  const pointCount = requireFixedElementCount(preprocessSectionSpec);
  const points = recoverG1Points(
    runtime,
    preprocess.preprocess_entries_part1,
    preprocess.preprocess_entries_part2,
    pointCount,
  );

  return createBinaryArtifactFile({
    kind: VERIFIER_PREPROCESS_V1_SPEC.kind,
    sourcePackageVersion,
    sections: [
      {
        ...preprocessSectionSpec,
        elementCount: pointCount,
        elementByteLength: runtime.G1.toAffine(points[0] ?? runtime.G1.zero).byteLength,
        data: concatBytes(points),
      },
    ],
  });
}

function requireFixedElementCount(section: typeof preprocessSectionSpec): number {
  if (section.elementCount === null) {
    throw new Error(`Backend contract must define a fixed point count for '${section.label}'.`);
  }
  return section.elementCount;
}

function parseFormattedPreprocessJson(raw: unknown): FormattedPreprocessJson {
  if (!isRecord(raw)) {
    throw new Error("Formatted preprocess JSON must be an object.");
  }

  return {
    preprocess_entries_part1: parseHexStringArray(
      raw[preprocessCoordinatesPart1Field],
      `preprocess.${preprocessCoordinatesPart1Field}`,
    ),
    preprocess_entries_part2: parseHexStringArray(
      raw[preprocessCoordinatesPart2Field],
      `preprocess.${preprocessCoordinatesPart2Field}`,
    ),
  };
}
