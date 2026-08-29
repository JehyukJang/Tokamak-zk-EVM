import { createBinaryArtifactFile } from '../../artifacts/binary/binary-artifact-file.js';
import { VERIFIER_PROOF_V1_SPEC } from '../../generated/browser-artifact-contracts.generated.js';
import { concatBytes } from '../../runtime/bytes.js';
import type { ProverVerifierProofOutputInput } from '../protocol/proof-output.js';
export type { ProverVerifierProofOutputInput } from '../protocol/proof-output.js';
import { BACKEND_WASM_PACKAGE_VERSION } from '../../version.js';

export async function createVerifierProofArtifactFromProverOutput(
  input: ProverVerifierProofOutputInput,
): Promise<Uint8Array> {
  const { runtime, binding, initialRelation, recursion, copyQuotient, evaluations, openings } = input;
  const initialCommitments = initialRelation.commitments;
  const recursionCommitment = recursion.commitment;
  const copyCommitments = copyQuotient.commitments;
  const openingCommitments = openings.commitments;
  const [g1Section, evaluationsSection] = VERIFIER_PROOF_V1_SPEC.sections;
  const g1Points: Readonly<Record<string, Uint8Array>> = {
    'proof0.U': initialCommitments.U,
    'proof0.V': initialCommitments.V,
    'proof0.W': initialCommitments.W,
    'binding.O_mid': binding.O_mid,
    'binding.O_prv': binding.O_prv,
    'proof0.Q_AX': initialCommitments.Q_AX,
    'proof0.Q_AY': initialCommitments.Q_AY,
    'proof2.Q_CX': copyCommitments.Q_CX,
    'proof2.Q_CY': copyCommitments.Q_CY,
    'proof4.Pi_X': openingCommitments.Pi_X,
    'proof4.Pi_Y': openingCommitments.Pi_Y,
    'proof0.B': initialCommitments.B,
    'proof1.R': recursionCommitment.R,
    'proof4.M_Y': openingCommitments.M_Y,
    'proof4.M_X': openingCommitments.M_X,
    'proof4.N_Y': openingCommitments.N_Y,
    'proof4.N_X': openingCommitments.N_X,
    'binding.O_pub_free': binding.O_pub_free,
    'binding.A_free': binding.A_free,
  };
  const evaluationsByName: Readonly<Record<string, Uint8Array>> = {
    'proof3.R_eval': evaluations.R_eval,
    'proof3.R_omegaX_eval': evaluations.R_omegaX_eval,
    'proof3.R_omegaX_omegaY_eval': evaluations.R_omegaX_omegaY_eval,
    'proof3.V_eval': evaluations.V_eval,
  };

  return createBinaryArtifactFile({
    kind: VERIFIER_PROOF_V1_SPEC.kind,
    sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
    sections: [
      {
        ...g1Section,
        elementCount: g1Section.points.length,
        elementByteLength: runtime.G1.toAffine(runtime.G1.zero).byteLength,
        data: concatBytes(g1Section.points.map(point => runtime.G1.toAffine(requireNamedValue(g1Points, point.name)))),
      },
      {
        ...evaluationsSection,
        elementCount: evaluationsSection.points.length,
        elementByteLength: runtime.Fr.byteLength,
        data: concatBytes(evaluationsSection.points.map(point => requireNamedValue(evaluationsByName, point.name))),
      },
    ],
  });
}

function requireNamedValue(values: Readonly<Record<string, Uint8Array>>, name: string): Uint8Array {
  const value = values[name];
  if (value === undefined) {
    throw new Error(`Verifier proof contract references unknown value '${name}'.`);
  }
  return value;
}
