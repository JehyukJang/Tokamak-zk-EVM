import {
  assertBinaryArtifactCompatibility,
  type CrsProvenanceInput,
  validateCrsProvenanceCompatibility,
} from "../../../src/artifacts/binary/compatibility.js";
import { BinaryArtifactFileKind, type BinaryArtifactFileView } from "../../../src/artifacts/binary/binary-format.js";
import { SUBCIRCUIT_LIBRARY_PACKAGE_VERSION } from "../../../src/generated/setup.generated.js";

const PACKAGE_NAME = "@tokamak-zk-evm/subcircuit-library";

function compatibleVersion(packageVersion: string): string {
  const [major, minor] = packageVersion.split(".");
  return `${Number(major)}.${Number(minor)}`;
}

function provenance(version: string): CrsProvenanceInput {
  return {
    compatibleBackendVersion: compatibleVersion(version),
    subcircuitLibrary: {
      packageName: PACKAGE_NAME,
      packageVersion: version,
    },
  };
}

function artifact(sourcePackageVersion: string): BinaryArtifactFileView {
  return {
    kind: BinaryArtifactFileKind.ProverCrs,
    formatVersion: 1,
    sourcePackageVersion,
    byteLength: 0,
    selfDigest: new Uint8Array(32),
    sections: [],
  };
}

function expectFailure(action: () => void, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

function main(): void {
  const expected = provenance(SUBCIRCUIT_LIBRARY_PACKAGE_VERSION);
  validateCrsProvenanceCompatibility(expected);
  assertBinaryArtifactCompatibility(artifact(SUBCIRCUIT_LIBRARY_PACKAGE_VERSION));

  expectFailure(
    () => validateCrsProvenanceCompatibility(provenance("9.9.0")),
    "CRS provenance from a distinct compatibility class must be rejected.",
  );
  expectFailure(
    () => assertBinaryArtifactCompatibility(artifact("9.9.0")),
    "Binary CRS from a distinct compatibility class must be rejected.",
  );
  console.log("Checked CRS and binary artifact compatibility-class rejection");
}

main();
