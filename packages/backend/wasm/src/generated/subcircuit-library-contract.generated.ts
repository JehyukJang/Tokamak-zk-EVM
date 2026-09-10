// Generated from packages/frontend/qap-compiler/contracts/subcircuit-library-contract.v1.json.
export const SUBCIRCUIT_LIBRARY_CONTRACT = {
  "contractVersion": 1,
  "owner": "qap-compiler",
  "libraryArtifacts": {
    "setupParams": {
      "fileName": "setupParams.json",
      "fields": {
        "freePublicLength": "l_free",
        "publicLength": "l",
        "userOutputLength": "l_user_out",
        "userLength": "l_user",
        "domainPublicLength": "l_D",
        "domainWireLength": "m_D",
        "constraintCount": "n",
        "localWireCapacity": "m",
        "subcircuitCapacity": "t",
        "subcircuitCount": "s_D",
        "placementCapacity": "s_max"
      },
      "requiredFields": [
        "l_free",
        "l",
        "l_user_out",
        "l_user",
        "l_D",
        "m_D",
        "n",
        "m",
        "t",
        "s_D",
        "s_max"
      ],
      "derivedDimensions": {
        "functionInstance": "l - l_free",
        "intermediateRows": "l_D - l",
        "preprocessXyPowers": "(l_D - l) * s_max",
        "localWireCapacity": "ceilPowerOfTwo(max(Nwires))",
        "subcircuitCapacity": "ceilPowerOfTwo(s_D + 1)",
        "emptySubcircuitId": "t - 1",
        "domainWireLength": "m * s_D"
      },
      "subcircuitIds": {
        "compiled": "[0,s_D)",
        "unselectable": "[s_D,t-1)",
        "virtualEmpty": "t-1",
        "virtualEmptyArtifacts": "none"
      }
    },
    "subcircuitInfo": {
      "fileName": "subcircuitInfo.json",
      "fields": {
        "id": "id",
        "name": "name",
        "wireCount": "Nwires",
        "constraintCount": "Nconsts",
        "outputRange": "Out_idx",
        "inputRange": "In_idx",
        "globalWireMap": "flattenMap",
        "bufferDirection": "bufferDirection"
      },
      "requiredFields": [
        "id",
        "name",
        "Nwires",
        "Nconsts",
        "Out_idx",
        "In_idx",
        "flattenMap"
      ],
      "optionalFields": [
        "bufferDirection"
      ]
    },
    "r1cs": {
      "directoryName": "r1cs",
      "fileNamePattern": "subcircuit{id}.r1cs",
      "transport": {
        "format": "circom-r1cs",
        "magic": "r1cs",
        "version": 1,
        "endianness": "little",
        "sections": {
          "header": 1,
          "constraints": 2
        }
      }
    }
  }
} as const;

export default SUBCIRCUIT_LIBRARY_CONTRACT;
