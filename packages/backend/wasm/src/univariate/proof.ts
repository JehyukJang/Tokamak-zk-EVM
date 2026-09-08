import { createBinaryArtifactFile, requireBinaryArtifactSection } from "../artifacts/binary/binary-artifact-file.js";
import type { BinaryArtifactFileView } from "../artifacts/binary/binary-format.js";
import { admitRuntimeBinaryArtifact } from "../artifacts/binary/runtime-admission.js";
import { UNIVARIATE_PROOF_V1_SPEC } from "../generated/browser-artifact-contracts.generated.js";
import type { CurveRuntime } from "../runtime/curve/curve.js";
import type { FieldElement } from "../runtime/field/field-types.js";
import type { G1Point } from "../runtime/group/group.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../version.js";

/** F5's exact public proof object: eleven affine G1 values and nine scalars. */
export interface UnivariateProof {
  readonly g1: readonly [
    G1Point, G1Point, G1Point, G1Point, G1Point, G1Point,
    G1Point, G1Point, G1Point, G1Point, G1Point,
  ];
  readonly evaluations: readonly [
    FieldElement, FieldElement, FieldElement, FieldElement, FieldElement,
    FieldElement, FieldElement, FieldElement, FieldElement,
  ];
}

export async function encodeUnivariateProof(runtime: CurveRuntime, proof: UnivariateProof): Promise<Uint8Array> {
  const [g1Section, evaluationSection] = UNIVARIATE_PROOF_V1_SPEC.sections;
  const g1 = proof.g1.map(point => runtime.G1.toAffine(point));
  const evaluations = runtime.Fr.concat(proof.evaluations);
  return createBinaryArtifactFile({
    kind: UNIVARIATE_PROOF_V1_SPEC.kind,
    sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
    sections: [
      {
        ...g1Section,
        elementCount: g1.length,
        elementByteLength: g1[0]!.byteLength,
        data: concat(g1),
      },
      {
        ...evaluationSection,
        elementCount: proof.evaluations.length,
        elementByteLength: runtime.Fr.byteLength,
        data: evaluations,
      },
    ],
  });
}

export function decodeUnivariateProof(runtime: CurveRuntime, bytes: Uint8Array): UnivariateProof {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    UNIVARIATE_PROOF_V1_SPEC.kind,
    UNIVARIATE_PROOF_V1_SPEC,
  );
  return decodeUnivariateProofArtifact(runtime, artifact);
}

export function decodeUnivariateProofArtifact(
  runtime: CurveRuntime,
  artifact: BinaryArtifactFileView,
): UnivariateProof {
  const [g1Spec, evaluationSpec] = UNIVARIATE_PROOF_V1_SPEC.sections;
  const g1Section = requireBinaryArtifactSection(artifact, g1Spec);
  const evaluationSection = requireBinaryArtifactSection(artifact, evaluationSpec);
  const g1 = Array.from({ length: 11 }, (_, index) =>
    runtime.G1.toAffine(g1Section.data.subarray(index * g1Section.elementByteLength, (index + 1) * g1Section.elementByteLength)),
  );
  const evaluations = runtime.Fr.split(evaluationSection.data);
  return {
    g1: tuple11(g1),
    evaluations: tuple9(evaluations),
  };
}

function concat(points: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(points.reduce((length, point) => length + point.byteLength, 0));
  let offset = 0;
  for (const point of points) {
    result.set(point, offset);
    offset += point.byteLength;
  }
  return result;
}

function tuple11<T>(values: readonly T[]): [T, T, T, T, T, T, T, T, T, T, T] {
  if (values.length !== 11) throw new Error("F5 proof must contain exactly eleven G1 values.");
  return values as [T, T, T, T, T, T, T, T, T, T, T];
}

function tuple9<T>(values: readonly T[]): [T, T, T, T, T, T, T, T, T] {
  if (values.length !== 9) throw new Error("F5 proof must contain exactly nine scalar values.");
  return values as [T, T, T, T, T, T, T, T, T];
}
