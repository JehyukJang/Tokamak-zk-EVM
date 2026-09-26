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
    "Resolve public CRS with read-only Drive access",
    "Build frozen browser package without mutation credentials",
    "TOKAMAK_MPC_DRIVE_SERVICE_ACCOUNT_JSON",
    "BACKEND_WASM_VERIFIER_CRS_DIR",
    "tokamak-zk-evm-verified-final-crs",
    "npm run verifier-crs:input:check",
    "npm run verifier-crs:input:validate",
    "npm run converter:browser:check:production",
    "npm run converter:webpack:check:production",
    "npm run package:publication:check",
  ]) {
    if (!value.includes(required)) {
      throw new Error(`Browser release workflow must retain final CRS boundary ${required}.`);
    }
  }

  const finalDevHeadGuard = `test "$(jq -r '.head.ref' <<<"$pr")" = "dev"`;
  if (value.split(finalDevHeadGuard).length - 1 !== 2) {
    throw new Error("The final-release workflow must enforce a dev-to-main pull request in both identity checks.");
  }

  for (const forbidden of [
    "combined_sigma.rkyv",
    "sigma_preprocess.rkyv",
    "sigma_verify.json",
    "combined_sigma_sha256",
    "sigma_preprocess_sha256",
    "sigma_verify_sha256",
  ]) {
    if (value.includes(forbidden)) {
      throw new Error(`Browser release workflow must not retain legacy CRS dependency ${forbidden}.`);
    }
  }

  assertOrdered(value, [
    "- name: Download and hash-check canonical CRS layout",
    "- name: Upload verified public CRS",
    "- name: Download verified public CRS",
    "- name: Build and pack browser package",
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
    value.split("npm run verifier-crs:input:check").join("echo skipped-crs-boundary"),
    "The workflow check must reject bypassing the browser CRS boundary check.",
  );
  expectRejection(
    value.split("TOKAMAK_MPC_DRIVE_SERVICE_ACCOUNT_JSON").join("UNCONFIGURED_DRIVE_CREDENTIAL"),
    "The workflow check must reject removal of the read-only CRS resolver boundary.",
  );
  expectRejection(
    `${value}\n# combined_sigma.rkyv\n`,
    "The workflow check must reject restoration of a legacy CRS payload.",
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
