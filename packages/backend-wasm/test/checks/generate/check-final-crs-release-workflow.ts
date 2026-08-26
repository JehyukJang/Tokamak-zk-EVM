import { readFile } from "node:fs/promises";
import path from "node:path";

const workflowPath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "publish-tokamak-zk-evm.yml",
);

const workflow = await readFile(workflowPath, "utf8");

for (const required of [
  "BACKEND_WASM_VERIFIER_CRS_DIR",
  "npm run verifier-crs:input:validate",
  "name: verified-final-crs",
  "combined_sigma.rkyv",
  "sigma_preprocess.rkyv",
  "sigma_verify.json",
  "crs_provenance.json",
  "npm run converter:browser:check:production",
  "npm run converter:webpack:check:production",
  "npm run package:publication:check",
]) {
  if (!workflow.includes(required)) {
    throw new Error(`Browser release workflow must retain final CRS boundary ${required}.`);
  }
}

for (const forbidden of [
  "BACKEND_WASM_VERIFIER_CRS_SOURCE",
  "build-metadata-mpc-setup.json",
  'provenance.get("backend_version")',
  "combined_sigma_sha256",
  "sigma_preprocess_sha256",
  "sigma_verify_sha256",
]) {
  if (workflow.includes(forbidden)) {
    throw new Error(`Browser release workflow must not retain legacy CRS dependency ${forbidden}.`);
  }
}

console.log("Checked browser release workflow final CRS provenance boundary");
