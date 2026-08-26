// Generated from packages/backend/contracts/backend-build-metadata-contract.json.
const contract = {
  "fileNamePattern": "build-metadata-{backendPackageName}.json",
  "backendPackageNames": ["preprocess", "prove", "verify"],
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["dependencies", "packageName", "packageVersion", "compatibleBackendVersion"],
    "properties": {
      "dependencies": {
        "type": "object",
        "additionalProperties": false,
        "required": ["subcircuitLibrary"],
        "properties": {
          "subcircuitLibrary": {
            "type": "object",
            "additionalProperties": false,
            "required": ["buildVersion", "declaredRange", "packageName", "runtimeMode"],
            "properties": {
              "buildVersion": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
              "declaredRange": { "const": "latest" },
              "packageName": { "const": "@tokamak-zk-evm/subcircuit-library" },
              "runtimeMode": { "const": "bundled" }
            }
          }
        }
      },
      "packageName": { "enum": ["preprocess", "prove", "verify"] },
      "packageVersion": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
      "compatibleBackendVersion": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" }
    }
  }
} as const;

export default contract;
