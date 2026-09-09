import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { getCurveFromName } from "ffjavascript";

import { UNIVARIATE_CRS_CHUNK_CONTRACT } from "../../src/generated/univariate-crs-chunk-contract.generated.js";

const execFileAsync = promisify(execFile);
const FQ_BYTES = 48;
const FQ_BATCH_ELEMENTS = 1 << 18;
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;
const CANONICAL_MANIFEST_FILE = "canonical-manifest.json";

interface RawBaseField {
  batchToMontgomery(input: Uint8Array): Promise<Uint8Array>;
}

interface ConverterCurve {
  readonly F1: RawBaseField;
  terminate?(): Promise<void>;
}

interface CanonicalChunk {
  readonly path: string;
  readonly firstElement: number;
  readonly elementCount: number;
  readonly byteLength: number;
  readonly sha256: string;
}

interface CanonicalSection {
  readonly label: string;
  readonly encoding: string;
  readonly elementCount: number;
  readonly elementByteLength: number;
  readonly chunks: readonly CanonicalChunk[];
}

interface CanonicalManifest {
  readonly schemaId: string;
  readonly sourcePackageVersion: string;
  readonly sourceRkyvSha256: string;
  readonly declaredCapacity: readonly [number, number, number];
  readonly k: number;
  readonly sections: readonly CanonicalSection[];
}

export interface UnivariateCrsConversionOptions {
  readonly input: string;
  readonly output: string;
  readonly chunkBytes: number;
}

async function main(argv: readonly string[]): Promise<void> {
  await convertUnivariateCrsRkyv(parseArguments(argv));
}

export async function convertUnivariateCrsRkyv(args: UnivariateCrsConversionOptions): Promise<void> {
  const input = path.resolve(args.input);
  const output = path.resolve(args.output);
  await requireFile(input);
  await rejectExistingOutput(output);
  await mkdir(path.dirname(output), { recursive: true });

  const stagingRoot = await mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}-`));
  const canonicalRoot = path.join(stagingRoot, "canonical");
  const runtimeRoot = path.join(stagingRoot, "runtime");
  try {
    const backendRoot = path.resolve(import.meta.dirname, "../../..");
    await execFileAsync(
      "cargo",
      [
        "run",
        "--locked",
        "--release",
        "-p",
        "backend-wasm-univariate-crs-chunker",
        "--",
        "--input",
        input,
        "--output",
        canonicalRoot,
        "--chunk-bytes",
        String(args.chunkBytes),
      ],
      { cwd: backendRoot, maxBuffer: 16 * 1024 * 1024 },
    );
    await convertCanonicalCrsChunks(canonicalRoot, runtimeRoot);
    await rename(runtimeRoot, output);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function convertCanonicalCrsChunks(canonicalRoot: string, runtimeRoot: string): Promise<void> {
  const canonical = parseCanonicalManifest(
    JSON.parse(await readFile(path.join(canonicalRoot, CANONICAL_MANIFEST_FILE), "utf8")) as unknown,
  );
  validateCanonicalManifest(canonical);
  const curve = (await getCurveFromName("bls12381")) as ConverterCurve;
  try {
    await mkdir(path.join(runtimeRoot, "chunks"), { recursive: true });
    const sections = [];
    for (const section of canonical.sections) {
      const contractSection = UNIVARIATE_CRS_CHUNK_CONTRACT.sections.find(
        (candidate) => candidate.label === section.label,
      );
      if (contractSection === undefined) {
        throw new Error(`Canonical CRS contains unsupported section '${section.label}'.`);
      }
      const chunks = [];
      for (const chunk of section.chunks) {
        const sourcePath = resolveChunkPath(canonicalRoot, chunk.path);
        const source = new Uint8Array(await readFile(sourcePath));
        requireDigest(source, chunk.sha256, `canonical chunk '${chunk.path}'`);
        const converted = section.encoding === "canonical-g1-affine-le" || section.encoding === "canonical-g2-affine-le"
          ? await batchToMontgomeryInChunks(curve.F1, source)
          : source;
        const destinationPath = resolveChunkPath(runtimeRoot, chunk.path);
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, converted);
        chunks.push({ ...chunk, byteLength: converted.byteLength, sha256: digestHex(converted) });
      }
      sections.push({
        label: section.label,
        encoding: contractSection.encoding,
        elementCount: section.elementCount,
        elementByteLength: contractSection.elementByteLength,
        chunks,
      });
    }
    await writeFile(
      path.join(runtimeRoot, UNIVARIATE_CRS_CHUNK_CONTRACT.manifestFileName),
      `${JSON.stringify({
        schemaId: UNIVARIATE_CRS_CHUNK_CONTRACT.schemaId,
        sourceSchemaId: canonical.schemaId,
        sourcePackageVersion: canonical.sourcePackageVersion,
        sourceRkyvSha256: canonical.sourceRkyvSha256,
        declaredCapacity: canonical.declaredCapacity,
        k: canonical.k,
        sections,
      }, null, 2)}\n`,
    );
  } finally {
    await curve.terminate?.();
  }
}

async function batchToMontgomeryInChunks(field: RawBaseField, input: Uint8Array): Promise<Uint8Array> {
  if (input.byteLength % FQ_BYTES !== 0) {
    throw new Error("CRS base-field data must contain whole 48-byte coordinates.");
  }
  const output = new Uint8Array(input.byteLength);
  const chunkBytes = FQ_BATCH_ELEMENTS * FQ_BYTES;
  for (let offset = 0; offset < input.byteLength; offset += chunkBytes) {
    const end = Math.min(offset + chunkBytes, input.byteLength);
    output.set(await field.batchToMontgomery(input.subarray(offset, end)), offset);
  }
  return output;
}

function parseCanonicalManifest(raw: unknown): CanonicalManifest {
  const value = requireRecord(raw, "canonical CRS manifest");
  if (value.schemaId !== UNIVARIATE_CRS_CHUNK_CONTRACT.sourceSchemaId) {
    throw new Error("Canonical CRS manifest uses an unsupported source schema.");
  }
  const declaredCapacity = requireSafeIntegerArray(value.declaredCapacity, "declaredCapacity");
  if (declaredCapacity.length !== 3) {
    throw new Error("Canonical CRS declaredCapacity must contain exactly three values.");
  }
  const sections = requireArray(value.sections, "sections").map((entry, index) => {
    const section = requireRecord(entry, `sections[${index}]`);
    return {
      label: requireString(section.label, `sections[${index}].label`),
      encoding: requireString(section.encoding, `sections[${index}].encoding`),
      elementCount: requireSafeInteger(section.elementCount, `sections[${index}].elementCount`),
      elementByteLength: requireSafeInteger(section.elementByteLength, `sections[${index}].elementByteLength`),
      chunks: requireArray(section.chunks, `sections[${index}].chunks`).map((item, chunkIndex) => {
        const chunk = requireRecord(item, `sections[${index}].chunks[${chunkIndex}]`);
        return {
          path: requireString(chunk.path, `sections[${index}].chunks[${chunkIndex}].path`),
          firstElement: requireSafeInteger(chunk.firstElement, `sections[${index}].chunks[${chunkIndex}].firstElement`),
          elementCount: requireSafeInteger(chunk.elementCount, `sections[${index}].chunks[${chunkIndex}].elementCount`),
          byteLength: requireSafeInteger(chunk.byteLength, `sections[${index}].chunks[${chunkIndex}].byteLength`),
          sha256: requireSha256(chunk.sha256, `sections[${index}].chunks[${chunkIndex}].sha256`),
        };
      }),
    };
  });
  return {
    schemaId: value.schemaId,
    sourcePackageVersion: requireString(value.sourcePackageVersion, "sourcePackageVersion"),
    sourceRkyvSha256: requireSha256(value.sourceRkyvSha256, "sourceRkyvSha256"),
    declaredCapacity: declaredCapacity as unknown as readonly [number, number, number],
    k: requireSafeInteger(value.k, "k"),
    sections,
  };
}

function validateCanonicalManifest(manifest: CanonicalManifest): void {
  if (manifest.sections.length !== UNIVARIATE_CRS_CHUNK_CONTRACT.sections.length) {
    throw new Error("Canonical CRS manifest does not contain the complete backend section set.");
  }
  const seen = new Set<string>();
  for (const section of manifest.sections) {
    if (seen.has(section.label)) throw new Error(`Canonical CRS duplicates section '${section.label}'.`);
    seen.add(section.label);
    const contract = UNIVARIATE_CRS_CHUNK_CONTRACT.sections.find((candidate) => candidate.label === section.label);
    if (contract === undefined) throw new Error(`Canonical CRS contains unsupported section '${section.label}'.`);
    const canonicalEncoding = contract.encoding === "ffjs-g1-affine-96"
      ? "canonical-g1-affine-le"
      : contract.encoding === "ffjs-g2-affine-192" ? "canonical-g2-affine-le" : "u32-le";
    if (section.encoding !== canonicalEncoding || section.elementByteLength !== contract.elementByteLength) {
      throw new Error(`Canonical CRS section '${section.label}' has an invalid representation.`);
    }
    if ("elementCount" in contract && section.elementCount !== contract.elementCount) {
      throw new Error(`Canonical CRS section '${section.label}' has an invalid cardinality.`);
    }
    let cursor = 0;
    for (const chunk of section.chunks) {
      if (
        chunk.elementCount <= 0
        || chunk.firstElement !== cursor
        || chunk.byteLength !== chunk.elementCount * section.elementByteLength
      ) {
        throw new Error(`Canonical CRS section '${section.label}' has a malformed chunk table.`);
      }
      cursor += chunk.elementCount;
    }
    if (cursor !== section.elementCount) {
      throw new Error(`Canonical CRS section '${section.label}' chunks do not cover the section.`);
    }
  }
  const count = (label: string): number => manifest.sections.find((section) => section.label === label)!.elementCount;
  if (
    count("crs.s0") !== manifest.declaredCapacity[0] + 1
    || count("crs.sxi") !== manifest.declaredCapacity[1] + 1
    || count("crs.spsi") !== manifest.declaredCapacity[2] + 1
  ) {
    throw new Error("Canonical CRS sequence lengths do not match declaredCapacity.");
  }
  for (const [keys, points] of [
    ["crs.public-query-keys", "crs.public-queries"],
    ["crs.interface-query-keys", "crs.interface-queries"],
    ["crs.internal-query-keys", "crs.internal-queries"],
  ] as const) {
    if (count(keys) !== count(points)) throw new Error(`Canonical CRS ${keys} and ${points} cardinalities differ.`);
  }
}

function parseArguments(argv: readonly string[]): UnivariateCrsConversionOptions {
  let input: string | undefined;
  let output: string | undefined;
  let chunkBytes = DEFAULT_CHUNK_BYTES;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${name}.`);
    if (name === "--input") input = value;
    else if (name === "--output") output = value;
    else if (name === "--chunk-bytes") chunkBytes = Number(value);
    else throw new Error(`Unsupported argument: ${name}.`);
  }
  if (input === undefined || output === undefined) {
    throw new Error("Usage: convert-univariate-crs --input <univariate_crs.rkyv> --output <directory> [--chunk-bytes <bytes>]");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 192) {
    throw new Error("--chunk-bytes must be a safe integer of at least 192 bytes.");
  }
  return { input, output, chunkBytes };
}

function resolveChunkPath(root: string, relative: string): string {
  if (path.isAbsolute(relative)) throw new Error(`Chunk path must be relative: ${relative}.`);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Chunk path escapes its CRS directory: ${relative}.`);
  }
  return resolved;
}

async function requireFile(filePath: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Input CRS is not a file: ${filePath}.`);
}

async function rejectExistingOutput(output: string): Promise<void> {
  if (await stat(output).then(() => true).catch(() => false)) {
    throw new Error(`Output path already exists: ${output}.`);
  }
}

function requireDigest(bytes: Uint8Array, expected: string, label: string): void {
  const actual = digestHex(bytes);
  if (actual !== expected) throw new Error(`${label} digest mismatch.`);
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireSafeIntegerArray(value: unknown, label: string): readonly number[] {
  return requireArray(value, label).map((entry, index) => requireSafeInteger(entry, `${label}[${index}]`));
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] === entrypoint) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
