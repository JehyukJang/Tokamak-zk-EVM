import type { BinaryArtifactFileView } from "./binary-format.js";
import { SUBCIRCUIT_LIBRARY_PACKAGE_VERSION } from "../../generated/setup.generated.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";
import { parseFinalMpcCrsProvenance } from "../../generated/crs-provenance-validator.generated.js";
import {
  compatibilityFromPackageVersion,
  parseCompatibleBackendVersion,
} from "../../generated/version-policy.generated.js";
export type { FinalMpcCrsProvenance as CrsProvenanceInput } from "../../generated/crs-provenance-validator.generated.js";
import type { FinalMpcCrsProvenance as CrsProvenanceInput } from "../../generated/crs-provenance-validator.generated.js";

export const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = "@tokamak-zk-evm/subcircuit-library";

export function validateCrsProvenanceCompatibility(provenance: CrsProvenanceInput): void {
  parseFinalMpcCrsProvenance(provenance);
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
  try {
    return parseCompatibleBackendVersion(value);
  } catch (error) {
    throw new Error(`${label} ${versionPolicyMessage(error)}`);
  }
}

function packageCompatibleVersion(value: string, label: string): string {
  try {
    return compatibilityFromPackageVersion(value);
  } catch (error) {
    throw new Error(`${label} ${versionPolicyMessage(error)}`);
  }
}

function versionPolicyMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
