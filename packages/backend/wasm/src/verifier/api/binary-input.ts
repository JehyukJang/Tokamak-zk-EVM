import { requireBinaryArtifactSection } from "../../artifacts/binary/binary-artifact-file.js";
import { assertBinaryArtifactCompatibility } from "../../artifacts/binary/compatibility.js";
import { admitRuntimeBinaryArtifact } from "../../artifacts/binary/runtime-admission.js";
import {
  INSTANCE_V1_SPEC,
  UNIVARIATE_VERIFIER_CRS_V1_SPEC,
  UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC,
} from "../../generated/browser-artifact-contracts.generated.js";
import { GENERATED_SETUP_PARAMS } from "../../generated/active/setup.generated.js";
import type { CurveRuntime } from "../../runtime/curve/curve.js";
import type { FieldElement } from "../../runtime/field/field-types.js";
import { loadPreprocessInputFromBinaryInput } from "../../preprocess/api/binary-input.js";
import { preprocessSnark } from "../../preprocess/protocol/preprocess-snark.js";
import { parseUnivariateVerifierCrs } from "../../univariate/crs.js";
import { decodeUnivariateProof } from "../../univariate/proof.js";
import {
  GENERATED_PROVER_SUBCIRCUIT_INFOS,
} from "../../prover/generated/active/subcircuit-library.generated.js";
import type { UnivariateReferenceVerifierInput } from "../../univariate/reference-verifier.js";

export interface VerifierBinaryInput {
  readonly proof: Uint8Array;
  readonly instance: Uint8Array;
  readonly selector: Uint8Array;
  readonly permutation: Uint8Array;
  readonly preprocessCrs: Uint8Array;
  readonly verifierPreprocess: Uint8Array;
  readonly verifierCrs: Uint8Array;
}

export async function loadVerifierInputFromBinaryInput(
  runtime: CurveRuntime,
  input: VerifierBinaryInput,
): Promise<UnivariateReferenceVerifierInput> {
  const [instance, preprocess, verifierCrs] = await Promise.all([
    admitRuntimeBinaryArtifact(input.instance, INSTANCE_V1_SPEC.kind, INSTANCE_V1_SPEC),
    admitRuntimeBinaryArtifact(
      input.verifierPreprocess,
      UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC.kind,
      UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC,
    ),
    admitRuntimeBinaryArtifact(input.verifierCrs, UNIVARIATE_VERIFIER_CRS_V1_SPEC.kind, UNIVARIATE_VERIFIER_CRS_V1_SPEC),
  ]);
  for (const artifact of [instance, preprocess, verifierCrs]) assertBinaryArtifactCompatibility(artifact);
  const preprocessInput = await loadPreprocessInputFromBinaryInput({
    selector: input.selector,
    permutation: input.permutation,
    preprocessCrs: input.preprocessCrs,
  });
  const expected = await preprocessSnark(runtime, preprocessInput);
  const commitments = parsePreprocess(runtime, preprocess);
  if (!runtime.G1.eq(expected.sKappa, commitments[0]) || !runtime.G1.eq(expected.sC, commitments[1])) {
    throw new Error("Verifier preprocess does not match the admitted selector and permutation.");
  }
  return {
    setup: GENERATED_SETUP_PARAMS,
    subcircuitInfos: GENERATED_PROVER_SUBCIRCUIT_INFOS,
    selector: preprocessInput.selector,
    publicInputs: parsePublicInputs(runtime, instance),
    crs: parseUnivariateVerifierCrs(input.verifierCrs),
    preprocess: commitments,
    proof: decodeUnivariateProof(runtime, input.proof),
  };
}

function parsePreprocess(
  runtime: CurveRuntime,
  artifact: ReturnType<typeof admitRuntimeBinaryArtifact>,
): readonly [Uint8Array, Uint8Array] {
  const [spec] = UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC.sections;
  const section = requireBinaryArtifactSection(artifact, spec);
  return [
    runtime.G1.toAffine(section.data.subarray(0, section.elementByteLength)),
    runtime.G1.toAffine(section.data.subarray(section.elementByteLength, 2 * section.elementByteLength)),
  ];
}

function parsePublicInputs(
  runtime: CurveRuntime,
  artifact: ReturnType<typeof admitRuntimeBinaryArtifact>,
): readonly FieldElement[] {
  const [publicSpec, functionSpec] = INSTANCE_V1_SPEC.sections;
  const values = [
    ...runtime.Fr.split(requireBinaryArtifactSection(artifact, publicSpec).data),
    ...runtime.Fr.split(requireBinaryArtifactSection(artifact, functionSpec).data),
  ];
  if (values.length !== GENERATED_SETUP_PARAMS.l) throw new Error("Public instance does not match the active setup.");
  return values;
}
