import fs from "node:fs/promises";
import path from "node:path";

const backendRoot = path.resolve(import.meta.dirname, "..");
const contractRoot = path.join(backendRoot, "contracts");
const repositoryRoot = path.resolve(backendRoot, "..", "..");
const validatorSource = path.join(contractRoot, "typescript", "crs-provenance-validator.ts");
const buildMetadataValidatorSource = path.join(contractRoot, "typescript", "backend-build-metadata-validator.ts");
const provenanceContract = path.join(contractRoot, "crs-provenance-contract.json");
const buildMetadataContract = path.join(contractRoot, "backend-build-metadata-contract.json");
const versionPolicySource = path.join(repositoryRoot, "scripts", "version-contract.mjs");
const versionPolicyDeclarationSource = path.join(repositoryRoot, "scripts", "version-contract.d.ts");
const qapLibraryContract = path.join(
  repositoryRoot,
  "packages",
  "frontend",
  "qap-compiler",
  "contracts",
  "subcircuit-library-contract.v1.json",
);
const synthesizerArtifactContract = path.join(
  repositoryRoot,
  "packages",
  "frontend",
  "synthesizer",
  "core",
  "contracts",
  "browser-artifact-contract.v1.json",
);
const backendArtifactContract = path.join(contractRoot, "browser-artifact-contract.v1.json");
const provenanceContractContents = (await fs.readFile(provenanceContract, "utf8")).trim();
const buildMetadataContractContents = (await fs.readFile(buildMetadataContract, "utf8")).trim();
const check = process.argv.includes("--check");
const consumers = [
  path.join(backendRoot, "..", "cli", "src", "generated"),
  path.join(backendRoot, "..", "backend-wasm", "src", "generated"),
];

for (const consumerDirectory of consumers) {
  await synchronize(validatorSource, path.join(consumerDirectory, "crs-provenance-validator.generated.ts"));
  await synchronize(provenanceContract, path.join(consumerDirectory, "crs-provenance-contract.json"));
  await synchronize(versionPolicySource, path.join(consumerDirectory, "version-policy.generated.js"));
  await synchronize(
    versionPolicyDeclarationSource,
    path.join(consumerDirectory, "version-policy.generated.d.ts"),
  );
  await synchronizeContents(
    `// Generated from packages/backend/contracts/crs-provenance-contract.json.\nconst contract = ${provenanceContractContents} as const;\n\nexport default contract;\n`,
    path.join(consumerDirectory, "crs-provenance-contract.generated.ts"),
  );
}

const cliConsumerDirectory = path.join(backendRoot, "..", "cli", "src", "generated");
await synchronize(
  buildMetadataValidatorSource,
  path.join(cliConsumerDirectory, "backend-build-metadata-validator.generated.ts"),
);
await synchronize(buildMetadataContract, path.join(cliConsumerDirectory, "backend-build-metadata-contract.json"));
await synchronizeContents(
  `// Generated from packages/backend/contracts/backend-build-metadata-contract.json.\nconst contract = ${buildMetadataContractContents} as const;\n\nexport default contract;\n`,
  path.join(cliConsumerDirectory, "backend-build-metadata-contract.generated.ts"),
);

const browserConsumerDirectory = path.join(backendRoot, "..", "backend-wasm", "src", "generated");
const [qapContract, synthesizerContract, browserBackendContract] = await Promise.all([
  readJsonContract(qapLibraryContract),
  readArtifactContract(synthesizerArtifactContract),
  readArtifactContract(backendArtifactContract),
]);
await synchronizeContents(
  renderBrowserArtifactContracts(synthesizerContract, browserBackendContract),
  path.join(browserConsumerDirectory, "browser-artifact-contracts.generated.ts"),
);
await synchronizeContents(
  `// Generated from packages/frontend/qap-compiler/contracts/subcircuit-library-contract.v1.json.\nconst contract = ${JSON.stringify(qapContract, null, 2)} as const;\n\nexport default contract;\n`,
  path.join(browserConsumerDirectory, "subcircuit-library-contract.generated.ts"),
);

async function synchronize(source, target) {
  await synchronizeContents(await fs.readFile(source, "utf8"), target);
}

async function synchronizeContents(sourceContents, target) {
  const targetContents = await fs.readFile(target, "utf8").catch(() => "");
  if (check) {
    if (targetContents !== sourceContents) {
      throw new Error(`Backend contract consumer asset is stale: ${target}`);
    }
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, sourceContents, "utf8");
}

async function readArtifactContract(source) {
  const value = await readJsonContract(source);
  if (!value || typeof value !== "object" || !Array.isArray(value.artifacts)) {
    throw new Error(`Browser artifact contract is malformed: ${source}`);
  }
  return value;
}

async function readJsonContract(source) {
  return JSON.parse(await fs.readFile(source, "utf8"));
}

function renderBrowserArtifactContracts(synthesizer, backend) {
  const artifacts = [...synthesizer.artifacts, ...backend.artifacts];
  const names = new Set();
  const rendered = artifacts.map((artifact) => {
    if (!artifact || typeof artifact.name !== "string" || !Array.isArray(artifact.sections)) {
      throw new Error("Browser artifact contract entry is malformed.");
    }
    if (names.has(artifact.name)) {
      throw new Error(`Duplicate browser artifact contract: ${artifact.name}`);
    }
    names.add(artifact.name);
    return renderArtifact(artifact);
  });
  return `// Generated from producer-owned browser artifact contracts. Do not edit.\nimport { BinarySectionEncoding, BinarySectionType } from "../artifacts/binary/binary-format.js";\nimport type { RuntimeArtifactFormatSpec } from "../artifacts/specs/types.js";\n\n${rendered.join("\n\n")}\n`;
}

function renderArtifact(artifact) {
  const constantName = artifact.name.toUpperCase().replaceAll("_", "_") + "_V1_SPEC";
  const sections = artifact.sections.map((section) => {
    if (!section || typeof section.label !== "string" || typeof section.type !== "string" || typeof section.encoding !== "string") {
      throw new Error(`Malformed section in browser artifact ${artifact.name}.`);
    }
    return `{\n      label: ${JSON.stringify(section.label)},\n      type: BinarySectionType.${section.type},\n      encoding: BinarySectionEncoding.${encodingName(section.encoding)},\n      elementCount: ${JSON.stringify(section.elementCount ?? null)},\n      elementByteLength: ${JSON.stringify(section.elementByteLength ?? null)},\n      points: ${JSON.stringify(section.points ?? [], null, 2)},\n    }`;
  });
  return `export const ${constantName} = {\n  schemaVersion: 1,\n  name: ${JSON.stringify(artifact.name)},\n  sections: [\n    ${sections.join(",\n    ")}\n  ],\n} as const satisfies RuntimeArtifactFormatSpec;`;
}

function encodingName(value) {
  const mapping = {
    "ffjs-fr-montgomery-le-32": "FfjsFrMontgomeryLe32",
    "ffjs-g1-affine-96": "FfjsG1Affine96",
    "ffjs-g2-affine-192": "FfjsG2Affine192",
    bytes: "Bytes",
  };
  const mapped = mapping[value];
  if (mapped === undefined) {
    throw new Error(`Unsupported browser artifact encoding: ${value}`);
  }
  return mapped;
}
