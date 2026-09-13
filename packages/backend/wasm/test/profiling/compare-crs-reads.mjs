import assert from 'node:assert/strict';
import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';

const fixture = path.resolve(process.argv[2]);
const root = path.join(fixture, 'chunks');
const original = JSON.parse(await readFile(path.join(root, 'univariate-crs-manifest.json'), 'utf8'));
const setup = JSON.parse(await readFile(path.join(fixture, 'inputs/subcircuits/library/setupParams.json'), 'utf8'));
const infos = JSON.parse(await readFile(path.join(fixture, 'inputs/subcircuits/library/subcircuitInfo.json'), 'utf8'));
const selector = JSON.parse(await readFile(path.join(fixture, 'inputs/synthesizer/selector.json'), 'utf8'));
const counts = infos.map(info => info.flattenMap.filter(g => g >= setup.l).length);
const total = counts.reduce((a, b) => a + b, 0);
const binding = selector.flatMap((id, i) => id === -1 || !counts[id] ? [] : [['crs.nonpublic-queries', i * total + counts.slice(0, id).reduce((a,b) => a+b,0), counts[id]]]);
// A separate repeated-sequence trace tests retained-byte reuse, not a whole proof.
const sequence = Array.from({ length: 3 }, () => ['crs.s0', 'crs.sxi', 'crs.spsi'].map(label => [label, 0, setup.n * setup.s_max + 2])).flat();
const expected = new Map();
for (const variant of ['baseline', 'view', 'cache16', '1MiB', '256KiB']) {
  const { outputFiles } = await build({ entryPoints: ['src/univariate/chunked-crs.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'reader-experiment-only', setup(b) { b.onLoad({ filter: /\/chunked-crs\.ts$/ }, async args => {
      let contents = (await readFile(args.path, 'utf8')).replace(/this\.#entries\.size > \d+/, 'this.#entries.size > 2');
      if (variant === 'cache16') contents = contents.replace('this.#entries.size > 2', 'this.#entries.size > 16');
      if (variant === 'view') contents = contents.replace('    const output = new Uint8Array(elementCount * this.elementByteLength);', `
        const single = this.#chunks.find(chunk => firstElement >= chunk.firstElement && firstElement + elementCount <= chunk.firstElement + chunk.elementCount);
        if (single && elementCount > 0) { const bytes = await this.#cache.load(single); const offset = (firstElement - single.firstElement) * this.elementByteLength; return bytes.subarray(offset, offset + elementCount * this.elementByteLength); }
        const output = new Uint8Array(elementCount * this.elementByteLength);`);
      return { contents, loader: 'ts' };
    }); } }],
  });
  const { admitUnivariateCrsChunks } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));
  const manifest = structuredClone(original), sources = new Map();
  for (const section of manifest.sections) {
    const smaller = section.label === 'crs.nonpublic-queries' && ['1MiB', '256KiB'].includes(variant);
    const maxCount = smaller ? Math.floor((variant === '1MiB' ? 1048576 : 262144) / section.elementByteLength) : Infinity;
    section.chunks = section.chunks.flatMap(chunk => {
      const parts = [];
      for (let first = 0; first < chunk.elementCount; first += maxCount) {
        const count = Math.min(maxCount, chunk.elementCount - first);
        const key = `${chunk.path}.part-${first}`;
        sources.set(key, { file: path.join(root, chunk.path), offset: first * section.elementByteLength, bytes: count * section.elementByteLength });
        parts.push({ ...chunk, path: key, firstElement: chunk.firstElement + first, elementCount: count, byteLength: count * section.elementByteLength });
      }
      return parts;
    });
  }
  for (const [name, requests] of [['binding', binding], ['repeated-sequences', sequence]]) {
    const samples = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      let loadedBytes = 0, loads = 0;
      const begin = performance.now();
      const reader = admitUnivariateCrsChunks({ manifest, loadChunk: async key => {
        const source = sources.get(key), file = await open(source.file, 'r');
        try {
          const bytes = new Uint8Array(source.bytes);
          let offset = 0;
          while (offset < bytes.length) { const r = await file.read(bytes, offset, bytes.length - offset, source.offset + offset); assert(r.bytesRead > 0); offset += r.bytesRead; }
          loadedBytes += bytes.length; loads++;
          return bytes;
        } finally { await file.close(); }
      } }, 'prover', false);
      const outputs = [];
      for (const [label, first, count] of requests) outputs.push(await reader.requireSection(label).readElements(first, count));
      const ms = performance.now() - begin;
      // Digest after timing is an equivalence oracle, not a runtime integrity mode.
      const h = createHash('sha256'); for (const out of outputs) h.update(out);
      const outputDigest = h.digest('hex');
      if (!expected.has(name)) expected.set(name, outputDigest);
      assert.equal(outputDigest, expected.get(name));
      samples.push({ ms, loadedBytes, loads, outputDigest });
    }
    console.log(JSON.stringify({ variant, trace: name, requests: requests.length, samples }));
  }
}
