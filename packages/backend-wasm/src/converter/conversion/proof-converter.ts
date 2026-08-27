import {
  createBinaryArtifactFile,
  decodeBinaryArtifactFile,
} from "../../artifacts/binary/binary-artifact-file.js";
import {
  BinaryArtifactFileKind,
  type BinaryArtifactFileView,
  type BinarySectionView,
} from "../../artifacts/binary/binary-format.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";
import { BACKEND_BROWSER_ARTIFACT_CONTRACT } from "../../generated/backend-browser-artifact-contract.generated.js";
import { VERIFIER_PROOF_V1_SPEC } from "../../generated/browser-artifact-contracts.generated.js";
import { concatBytes } from "../../runtime/bytes.js";
import type { CurveRuntime } from "../../runtime/curve/curve.js";
import { isRecord, parseHexStringArray } from "./conversion-utils.js";
import { withCurveRuntime } from "./conversion-runtime.js";
import { appendSplitG1Coordinate, recoverG1Points } from "./g1-coordinate-format.js";
import {
  requireProducerSourceField,
  requireProducerSourceFields,
} from "./producer-artifact-contract.js";
import type {
  ConverterArtifactJson,
  ConvertProofInput,
} from "./types.js";
import type { RuntimeArtifactSectionSpec } from "../../artifacts/specs/types.js";

interface FormattedProofJson {
  readonly proof_entries_part1: readonly string[];
  readonly proof_entries_part2: readonly string[];
}

const PROOF_ARTIFACT_NAME = "verifier_proof";
const proofSourceFields = requireProducerSourceFields(
  BACKEND_BROWSER_ARTIFACT_CONTRACT,
  PROOF_ARTIFACT_NAME,
);
const proofCoordinatesPart1Field = requireProducerSourceField(
  proofSourceFields,
  "coordinatesPart1",
  PROOF_ARTIFACT_NAME,
);
const proofCoordinatesAndEvaluationsPart2Field = requireProducerSourceField(
  proofSourceFields,
  "coordinatesAndEvaluationsPart2",
  PROOF_ARTIFACT_NAME,
);
const [proofG1SectionSpec, proofEvaluationsSectionSpec] = VERIFIER_PROOF_V1_SPEC.sections;

export async function convertProof(input: ConvertProofInput): Promise<Uint8Array | ConverterArtifactJson> {
  if (input.sourceFormat === "binary") {
    return convertProofBinaryToNativeJson(input.proof);
  }

  return withCurveRuntime((runtime) =>
    createVerifierProofArtifact(runtime, input.proof, BACKEND_WASM_PACKAGE_VERSION));
}

async function convertProofBinaryToNativeJson(proof: Uint8Array): Promise<ConverterArtifactJson> {
  const artifactFile = await decodeBinaryArtifactFile(proof);
  const proofG1 = requireBinarySection(artifactFile, BinaryArtifactFileKind.VerifierProof, proofG1SectionSpec);
  const proofEvals = requireBinarySection(artifactFile, BinaryArtifactFileKind.VerifierProof, proofEvaluationsSectionSpec);
  return withCurveRuntime(async (runtime) => {
    const proofEntriesPart1: string[] = [];
    const proofEntriesPart2: string[] = [];
    for (let index = 0; index < proofG1.elementCount; index += 1) {
      const point = proofG1.data.subarray(
        index * proofG1.elementByteLength,
        (index + 1) * proofG1.elementByteLength,
      );
      const affine = runtime.G1.formatAffine(point);
      appendSplitG1Coordinate(proofEntriesPart1, proofEntriesPart2, affine.x);
      appendSplitG1Coordinate(proofEntriesPart1, proofEntriesPart2, affine.y);
    }

    for (let index = 0; index < proofEvals.elementCount; index += 1) {
      proofEntriesPart2.push(runtime.Fr.toHex(
        proofEvals.data.subarray(
          index * proofEvals.elementByteLength,
          (index + 1) * proofEvals.elementByteLength,
        ),
      ));
    }

    return {
      proof_entries_part1: proofEntriesPart1,
      proof_entries_part2: proofEntriesPart2,
    };
  });
}

async function createVerifierProofArtifact(
  runtime: CurveRuntime,
  raw: unknown,
  sourcePackageVersion: string,
): Promise<Uint8Array> {
  const proof = parseFormattedProofJson(raw);
  const pointCount = requireFixedElementCount(proofG1SectionSpec);
  const scalarCount = requireFixedElementCount(proofEvaluationsSectionSpec);
  const points = recoverG1Points(runtime, proof.proof_entries_part1, proof.proof_entries_part2, pointCount);
  const scalarSlice = proof.proof_entries_part2.slice(pointCount * 2);

  if (scalarSlice.length !== scalarCount) {
    throw new Error(`Formatted proof must contain ${scalarCount} scalar evaluations.`);
  }

  return createBinaryArtifactFile({
    kind: VERIFIER_PROOF_V1_SPEC.kind,
    sourcePackageVersion,
    sections: [
      {
        ...proofG1SectionSpec,
        elementCount: pointCount,
        elementByteLength: runtime.G1.toAffine(points[0] ?? runtime.G1.zero).byteLength,
        data: concatBytes(points),
      },
      {
        ...proofEvaluationsSectionSpec,
        elementCount: scalarCount,
        elementByteLength: runtime.Fr.byteLength,
        data: concatBytes(scalarSlice.map((scalar) => runtime.Fr.fromHex(scalar))),
      },
    ],
  });
}

function parseFormattedProofJson(raw: unknown): FormattedProofJson {
  if (!isRecord(raw)) {
    throw new Error("Formatted proof JSON must be an object.");
  }

  return {
    proof_entries_part1: parseHexStringArray(
      raw[proofCoordinatesPart1Field],
      `proof.${proofCoordinatesPart1Field}`,
    ),
    proof_entries_part2: parseHexStringArray(
      raw[proofCoordinatesAndEvaluationsPart2Field],
      `proof.${proofCoordinatesAndEvaluationsPart2Field}`,
    ),
  };
}

function requireBinarySection(
  artifactFile: BinaryArtifactFileView,
  kind: BinaryArtifactFileKind,
  sectionSpec: RuntimeArtifactSectionSpec,
): BinarySectionView {
  if (artifactFile.kind !== kind) {
    throw new Error(`Binary artifact kind mismatch: expected ${kind}, got ${artifactFile.kind}.`);
  }

  const section = artifactFile.sections.find(
    (candidate) =>
      candidate.type === sectionSpec.type &&
      candidate.encoding === sectionSpec.encoding &&
      candidate.label === sectionSpec.label,
  );

  if (section === undefined) {
    throw new Error(`Missing binary artifact section '${sectionSpec.label}'.`);
  }

  if (
    section.elementCount !== requireFixedElementCount(sectionSpec)
    || section.elementByteLength !== sectionSpec.elementByteLength
  ) {
    throw new Error(`Binary artifact section '${sectionSpec.label}' shape mismatch.`);
  }

  return section;
}

function requireFixedElementCount(section: RuntimeArtifactSectionSpec): number {
  if (section.elementCount === null || section.elementByteLength === null) {
    throw new Error(`Backend contract must define a fixed shape for '${section.label}'.`);
  }
  return section.elementCount;
}
