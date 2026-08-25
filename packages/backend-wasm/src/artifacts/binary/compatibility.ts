import type { BinaryArtifactFileView } from "./binary-format.js";
import { SUBCIRCUIT_LIBRARY_PACKAGE_VERSION } from "../../generated/setup.generated.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";

export const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = "@tokamak-zk-evm/subcircuit-library";

export interface CrsProvenanceInput {
  readonly documentKind: "finalMpcCrs";
  readonly releaseEligible: boolean;
  readonly generatedAtUtc: string;
  readonly compatibleBackendVersion: string;
  readonly subcircuitLibrary: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly origin: "npmSnapshot" | "localQapCompiler";
  };
  readonly phase1SourceProvenance: null | "native" | {
    readonly duskGroth16: {
      readonly sourceUrl: string;
      readonly sourceSizeBytes: number;
      readonly rawEncoding: string;
      readonly pinnedContribution: string;
      readonly pinnedReadmeUrl: string;
      readonly pinnedDriveFileId: string;
      readonly expectedSourceSha256: string;
      readonly actualSourceSha256: string;
      readonly autoDownloaded: boolean;
      readonly downloadedContribution: string | null;
      readonly downloadedReadmeUrl: string | null;
      readonly downloadedDriveFileId: string | null;
      readonly maxG1ExpUsed: number;
      readonly maxG2ExpUsed: number;
      readonly transcriptConsistencyVerified: boolean;
    };
  };
  readonly combinedSigmaSha256: string;
  readonly sigmaPreprocessSha256: string;
  readonly sigmaVerifySha256: string;
}

export function validateCrsProvenanceCompatibility(provenance: CrsProvenanceInput): void {
  assertFinalMpcCrsProvenanceShape(provenance);
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

function assertFinalMpcCrsProvenanceShape(provenance: CrsProvenanceInput): void {
  const record = requiredExactObject(provenance, "CRS provenance", [
    "documentKind",
    "releaseEligible",
    "generatedAtUtc",
    "compatibleBackendVersion",
    "subcircuitLibrary",
    "phase1SourceProvenance",
    "combinedSigmaSha256",
    "sigmaPreprocessSha256",
    "sigmaVerifySha256",
  ]);
  if (record.documentKind !== "finalMpcCrs") {
    throw new Error("CRS provenance documentKind must be finalMpcCrs.");
  }
  requiredBoolean(record.releaseEligible, "CRS provenance releaseEligible");
  const generatedAtUtc = requiredString(record.generatedAtUtc, "CRS provenance generatedAtUtc");
  if (Number.isNaN(Date.parse(generatedAtUtc))) {
    throw new Error("CRS provenance generatedAtUtc must be an RFC 3339 date-time.");
  }
  requiredString(record.compatibleBackendVersion, "CRS provenance compatibleBackendVersion");
  assertSubcircuitLibraryShape(record.subcircuitLibrary);
  assertPhase1SourceProvenanceShape(record.phase1SourceProvenance);
  requiredSha256(record.combinedSigmaSha256, "CRS provenance combinedSigmaSha256");
  requiredSha256(record.sigmaPreprocessSha256, "CRS provenance sigmaPreprocessSha256");
  requiredSha256(record.sigmaVerifySha256, "CRS provenance sigmaVerifySha256");
}

function assertSubcircuitLibraryShape(value: unknown): void {
  const library = requiredExactObject(value, "CRS provenance subcircuitLibrary", [
    "packageName",
    "packageVersion",
    "origin",
  ]);
  requiredString(library.packageName, "CRS provenance subcircuitLibrary.packageName");
  requiredString(library.packageVersion, "CRS provenance subcircuitLibrary.packageVersion");
  if (library.origin !== "npmSnapshot" && library.origin !== "localQapCompiler") {
    throw new Error("CRS provenance subcircuitLibrary.origin is unsupported.");
  }
}

function assertPhase1SourceProvenanceShape(value: unknown): void {
  if (value === null || value === "native") {
    return;
  }
  const phase1 = requiredExactObject(value, "CRS provenance phase1SourceProvenance", ["duskGroth16"]);
  const dusk = requiredExactObject(phase1.duskGroth16, "CRS provenance phase1SourceProvenance.duskGroth16", [
    "sourceUrl",
    "sourceSizeBytes",
    "rawEncoding",
    "pinnedContribution",
    "pinnedReadmeUrl",
    "pinnedDriveFileId",
    "expectedSourceSha256",
    "actualSourceSha256",
    "autoDownloaded",
    "downloadedContribution",
    "downloadedReadmeUrl",
    "downloadedDriveFileId",
    "maxG1ExpUsed",
    "maxG2ExpUsed",
    "transcriptConsistencyVerified",
  ]);
  requiredString(dusk.sourceUrl, "CRS provenance phase1SourceProvenance.duskGroth16.sourceUrl");
  requiredInteger(dusk.sourceSizeBytes, "CRS provenance phase1SourceProvenance.duskGroth16.sourceSizeBytes");
  requiredString(dusk.rawEncoding, "CRS provenance phase1SourceProvenance.duskGroth16.rawEncoding");
  requiredString(dusk.pinnedContribution, "CRS provenance phase1SourceProvenance.duskGroth16.pinnedContribution");
  requiredString(dusk.pinnedReadmeUrl, "CRS provenance phase1SourceProvenance.duskGroth16.pinnedReadmeUrl");
  requiredString(dusk.pinnedDriveFileId, "CRS provenance phase1SourceProvenance.duskGroth16.pinnedDriveFileId");
  requiredSha256(dusk.expectedSourceSha256, "CRS provenance phase1SourceProvenance.duskGroth16.expectedSourceSha256");
  requiredSha256(dusk.actualSourceSha256, "CRS provenance phase1SourceProvenance.duskGroth16.actualSourceSha256");
  requiredBoolean(dusk.autoDownloaded, "CRS provenance phase1SourceProvenance.duskGroth16.autoDownloaded");
  requiredNullableString(dusk.downloadedContribution, "CRS provenance phase1SourceProvenance.duskGroth16.downloadedContribution");
  requiredNullableString(dusk.downloadedReadmeUrl, "CRS provenance phase1SourceProvenance.duskGroth16.downloadedReadmeUrl");
  requiredNullableString(dusk.downloadedDriveFileId, "CRS provenance phase1SourceProvenance.duskGroth16.downloadedDriveFileId");
  requiredInteger(dusk.maxG1ExpUsed, "CRS provenance phase1SourceProvenance.duskGroth16.maxG1ExpUsed");
  requiredInteger(dusk.maxG2ExpUsed, "CRS provenance phase1SourceProvenance.duskGroth16.maxG2ExpUsed");
  requiredBoolean(dusk.transcriptConsistencyVerified, "CRS provenance phase1SourceProvenance.duskGroth16.transcriptConsistencyVerified");
}

function requiredExactObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(fields);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new Error(`${label} is missing ${field}.`);
    }
  }
  for (const field of Object.keys(record)) {
    if (!expected.has(field)) {
      throw new Error(`${label} has unsupported field ${field}.`);
    }
  }
  return record;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function requiredNullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return digest;
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
