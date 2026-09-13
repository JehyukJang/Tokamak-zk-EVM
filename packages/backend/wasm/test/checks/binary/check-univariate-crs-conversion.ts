import assert from "node:assert/strict";import { sha256 } from "@noble/hashes/sha256";
import { UNIVARIATE_CRS_CHUNK_CONTRACT as contract } from "../../../src/generated/univariate-crs-chunk-contract.generated.js";
import { parseUnivariatePreprocessCrs, parseUnivariateProverCrs } from "../../../src/univariate/crs.js";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../../src/version.js";
const runtime = await createCurveRuntime();
try {
  const chunks = new Map<string, Uint8Array>();
  const sections = contract.sections.map((spec, i) => {
    const count = "elementCount" in spec ? spec.elementCount : 3;
    const point = spec.elementByteLength === 192 ? runtime.G2.generator : runtime.G1.generator;
    const data = new Uint8Array(count * spec.elementByteLength);
    for(let j = 0; j < count; j++)
      data.set(point, j * spec.elementByteLength);
    const path = `chunks/${i}.bin`;
    chunks.set(path, data);
    return { ...spec, elementCount: count, chunks: [{ path, firstElement: 0, elementCount: count, byteLength: data.length, sha256: Buffer.from(sha256(data)).toString("hex") }] };
  });
  const manifest = {
    schemaId: contract.schemaId, sourceSchemaId: contract.sourceSchemaId, sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
    sourceRkyvSha256: { tauSequence: "00".repeat(32), proverKeys: "11".repeat(32), preprocessKeys: "22".repeat(32), verifierKeys: "33".repeat(32) }, sections
  };
  const input = { manifest, loadChunk: async (name: string) => chunks.get(name)! };
  const pre = await parseUnivariatePreprocessCrs(input), prover = await parseUnivariateProverCrs(input);
  assert(runtime.G1.eq(await pre.sc.readElement(2), runtime.G1.generator));
  assert(runtime.G2.eq(await pre.selection.readElement(0), runtime.G2.generator));
  assert(runtime.G1.eq(prover.maskSelection, runtime.G1.generator));
  assert.equal(prover.nonpublic.elementCount, 3);
  const bad = structuredClone(manifest);
  bad.sections[0]!.label = "unknown" as typeof bad.sections[0]["label"];
  await assert.rejects(() => parseUnivariatePreprocessCrs({ ...input, manifest: bad }), /unsupported section/);
  await assert.rejects(() => parseUnivariatePreprocessCrs({ ...input, manifest: { ...manifest, sections: sections.slice(1) } }), /complete backend section set/);
  const loaded = await parseUnivariatePreprocessCrs({ ...input, loadChunk: async (name) => chunks.get(name)!.map(b => b ^ 1) });
  await assert.rejects(() => loaded.sc.readElement(0), /digest mismatch/);
  await assert.rejects(() => pre.sc.readElement(3), /outside CRS section/);
  const malformed = structuredClone(manifest);
  malformed.sections[0]!.chunks[0]!.firstElement = 1;
  await assert.rejects(() => parseUnivariateProverCrs({ ...input, manifest: malformed }), /non-contiguous/);
}
finally {
  await runtime.terminate();
}
console.log("Checked current role admission, lazy reads, malformed manifests and corrupt chunks.");
