import { readFile } from "node:fs/promises";
import path from "node:path";

const workflowPath = path.resolve(
  import.meta.dirname,
  "..",
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

checkFinalCrsReleaseWorkflow(workflow);
checkNegativeCases(workflow);

console.log("Checked browser release workflow final CRS provenance boundary");

function checkFinalCrsReleaseWorkflow(value: string): void {
  for (const required of [
    "BACKEND_WASM_VERIFIER_CRS_DIR",
    "npm run subcircuit-library:generate:production",
    "npm run verifier-crs:input:check",
    "npm run verifier-crs:input:validate",
    "name: verified-final-crs",
    "combined_sigma.rkyv",
    "sigma_preprocess.rkyv",
    "sigma_verify.json",
    "crs_provenance.json",
    "--release -p libs --bin check_crs_publication",
    "--no-default-features --features production-npm-subcircuit-library",
    "npm run converter:browser:check:production",
    "npm run converter:webpack:check:production",
    "npm run package:publication:check",
  ]) {
    if (!value.includes(required)) {
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
    if (value.includes(forbidden)) {
      throw new Error(`Browser release workflow must not retain legacy CRS dependency ${forbidden}.`);
    }
  }

  assertOrdered(value, [
    "- name: Check published CRS archive for current backend version",
    "- name: Enforce final CRS publication admission",
    "- name: Install browser-package dependencies for CRS validation",
    "- name: Prepare production subcircuit input for CRS validation",
    "- name: Check final CRS release boundary",
    "- name: Validate canonical final CRS input",
    "- name: Upload verified final CRS",
  ]);
}

function assertOrdered(value: string, markers: readonly string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index < 0) {
      throw new Error(`Browser release workflow is missing ordered step ${marker}.`);
    }
    if (index <= previous) {
      throw new Error(`Browser release workflow must run ${marker} after its prerequisite.`);
    }
    previous = index;
  }
}

function checkNegativeCases(value: string): void {
  expectRejection(
    value.replace("--release -p libs --bin check_crs_publication", "--release -p libs"),
    "The workflow check must reject removal of centralized CRS publication admission.",
  );
  expectRejection(
    value.replace(
      "--no-default-features --features production-npm-subcircuit-library",
      "--features testing-mode",
    ),
    "The workflow check must reject a non-production publication identity.",
  );
  expectRejection(
    value.replace("npm run verifier-crs:input:check", "echo skipped-crs-boundary"),
    "The workflow check must reject bypassing the browser CRS boundary check.",
  );
  expectRejection(
    `${value}\n# build-metadata-mpc-setup.json\n`,
    "The workflow check must reject restoration of removed CRS metadata.",
  );
}

function expectRejection(value: string, message: string): void {
  try {
    checkFinalCrsReleaseWorkflow(value);
  } catch {
    return;
  }
  throw new Error(message);
}
