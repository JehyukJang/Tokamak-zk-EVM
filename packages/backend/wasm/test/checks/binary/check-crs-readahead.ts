import assert from "node:assert/strict";
import { SHA256, sha256 } from "@noble/hashes/sha256";
import { admitUnivariateCrsChunks } from "../../../src/univariate/chunked-crs.js";
import { UNIVARIATE_CRS_CHUNK_CONTRACT as contract } from "../../../src/generated/univariate-crs-chunk-contract.generated.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../../src/version.js";

const files = new Map<string, Uint8Array>();
const sections = contract.sections.map((spec, i) => {
  const count = "elementCount" in spec ? spec.elementCount : 32;
  const chunks = [];
  for (let first = 0; first < count; first += 4) {
    const n = Math.min(4, count - first), path = `chunks/${i}-${first}.bin`;
    const bytes = Uint8Array.from({ length: n * spec.elementByteLength }, (_, j) => (j + first) % 251);
    files.set(path, bytes);
    chunks.push({ path, firstElement: first, elementCount: n, byteLength: bytes.length, sha256: Buffer.from(sha256(bytes)).toString("hex") });
  }
  return { ...spec, elementCount: count, chunks };
});
const manifest = { schemaId: contract.schemaId, sourceSchemaId: contract.sourceSchemaId, sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
  sourceRkyvSha256: { tauSequence: "11".repeat(32), proverKeys: "22".repeat(32), preprocessKeys: "33".repeat(32), verifierKeys: "44".repeat(32) }, sections };
const spec = sections.find(s => s.label === "crs.preprocess-sc")!;
const expected = new Uint8Array(Buffer.concat(spec.chunks.map(c => files.get(c.path)!)));
const read = (loadChunk: (path: string) => Promise<Uint8Array>, checked = false) => admitUnivariateCrsChunks({ manifest, loadChunk }, "preprocess", checked).requireSection(spec.label);
const immediate = async (path: string) => files.get(path)!;
for (const checked of [false, true]) {
  const reader = read(immediate, checked);
  assert.deepEqual(await reader.readElements(0, 32), expected);
  assert.deepEqual(await reader.readElements(3, 22), expected.slice(3 * 96, 25 * 96));
  const strided = new Uint8Array(Buffer.concat(Array.from({ length: 10 }, (_, i) => expected.slice(i * 3 * 96, (i * 3 + 1) * 96))));
  assert.deepEqual(await reader.readStridedElements(0, 3, 10), strided);
  assert.deepEqual(await reader.readElements(32, 0), new Uint8Array());
  assert.deepEqual(await reader.readStridedElements(32, 1, 0), new Uint8Array());
  await assert.rejects(() => reader.readElements(31, 2), /outside CRS section/);
  await assert.rejects(() => reader.readStridedElements(0, 0, 1), /stride/);
}
const update = SHA256.prototype.update;
let hashes = 0;
SHA256.prototype.update = function(value) { hashes++; return update.call(this, value); };
const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error); };
process.on("unhandledRejection", onUnhandled);
try {
  await read(immediate).readElements(0, 32); assert.equal(hashes, 0);
  await read(immediate, true).readElements(0, 32); assert.equal(hashes, 8);
  hashes = 0;
  const fetched: string[] = [];
  const broken = read(async path => {
    fetched.push(path);
    if (path === spec.chunks[0]!.path) throw new Error("first read failed");
    if (path === spec.chunks[1]!.path) throw new Error("prefetched read failed");
    return files.get(path)!;
  }, true);
  await assert.rejects(() => broken.readElements(0, 32), /first read failed/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(fetched, spec.chunks.slice(0, 2).map(c => c.path));
  assert.equal(hashes, 0, "An unused prefetched chunk must not be hashed.");
  assert.deepEqual(unhandled, []);
  await assert.rejects(() => broken.readElement(4), /prefetched read failed/);
  assert.equal(fetched.length, 2, "The original prefetched failure must reach its consumer.");
  for (const checked of [false, true]) {
    await assert.rejects(() => read(async () => new Uint8Array(), checked).readElements(0, 32), /invalid byte length/);
  }
  await assert.rejects(() => read(async path => files.get(path)!.map(x => x ^ 1), true).readElements(0, 32), /digest mismatch/);
} finally { SHA256.prototype.update = update; process.off("unhandledRejection", onUnhandled); }

const samples = [];
for (let i = 0; i < 5; i++) for (const candidate of i % 2 ? [true, false] : [false, true]) {
  let active = 0, peak = 0, loads = 0;
  const reader = read(async path => {
    loads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 3)); active--; return files.get(path)!;
  });
  const start = performance.now();
  const actual = candidate ? await reader.readElements(0, 32) : new Uint8Array(Buffer.concat(await (async () => {
    const parts = []; for (let first = 0; first < 32; first += 4) parts.push(await reader.readElements(first, 4)); return parts;
  })()));
  samples.push({ candidate, ms: performance.now() - start, loads, peak });
  assert.deepEqual(actual, expected); assert.equal(loads, 8); assert.equal(peak, candidate ? 2 : 1);
}
console.log(JSON.stringify({ artificialLoadDelayMs: 3, chunks: 8, samples }));
console.log("Checked bounded requested-range readahead, contiguous/strided order, digest-off/on and consumed/unconsumed failures.");
