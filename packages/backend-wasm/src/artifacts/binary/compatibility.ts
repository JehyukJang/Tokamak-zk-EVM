import type { BinaryArtifactFileView } from "./binary-format.js";
import { SUBCIRCUIT_LIBRARY_PACKAGE_VERSION } from "../../generated/setup.generated.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";

export const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = "@tokamak-zk-evm/subcircuit-library";

export interface CrsProvenanceInput {
  readonly compatibleBackendVersion: string;
  readonly subcircuitLibrary: {
    readonly packageName: string;
    readonly packageVersion: string;
  };
}

export function validateCrsProvenanceCompatibility(provenance: CrsProvenanceInput): void {
  const provenanceCompatibleVersion = normalizeCompatibleBackendVersion(
    provenance.compatibleBackendVersion,
    "CRS provenance compatibleBackendVersion",
  );
  const expectedCompatibleVersion = packageCompatibleVersion(
    SUBCIRCUIT_LIBRARY_PACKAGE_VERSION,
    "installed subcircuit-library package version",
  );
  if (provenanceCompatibleVersion !== expectedCompatibleVersion) {
    throw new Error(
      `CRS compatibility version ${provenanceCompatibleVersion} does not match installed subcircuit-library compatibility class ${expectedCompatibleVersion}.`,
    );
  }
  if (provenance.subcircuitLibrary.packageName !== SUBCIRCUIT_LIBRARY_PACKAGE_NAME) {
    throw new Error(
      `CRS provenance subcircuit-library package ${provenance.subcircuitLibrary.packageName} does not match ${SUBCIRCUIT_LIBRARY_PACKAGE_NAME}.`,
    );
  }
  if (
    packageCompatibleVersion(
      provenance.subcircuitLibrary.packageVersion,
      "CRS provenance subcircuit-library packageVersion",
    ) !== expectedCompatibleVersion
  ) {
    throw new Error(
      `CRS provenance subcircuit-library version ${provenance.subcircuitLibrary.packageVersion} is not compatible with ${expectedCompatibleVersion}.`,
    );
  }
}

export function assertRuntimeLibraryCompatibility(): void {
  const browserCompatibleVersion = packageCompatibleVersion(
    BACKEND_WASM_PACKAGE_VERSION,
    "snark-browser-compat package version",
  );
  const libraryCompatibleVersion = packageCompatibleVersion(
    SUBCIRCUIT_LIBRARY_PACKAGE_VERSION,
    "generated subcircuit-library package version",
  );
  if (browserCompatibleVersion !== libraryCompatibleVersion) {
    throw new Error(
      `snark-browser-compat compatibility class ${browserCompatibleVersion} does not match generated subcircuit-library compatibility class ${libraryCompatibleVersion}; regenerate browser artifacts from the synchronized published library.`,
    );
  }
}

export function assertBinaryArtifactCompatibility(artifact: BinaryArtifactFileView): void {
  const expectedCompatibleVersion = packageCompatibleVersion(
    SUBCIRCUIT_LIBRARY_PACKAGE_VERSION,
    "installed subcircuit-library package version",
  );
  const artifactCompatibleVersion = packageCompatibleVersion(
    artifact.sourcePackageVersion,
    "binary artifact sourcePackageVersion",
  );
  if (artifactCompatibleVersion !== expectedCompatibleVersion) {
    throw new Error(
      `Binary artifact compatibility class ${artifactCompatibleVersion} does not match installed subcircuit-library compatibility class ${expectedCompatibleVersion}.`,
    );
  }
}

function normalizeCompatibleBackendVersion(value: string, label: string): string {
  const match = /^(\d+)\.(\d+)$/u.exec(value);
  if (match === null) {
    throw new Error(`${label} must be strict MAJOR.MINOR, got ${JSON.stringify(value)}.`);
  }
  return `${Number(match[1])}.${Number(match[2])}`;
}

function packageCompatibleVersion(value: string, label: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) {
    throw new Error(`${label} must be strict MAJOR.MINOR.PATCH, got ${JSON.stringify(value)}.`);
  }
  return `${Number(match[1])}.${Number(match[2])}`;
}
