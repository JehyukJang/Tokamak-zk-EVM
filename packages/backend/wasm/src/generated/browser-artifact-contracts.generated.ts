// Generated from producer-owned browser artifact contracts. Do not edit.
import { BinarySectionEncoding, BinarySectionType } from "../artifacts/binary/binary-format.js";
import type { RuntimeArtifactFormatSpec } from "../artifacts/specs/types.js";

export const INSTANCE_V1_SPEC = {
  schemaVersion: 1,
  name: "instance",
  kind: 1,
  sections: [
    {
      label: "instance.public",
      type: BinarySectionType.Instance,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: null,
      elementByteLength: 32,
      points: [],
    },
    {
      label: "instance.function",
      type: BinarySectionType.Instance,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: null,
      elementByteLength: 32,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_PLACEMENT_VARIABLES_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_placement_variables",
  kind: 5,
  sections: [
    {
      label: "placement.subcircuit_ids",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 4,
      points: [],
    },
    {
      label: "placement.variable_offsets",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 4,
      points: [],
    },
    {
      label: "placement.variables",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: null,
      elementByteLength: 32,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_SELECTOR_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_selector",
  kind: 8,
  sections: [
    {
      label: "selector.entries",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 4,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_PERMUTATION_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_permutation",
  kind: 9,
  sections: [
    {
      label: "permutation.entries",
      type: BinarySectionType.Permutation,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 16,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC = {
  schemaVersion: 1,
  name: "univariate_verifier_preprocess",
  kind: 13,
  sections: [
    {
      label: "preprocess.g1",
      type: BinarySectionType.Preprocess,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 2,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "S_C"
  },
  {
    "index": 1,
    "name": "C_fix"
  }
],
    },
    {
      label: "preprocess.g2",
      type: BinarySectionType.Preprocess,
      encoding: BinarySectionEncoding.FfjsG2Affine192,
      elementCount: 1,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "E_kappa"
  }
],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const UNIVARIATE_PROOF_V1_SPEC = {
  schemaVersion: 1,
  name: "univariate_proof",
  kind: 14,
  sections: [
    {
      label: "proof.g1",
      type: BinarySectionType.Proof,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 10,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "C_L"
  },
  {
    "index": 1,
    "name": "C_H"
  },
  {
    "index": 2,
    "name": "C_O"
  },
  {
    "index": 3,
    "name": "D_Q"
  },
  {
    "index": 4,
    "name": "D_QK"
  },
  {
    "index": 5,
    "name": "C_D"
  },
  {
    "index": 6,
    "name": "C_R"
  },
  {
    "index": 7,
    "name": "C_Q"
  },
  {
    "index": 8,
    "name": "Pi_chi"
  },
  {
    "index": 9,
    "name": "Pi_plus"
  }
],
    },
    {
      label: "proof.evaluations",
      type: BinarySectionType.Proof,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: 7,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "s_C"
  },
  {
    "index": 1,
    "name": "u"
  },
  {
    "index": 2,
    "name": "v"
  },
  {
    "index": 3,
    "name": "w"
  },
  {
    "index": 4,
    "name": "b"
  },
  {
    "index": 5,
    "name": "r"
  },
  {
    "index": 6,
    "name": "r_plus"
  }
],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const RUNTIME_ARTIFACT_SPECS = [INSTANCE_V1_SPEC, PROVER_PLACEMENT_VARIABLES_V1_SPEC, PROVER_SELECTOR_V1_SPEC, PROVER_PERMUTATION_V1_SPEC, UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC, UNIVARIATE_PROOF_V1_SPEC] as const;

export function requireRuntimeArtifactSpecForKind(kind: number): RuntimeArtifactFormatSpec {
  const spec = RUNTIME_ARTIFACT_SPECS.find((candidate) => candidate.kind === kind);
  if (spec === undefined) {
    throw new Error(`Unsupported binary artifact kind: ${kind}.`);
  }
  return spec;
}
