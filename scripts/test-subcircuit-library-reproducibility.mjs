#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectArtifactEntries,
  compareArtifactSurfaces,
  digestEntries,
  sourceDigestForLibrary,
  verifyPinnedToolchain,
} from './check-subcircuit-library-reproducibility.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokamak-subcircuit-reproducibility-test-'));
try {
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const constants = path.join(root, 'constants.circom');
  writeLibrary(first, 'same');
  writeLibrary(second, 'same');
  fs.writeFileSync(constants, 'pragma circom 2.0.0;\n');

  compareArtifactSurfaces(first, second);
  assert.equal(digestEntries(collectArtifactEntries(first)), digestEntries(collectArtifactEntries(second)));
  assert.equal(sourceDigestForLibrary(first, constants), sourceDigestForLibrary(second, constants));

  fs.writeFileSync(path.join(second, 'wasm', 'subcircuit0.wasm'), 'changed');
  assert.throws(() => compareArtifactSurfaces(first, second), /content differs at wasm\/subcircuit0\.wasm/u);
  assert.notEqual(sourceDigestForLibrary(first, constants), sourceDigestForLibrary(second, constants));

  verifyPinnedToolchain({ nodeVersion: 'v24.20.0', circomVersion: 'circom compiler 2.2.3' });
  assert.throws(
    () => verifyPinnedToolchain({ nodeVersion: 'v24.20.1', circomVersion: 'circom compiler 2.2.3' }),
    /Node\.js must be 24\.20\.0/u,
  );
  assert.throws(
    () => verifyPinnedToolchain({ nodeVersion: 'v24.20.0', circomVersion: 'circom compiler 2.2.2' }),
    /Circom must be 2\.2\.3/u,
  );
  console.log('[subcircuit-reproducibility-test] Surface and source-identity checks passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeLibrary(directory, marker) {
  for (const relativePath of [
    'frontendCfg.json',
    'setupParams.json',
    'subcircuitInfo.json',
    'json/subcircuit0.json',
    'r1cs/subcircuit0.r1cs',
    'wasm/subcircuit0.wasm',
    'generate_witness.js',
    'info/ignored.txt',
  ]) {
    const target = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${marker}:${relativePath}`);
  }
}
