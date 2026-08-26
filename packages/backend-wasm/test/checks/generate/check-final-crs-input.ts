import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadVerifiedFinalCrsInput } from "../../../scripts/generate/final-crs-input.js";
import { SUBCIRCUIT_LIBRARY_PACKAGE_VERSION } from "../../../src/generated/setup.generated.js";

const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = "@tokamak-zk-evm/subcircuit-library";

async function main(): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "backend-wasm-final-crs-input-"));
  try {
    const files = {
      combinedSigma: Uint8Array.from([1, 2, 3]),
      sigmaPreprocess: Uint8Array.from([4, 5, 6]),
      sigmaVerify: Uint8Array.from([7, 8, 9]),
    };
    await writeFinalCrsDirectory(directory, files);

    const accepted = await loadVerifiedFinalCrsInput(directory);
    if (accepted.provenance.releaseEligible !== false) {
      throw new Error("The final CRS ingress must not require releaseEligible.");
    }

    await expectFailure(
      async () => {
        await writeFile(path.join(directory, "sigma_verify.json"), Uint8Array.from([9, 8, 7]));
        await loadVerifiedFinalCrsInput(directory);
      },
      "Final CRS ingress must reject a Sigma digest mismatch.",
    );

    await writeFinalCrsDirectory(directory, files);
    await expectFailure(
      async () => {
        await writeFile(path.join(directory, "combined_sigma.rkyv"), Uint8Array.from([3, 2, 1]));
        await loadVerifiedFinalCrsInput(directory);
      },
      "Final CRS ingress must reject a combined Sigma digest mismatch.",
    );

    await writeFinalCrsDirectory(directory, files);
    await expectFailure(
      async () => {
        await writeFile(path.join(directory, "sigma_preprocess.rkyv"), Uint8Array.from([6, 5, 4]));
        await loadVerifiedFinalCrsInput(directory);
      },
      "Final CRS ingress must reject a preprocess Sigma digest mismatch.",
    );

    await writeFinalCrsDirectory(directory, files, {
      compatibleBackendVersion: "9.9",
      subcircuitLibraryVersion: "9.9.0",
    });
    await expectFailure(
      () => loadVerifiedFinalCrsInput(directory),
      "Final CRS ingress must reject an incompatible provenance class.",
    );

    await writeFile(path.join(directory, "crs_provenance.json"), "{\n");
    await expectFailure(
      () => loadVerifiedFinalCrsInput(directory),
      "Final CRS ingress must reject malformed provenance JSON.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  console.log("Checked final CRS generator input provenance and digest binding");
}

async function writeFinalCrsDirectory(
  directory: string,
  files: {
    readonly combinedSigma: Uint8Array;
    readonly sigmaPreprocess: Uint8Array;
    readonly sigmaVerify: Uint8Array;
  },
  overrides: {
    readonly compatibleBackendVersion?: string;
    readonly subcircuitLibraryVersion?: string;
  } = {},
): Promise<void> {
  await Promise.all([
    writeFile(path.join(directory, "combined_sigma.rkyv"), files.combinedSigma),
    writeFile(path.join(directory, "sigma_preprocess.rkyv"), files.sigmaPreprocess),
    writeFile(path.join(directory, "sigma_verify.json"), files.sigmaVerify),
  ]);
  const version = overrides.subcircuitLibraryVersion ?? SUBCIRCUIT_LIBRARY_PACKAGE_VERSION;
  const provenance = {
    documentKind: "finalMpcCrs",
    releaseEligible: false,
    generatedAtUtc: "2026-08-26T00:00:00Z",
    compatibleBackendVersion: overrides.compatibleBackendVersion ?? compatibleVersion(version),
    subcircuitLibrary: {
      packageName: SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
      packageVersion: version,
      origin: "npmSnapshot",
    },
    phase1SourceProvenance: null,
    combinedSigmaSha256: sha256(files.combinedSigma),
    sigmaPreprocessSha256: sha256(files.sigmaPreprocess),
    sigmaVerifySha256: sha256(files.sigmaVerify),
  };
  await writeFile(
    path.join(directory, "crs_provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}

function compatibleVersion(packageVersion: string): string {
  return packageVersion.split(".").slice(0, 2).join(".");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectFailure(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

await main();
