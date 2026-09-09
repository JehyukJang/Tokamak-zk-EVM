// Generated from packages/backend/common/contracts/browser-artifact-contract.v1.json. Do not edit.
export const BACKEND_BROWSER_ARTIFACT_CONTRACT = {
  "contractVersion": 1,
  "owner": "backend",
  "artifactKinds": {
    "instance": 1,
    "prover_placement_variables": 5,
    "prover_selector": 8,
    "prover_permutation": 9,
    "univariate_verifier_preprocess": 13,
    "univariate_proof": 14
  },
  "artifacts": [
    {
      "name": "univariate_verifier_preprocess",
      "sections": [
        {
          "label": "preprocess.g1",
          "type": "Preprocess",
          "encoding": "ffjs-g1-affine-96",
          "elementCount": 2,
          "elementByteLength": null,
          "points": [
            {
              "index": 0,
              "name": "S_kappa"
            },
            {
              "index": 1,
              "name": "S_C"
            }
          ]
        }
      ]
    },
    {
      "name": "univariate_proof",
      "sections": [
        {
          "label": "proof.g1",
          "type": "Proof",
          "encoding": "ffjs-g1-affine-96",
          "elementCount": 11,
          "elementByteLength": null,
          "points": [
            {
              "index": 0,
              "name": "C_U"
            },
            {
              "index": 1,
              "name": "C_V"
            },
            {
              "index": 2,
              "name": "C_W"
            },
            {
              "index": 3,
              "name": "C_B"
            },
            {
              "index": 4,
              "name": "O_if"
            },
            {
              "index": 5,
              "name": "O_int"
            },
            {
              "index": 6,
              "name": "C_D"
            },
            {
              "index": 7,
              "name": "C_R"
            },
            {
              "index": 8,
              "name": "C_Q"
            },
            {
              "index": 9,
              "name": "Pi_zeta"
            },
            {
              "index": 10,
              "name": "Pi_plus"
            }
          ]
        },
        {
          "label": "proof.evaluations",
          "type": "Proof",
          "encoding": "ffjs-fr-montgomery-le-32",
          "elementCount": 9,
          "elementByteLength": null,
          "points": [
            {
              "index": 0,
              "name": "s_A"
            },
            {
              "index": 1,
              "name": "s_C"
            },
            {
              "index": 2,
              "name": "u"
            },
            {
              "index": 3,
              "name": "v"
            },
            {
              "index": 4,
              "name": "w"
            },
            {
              "index": 5,
              "name": "b"
            },
            {
              "index": 6,
              "name": "q_zeta"
            },
            {
              "index": 7,
              "name": "r"
            },
            {
              "index": 8,
              "name": "r_plus"
            }
          ]
        }
      ]
    }
  ]
} as const;

export default BACKEND_BROWSER_ARTIFACT_CONTRACT;
