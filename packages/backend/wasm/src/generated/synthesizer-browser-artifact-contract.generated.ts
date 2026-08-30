// Generated from packages/frontend/synthesizer/core/contracts/browser-artifact-contract.v1.json. Do not edit.
export const SYNTHESIZER_BROWSER_ARTIFACT_CONTRACT = {
  "contractVersion": 1,
  "owner": "synthesizer",
  "artifacts": [
    {
      "name": "instance",
      "sourceFile": "instance.json",
      "sourceFields": {
        "userPublic": "a_pub_user",
        "blockPublic": "a_pub_block",
        "functionPublic": "a_pub_function"
      },
      "sections": [
        {
          "label": "instance.public",
          "type": "Instance",
          "encoding": "ffjs-fr-montgomery-le-32",
          "elementCount": null,
          "elementByteLength": 32,
          "points": []
        },
        {
          "label": "instance.function",
          "type": "Instance",
          "encoding": "ffjs-fr-montgomery-le-32",
          "elementCount": null,
          "elementByteLength": 32,
          "points": []
        }
      ]
    },
    {
      "name": "prover_placement_variables",
      "sourceFile": "placementVariables.json",
      "sourceFields": {
        "subcircuitId": "subcircuitId",
        "variables": "variables"
      },
      "sections": [
        {
          "label": "placement.subcircuit_ids",
          "type": "Placement",
          "encoding": "bytes",
          "elementCount": null,
          "elementByteLength": 4,
          "points": []
        },
        {
          "label": "placement.variable_offsets",
          "type": "Placement",
          "encoding": "bytes",
          "elementCount": null,
          "elementByteLength": 4,
          "points": []
        },
        {
          "label": "placement.variables",
          "type": "Placement",
          "encoding": "ffjs-fr-montgomery-le-32",
          "elementCount": null,
          "elementByteLength": 32,
          "points": []
        }
      ]
    },
    {
      "name": "prover_permutation",
      "sourceFile": "permutation.json",
      "sourceFields": {
        "row": "row",
        "column": "col",
        "x": "X",
        "y": "Y"
      },
      "sections": [
        {
          "label": "permutation.entries",
          "type": "Permutation",
          "encoding": "bytes",
          "elementCount": null,
          "elementByteLength": 16,
          "points": []
        }
      ]
    }
  ]
} as const;

export default SYNTHESIZER_BROWSER_ARTIFACT_CONTRACT;
