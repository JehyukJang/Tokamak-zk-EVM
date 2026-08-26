import fs from "node:fs/promises";
import path from "node:path";

const backendRoot = path.resolve(import.meta.dirname, "..");
const contractRoot = path.join(backendRoot, "contracts");
const validatorSource = path.join(contractRoot, "typescript", "crs-provenance.generated.ts");
const provenanceContract = path.join(contractRoot, "crs-provenance-contract.json");
const provenanceContractContents = (await fs.readFile(provenanceContract, "utf8")).trim();
const check = process.argv.includes("--check");
const consumers = [
  path.join(backendRoot, "..", "cli", "src", "generated"),
  path.join(backendRoot, "..", "backend-wasm", "src", "generated"),
];

for (const consumerDirectory of consumers) {
  await synchronize(validatorSource, path.join(consumerDirectory, "crs-provenance.generated.ts"));
  await synchronize(provenanceContract, path.join(consumerDirectory, "crs-provenance-contract.json"));
  await synchronizeContents(
    `// Generated from packages/backend/contracts/crs-provenance-contract.json.\nconst contract = ${provenanceContractContents} as const;\n\nexport default contract;\n`,
    path.join(consumerDirectory, "crs-provenance-contract.generated.ts"),
  );
}

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
