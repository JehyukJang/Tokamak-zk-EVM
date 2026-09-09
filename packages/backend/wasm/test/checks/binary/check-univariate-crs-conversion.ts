import { sha256 } from "@noble/hashes/sha256";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { convertCanonicalCrsChunks } from "../../../scripts/converter/convert-univariate-crs.js";
import { UNIVARIATE_CRS_CHUNK_CONTRACT } from "../../../src/generated/univariate-crs-chunk-contract.generated.js";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import type { UnivariateCrsChunkInput } from "../../../src/univariate/chunked-crs.js";
import {
  parseUnivariatePreprocessCrs,
  parseUnivariateProverCrs,
  parseUnivariateVerifierCrs,
} from "../../../src/univariate/crs.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../../src/version.js";

async function main(): Promise<void> {
  const runtime = await createCurveRuntime();
  try {
    const g1 = runtime.G1.generator;
    const g2 = runtime.G2.generator;
    const fixture = createFixture(g1, g2);
    const preprocess = await parseUnivariatePreprocessCrs(fixture);
    if (preprocess.s0.elementCount !== 2) throw new Error("Preprocess CRS lost the S0 range.");

    const prover = await parseUnivariateProverCrs(fixture);
    if ((await prover.interfaceQueries.keyAt(0)).localWireIndex !== 2) {
      throw new Error("Prover CRS lost its tagged interface key.");
    }
    if (!runtime.G1.eq(prover.deltaG1, g1)) throw new Error("Prover CRS lost delta G1.");

    const verifier = await parseUnivariateVerifierCrs(fixture);
    if ((await verifier.publicQueries.keyAt(0)).localPublicWireIndex !== 1) {
      throw new Error("Verifier CRS lost its public query key.");
    }
    if (!runtime.G2.eq(verifier.oneG2, g2)) throw new Error("Verifier CRS lost one G2.");

    const malformed = createFixture(g1, g2);
    (malformed.manifest as { sections: { label: string }[] }).sections[0]!.label = "crs.unknown";
    await expectRejects(() => parseUnivariatePreprocessCrs(malformed), "unsupported section");

    const corrupted = createFixture(g1, g2, true);
    const corruptedPreprocess = await parseUnivariatePreprocessCrs(corrupted);
    await expectRejects(() => corruptedPreprocess.s0.readElement(0), "digest mismatch");
  } finally {
    await runtime.terminate();
  }
  await checkCanonicalConversion();
  console.log("Checked manifest admission and lazy chunk loading for the univariate browser CRS");
}

async function checkCanonicalConversion(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tokamak-univariate-crs-conversion-"));
  const canonicalRoot = path.join(root, "canonical");
  const runtimeRoot = path.join(root, "runtime");
  try {
    await mkdir(path.join(canonicalRoot, "chunks"), { recursive: true });
    const sections = [];
    for (const [index, contract] of UNIVARIATE_CRS_CHUNK_CONTRACT.sections.entries()) {
      const elementCount = "elementCount" in contract
        ? contract.elementCount
        : contract.label === "crs.s0" || contract.label === "crs.sxi" || contract.label === "crs.spsi" ? 2 : 1;
      const bytes = new Uint8Array(elementCount * contract.elementByteLength);
      const relativePath = `chunks/${index}.bin`;
      await writeFile(path.join(canonicalRoot, relativePath), bytes);
      sections.push({
        label: contract.label,
        encoding: contract.encoding === "ffjs-g1-affine-96"
          ? "canonical-g1-affine-le"
          : contract.encoding === "ffjs-g2-affine-192" ? "canonical-g2-affine-le" : "u32-le",
        elementCount,
        elementByteLength: contract.elementByteLength,
        chunks: [{
          path: relativePath,
          firstElement: 0,
          elementCount,
          byteLength: bytes.byteLength,
          sha256: hex(sha256(bytes)),
        }],
      });
    }
    await writeFile(path.join(canonicalRoot, "canonical-manifest.json"), JSON.stringify({
      schemaId: UNIVARIATE_CRS_CHUNK_CONTRACT.sourceSchemaId,
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      sourceRkyvSha256: {
        tauSequence: "11".repeat(32),
        proverKeys: "22".repeat(32),
        verifierKeys: "33".repeat(32),
      },
      declaredCapacity: [1, 1, 1],
      k: 1,
      sections,
    }));
    await convertCanonicalCrsChunks(canonicalRoot, runtimeRoot);
    const manifest = JSON.parse(
      await readFile(path.join(runtimeRoot, UNIVARIATE_CRS_CHUNK_CONTRACT.manifestFileName), "utf8"),
    ) as unknown;
    const input: UnivariateCrsChunkInput = {
      manifest,
      async loadChunk(relativePath) {
        return new Uint8Array(await readFile(path.join(runtimeRoot, relativePath)));
      },
    };
    const parsed = await parseUnivariatePreprocessCrs(input);
    if ((await parsed.s0.readElements(0, 2)).byteLength !== 192) {
      throw new Error("Canonical CRS conversion did not preserve the S0 chunk shape.");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createFixture(g1: Uint8Array, g2: Uint8Array, corruptS0 = false): UnivariateCrsChunkInput {
  const chunks = new Map<string, Uint8Array>();
  const sectionValues = new Map<string, Uint8Array>([
    ["crs.s0", concat(g1, g1)],
    ["crs.sxi", concat(g1, g1)],
    ["crs.spsi", concat(g1, g1)],
    ["crs.public-query-keys", u32(0, 1)],
    ["crs.public-queries", g1],
    ["crs.interface-query-keys", u32(0, 0, 2)],
    ["crs.interface-queries", g1],
    ["crs.internal-query-keys", u32(1, 0, 3)],
    ["crs.internal-queries", g1],
    ["crs.mask-u", concat(g1, g1)],
    ["crs.mask-v", concat(g1, g1)],
    ["crs.mask-w", concat(g1, g1)],
    ["crs.mask-b", concat(g1, g1)],
    ["crs.binding-sources", concat(g1, g1)],
    ["crs.g1-handles", concat(g1, g1, g1)],
    ["crs.g2", concat(g2, g2, g2, g2, g2, g2)],
  ]);
  const sections = UNIVARIATE_CRS_CHUNK_CONTRACT.sections.map((contract, index) => {
    const bytes = sectionValues.get(contract.label);
    if (bytes === undefined) throw new Error(`Test fixture is missing ${contract.label}.`);
    const path = `chunks/${index}.bin`;
    chunks.set(path, corruptS0 && contract.label === "crs.s0" ? bytes.map((value, byteIndex) => byteIndex === 0 ? value ^ 1 : value) : bytes);
    return {
      label: contract.label,
      encoding: contract.encoding,
      elementCount: bytes.byteLength / contract.elementByteLength,
      elementByteLength: contract.elementByteLength,
      chunks: [{
        path,
        firstElement: 0,
        elementCount: bytes.byteLength / contract.elementByteLength,
        byteLength: bytes.byteLength,
        sha256: hex(sha256(bytes)),
      }],
    };
  });
  return {
    manifest: {
      schemaId: UNIVARIATE_CRS_CHUNK_CONTRACT.schemaId,
      sourceSchemaId: UNIVARIATE_CRS_CHUNK_CONTRACT.sourceSchemaId,
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      sourceRkyvSha256: {
        tauSequence: "00".repeat(32),
        proverKeys: "11".repeat(32),
        verifierKeys: "22".repeat(32),
      },
      declaredCapacity: [1, 1, 1],
      k: 1,
      sections,
    },
    async loadChunk(relativePath) {
      const bytes = chunks.get(relativePath);
      if (bytes === undefined) throw new Error(`Missing test chunk ${relativePath}.`);
      return bytes;
    },
  };
}

function u32(...values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function expectRejects(run: () => Promise<unknown>, expected: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expected)) return;
    throw error;
  }
  throw new Error(`Expected rejection containing ${JSON.stringify(expected)}.`);
}

await main();
