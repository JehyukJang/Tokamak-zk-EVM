// Repository-owned TypeScript contract for final-MPC CRS provenance.

export type SubcircuitLibraryOrigin = "npmSnapshot" | "localQapCompiler";

export interface FinalMpcCrsProvenance {
  readonly documentKind: "finalMpcCrs";
  readonly releaseEligible: boolean;
  readonly generatedAtUtc: string;
  readonly compatibleBackendVersion: string;
  readonly subcircuitLibrary: { readonly packageName: string; readonly packageVersion: string; readonly origin: SubcircuitLibraryOrigin };
  readonly phase1SourceProvenance: null | "native" | { readonly duskGroth16: Record<string, unknown> };
  readonly combinedSigmaSha256: string;
  readonly sigmaPreprocessSha256: string;
  readonly sigmaVerifySha256: string;
}

const finalFields = ["documentKind", "releaseEligible", "generatedAtUtc", "compatibleBackendVersion", "subcircuitLibrary", "phase1SourceProvenance", "combinedSigmaSha256", "sigmaPreprocessSha256", "sigmaVerifySha256"] as const;
const duskFields = ["sourceUrl", "sourceSizeBytes", "rawEncoding", "pinnedContribution", "pinnedReadmeUrl", "pinnedDriveFileId", "expectedSourceSha256", "actualSourceSha256", "autoDownloaded", "downloadedContribution", "downloadedReadmeUrl", "downloadedDriveFileId", "maxG1ExpUsed", "maxG2ExpUsed", "transcriptConsistencyVerified"] as const;

export function parseFinalMpcCrsProvenance(value: unknown, subject = "CRS provenance"): FinalMpcCrsProvenance {
  const record = exactObject(value, subject, finalFields);
  if (record.documentKind !== "finalMpcCrs") throw new Error(`${subject} documentKind must be finalMpcCrs.`);
  bool(record.releaseEligible, `${subject} releaseEligible`);
  const generatedAtUtc = string(record.generatedAtUtc, `${subject} generatedAtUtc`);
  if (Number.isNaN(Date.parse(generatedAtUtc))) throw new Error(`${subject} generatedAtUtc must be an RFC 3339 date-time.`);
  const library = exactObject(record.subcircuitLibrary, `${subject} subcircuitLibrary`, ["packageName", "packageVersion", "origin"]);
  if (library.origin !== "npmSnapshot" && library.origin !== "localQapCompiler") throw new Error(`${subject} subcircuitLibrary.origin is unsupported.`);
  const phase1 = parsePhase1(record.phase1SourceProvenance, subject);
  return { documentKind: "finalMpcCrs", releaseEligible: bool(record.releaseEligible, `${subject} releaseEligible`), generatedAtUtc, compatibleBackendVersion: string(record.compatibleBackendVersion, `${subject} compatibleBackendVersion`), subcircuitLibrary: { packageName: string(library.packageName, `${subject} subcircuitLibrary.packageName`), packageVersion: string(library.packageVersion, `${subject} subcircuitLibrary.packageVersion`), origin: library.origin }, phase1SourceProvenance: phase1, combinedSigmaSha256: sha(record.combinedSigmaSha256, `${subject} combinedSigmaSha256`), sigmaPreprocessSha256: sha(record.sigmaPreprocessSha256, `${subject} sigmaPreprocessSha256`), sigmaVerifySha256: sha(record.sigmaVerifySha256, `${subject} sigmaVerifySha256`) };
}

function parsePhase1(value: unknown, subject: string): FinalMpcCrsProvenance["phase1SourceProvenance"] {
  if (value === null || value === "native") return value;
  const dusk = exactObject(exactObject(value, `${subject} phase1SourceProvenance`, ["duskGroth16"]).duskGroth16, `${subject} phase1SourceProvenance.duskGroth16`, duskFields);
  for (const field of ["sourceUrl", "rawEncoding", "pinnedContribution", "pinnedReadmeUrl", "pinnedDriveFileId"]) string(dusk[field], `${subject} duskGroth16.${field}`);
  for (const field of ["expectedSourceSha256", "actualSourceSha256"]) sha(dusk[field], `${subject} duskGroth16.${field}`);
  for (const field of ["sourceSizeBytes", "maxG1ExpUsed", "maxG2ExpUsed"]) integer(dusk[field], `${subject} duskGroth16.${field}`);
  for (const field of ["autoDownloaded", "transcriptConsistencyVerified"]) bool(dusk[field], `${subject} duskGroth16.${field}`);
  for (const field of ["downloadedContribution", "downloadedReadmeUrl", "downloadedDriveFileId"]) if (dusk[field] !== null) string(dusk[field], `${subject} duskGroth16.${field}`);
  return { duskGroth16: dusk };
}

function exactObject(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`); const record = value as Record<string, unknown>; for (const field of fields) if (!Object.prototype.hasOwnProperty.call(record, field)) throw new Error(`${label} is missing ${field}.`); for (const field of Object.keys(record)) if (!fields.includes(field)) throw new Error(`${label} has unsupported field ${field}.`); return record; }
function string(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`); return value; }
function bool(value: unknown, label: string): boolean { if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`); return value; }
function integer(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`); return value; }
function sha(value: unknown, label: string): string { const digest = string(value, label); if (!/^[0-9a-f]{64}$/u.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 hex digest.`); return digest; }
