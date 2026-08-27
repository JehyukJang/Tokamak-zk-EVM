// Generated from producer-owned browser artifact contracts. Do not edit.
import { BinarySectionEncoding, BinarySectionType } from "../artifacts/binary/binary-format.js";
import type { RuntimeArtifactFormatSpec } from "../artifacts/specs/types.js";

export const INSTANCE_V1_SPEC = {
  schemaVersion: 1,
  name: "instance",
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

export const PROVER_PERMUTATION_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_permutation",
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

export const SIGMA_VERIFY_V1_SPEC = {
  schemaVersion: 1,
  name: "sigma_verify",
  sections: [
    {
      label: "sigma.g1",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 4,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "G"
  },
  {
    "index": 1,
    "name": "sigma1.x"
  },
  {
    "index": 2,
    "name": "sigma1.y"
  },
  {
    "index": 3,
    "name": "lagrangeKL"
  }
],
    },
    {
      label: "sigma.g2",
      type: BinarySectionType.CrsG2,
      encoding: BinarySectionEncoding.FfjsG2Affine192,
      elementCount: 10,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "H"
  },
  {
    "index": 1,
    "name": "sigma2.alpha"
  },
  {
    "index": 2,
    "name": "sigma2.alpha2"
  },
  {
    "index": 3,
    "name": "sigma2.alpha3"
  },
  {
    "index": 4,
    "name": "sigma2.alpha4"
  },
  {
    "index": 5,
    "name": "sigma2.gamma"
  },
  {
    "index": 6,
    "name": "sigma2.delta"
  },
  {
    "index": 7,
    "name": "sigma2.eta"
  },
  {
    "index": 8,
    "name": "sigma2.x"
  },
  {
    "index": 9,
    "name": "sigma2.y"
  }
],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const VERIFIER_PREPROCESS_V1_SPEC = {
  schemaVersion: 1,
  name: "verifier_preprocess",
  sections: [
    {
      label: "preprocess.g1",
      type: BinarySectionType.Preprocess,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 3,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "s0"
  },
  {
    "index": 1,
    "name": "s1"
  },
  {
    "index": 2,
    "name": "O_pub_fix"
  }
],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const VERIFIER_PROOF_V1_SPEC = {
  schemaVersion: 1,
  name: "verifier_proof",
  sections: [
    {
      label: "proof.g1",
      type: BinarySectionType.Proof,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 19,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "proof0.U"
  },
  {
    "index": 1,
    "name": "proof0.V"
  },
  {
    "index": 2,
    "name": "proof0.W"
  },
  {
    "index": 3,
    "name": "binding.O_mid"
  },
  {
    "index": 4,
    "name": "binding.O_prv"
  },
  {
    "index": 5,
    "name": "proof0.Q_AX"
  },
  {
    "index": 6,
    "name": "proof0.Q_AY"
  },
  {
    "index": 7,
    "name": "proof2.Q_CX"
  },
  {
    "index": 8,
    "name": "proof2.Q_CY"
  },
  {
    "index": 9,
    "name": "proof4.Pi_X"
  },
  {
    "index": 10,
    "name": "proof4.Pi_Y"
  },
  {
    "index": 11,
    "name": "proof0.B"
  },
  {
    "index": 12,
    "name": "proof1.R"
  },
  {
    "index": 13,
    "name": "proof4.M_Y"
  },
  {
    "index": 14,
    "name": "proof4.M_X"
  },
  {
    "index": 15,
    "name": "proof4.N_Y"
  },
  {
    "index": 16,
    "name": "proof4.N_X"
  },
  {
    "index": 17,
    "name": "binding.O_pub_free"
  },
  {
    "index": 18,
    "name": "binding.A_free"
  }
],
    },
    {
      label: "proof.evals",
      type: BinarySectionType.Proof,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: 4,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "proof3.R_eval"
  },
  {
    "index": 1,
    "name": "proof3.R_omegaX_eval"
  },
  {
    "index": 2,
    "name": "proof3.R_omegaX_omegaY_eval"
  },
  {
    "index": 3,
    "name": "proof3.V_eval"
  }
],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_CRS_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_crs",
  sections: [
    {
      label: "sigma.g1",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 6,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "G"
  },
  {
    "index": 1,
    "name": "sigma1.x"
  },
  {
    "index": 2,
    "name": "sigma1.y"
  },
  {
    "index": 3,
    "name": "sigma1.delta"
  },
  {
    "index": 4,
    "name": "sigma1.eta"
  },
  {
    "index": 5,
    "name": "lagrangeKL"
  }
],
    },
    {
      label: "sigma1.xy-powers",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: null,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.gamma-inv-o-inst",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: null,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.eta-inv-li-o-inter-alpha4-kj",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: null,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.delta-inv-li-o-prv",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: null,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.delta-inv-alphak-xh-tx",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 9,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.delta-inv-alpha4-xj-tx",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 2,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.delta-inv-alphak-yi-ty",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: 12,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma.g2",
      type: BinarySectionType.CrsG2,
      encoding: BinarySectionEncoding.FfjsG2Affine192,
      elementCount: 10,
      elementByteLength: null,
      points: [
  {
    "index": 0,
    "name": "H"
  },
  {
    "index": 1,
    "name": "sigma2.alpha"
  },
  {
    "index": 2,
    "name": "sigma2.alpha2"
  },
  {
    "index": 3,
    "name": "sigma2.alpha3"
  },
  {
    "index": 4,
    "name": "sigma2.alpha4"
  },
  {
    "index": 5,
    "name": "sigma2.gamma"
  },
  {
    "index": 6,
    "name": "sigma2.delta"
  },
  {
    "index": 7,
    "name": "sigma2.eta"
  },
  {
    "index": 8,
    "name": "sigma2.x"
  },
  {
    "index": 9,
    "name": "sigma2.y"
  }
],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PREPROCESS_CRS_V1_SPEC = {
  schemaVersion: 1,
  name: "preprocess_crs",
  sections: [
    {
      label: "sigma1.xy-powers",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: null,
      elementByteLength: null,
      points: [],
    },
    {
      label: "sigma1.gamma-inv-o-inst",
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      elementCount: null,
      elementByteLength: null,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;
