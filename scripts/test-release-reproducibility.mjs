#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectReleaseReproducibilityFailures,
  PINNED_CIRCOM_VERSION,
  PINNED_NODE_VERSION,
  PINNED_NPM_VERSION,
  PINNED_RUST_VERSION,
  POLICY_SURFACES,
  REQUIRED_LOCKFILES,
} from './check-release-reproducibility.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validVersions = {
  rustcVersion: `rustc ${PINNED_RUST_VERSION} (test fixture)`,
  cargoVersion: `cargo ${PINNED_RUST_VERSION} (test fixture)`,
  nodeVersion: `v${PINNED_NODE_VERSION}`,
  npmVersion: PINNED_NPM_VERSION,
};

runTest('accepts the committed reproducibility policy', fixtureRoot => {
  assert.deepEqual(collectReleaseReproducibilityFailures(fixtureRoot, validVersions), []);
});

runTest('rejects a missing backend workspace lock', fixtureRoot => {
  fs.rmSync(path.join(fixtureRoot, 'packages/backend/Cargo.lock'));
  assert.match(failures(fixtureRoot), /packages\/backend\/Cargo\.lock is required/u);
});

runTest('rejects an unsynchronized backend-interface lock entry', fixtureRoot => {
  replace(
    fixtureRoot,
    'packages/backend/Cargo.lock',
    'name = "backend-interface"\nversion = "2.1.5"',
    'name = "backend-interface"\nversion = "2.1.4"',
  );
  assert.match(failures(fixtureRoot), /backend-interface@2\.1\.5/u);
});

runTest('rejects a floating Rust toolchain', fixtureRoot => {
  replace(fixtureRoot, 'rust-toolchain.toml', 'channel = "1.95.0"', 'channel = "stable"');
  assert.match(failures(fixtureRoot), /must pin channel 1\.95\.0/u);
});

runTest('rejects an npm install that bypasses the committed lock', fixtureRoot => {
  replace(fixtureRoot, '.github/workflows/build-release.yml', 'run: npm ci', 'run: npm install --package-lock=false');
  assert.match(failures(fixtureRoot), /must not bypass committed npm locks/u);
});

runTest('rejects a different Circom release', fixtureRoot => {
  replace(
    fixtureRoot,
    '.github/workflows/build-release.yml',
    `QAP_COMPILER_EXPECTED_CIRCOM_VERSION: '${PINNED_CIRCOM_VERSION}'`,
    "QAP_COMPILER_EXPECTED_CIRCOM_VERSION: '2.2.2'",
  );
  assert.match(failures(fixtureRoot), new RegExp(`must require Circom ${PINNED_CIRCOM_VERSION.replaceAll('.', '\\.')}`, 'u'));
});

runTest('rejects an unlocked Cargo build', fixtureRoot => {
  replace(
    fixtureRoot,
    '.github/workflows/build-release.yml',
    'cargo check --workspace --locked',
    'cargo check --workspace',
  );
  assert.match(failures(fixtureRoot), /contains an unlocked Cargo command/u);
});

runTest('rejects a workspace check without its generated verifier key', fixtureRoot => {
  replace(
    fixtureRoot,
    '.github/workflows/build-release.yml',
    'TOKAMAK_VERIFIER_KEYS: ${{ runner.temp }}/tokamak-development-crs/verifier_keys.rkyv',
    'TOKAMAK_VERIFIER_KEYS: ',
  );
  assert.match(failures(fixtureRoot), /must provide the generated verifier key/u);
});

runTest('rejects release workflows without canonical library reproducibility admission', fixtureRoot => {
  replace(
    fixtureRoot,
    '.github/workflows/build-release.yml',
    'run: npm run subcircuit-library:reproducibility:check',
    'run: true',
  );
  assert.match(failures(fixtureRoot), /must check the canonical subcircuit-library surface/u);
});

runTest('rejects a different compiler release', fixtureRoot => {
  const result = collectReleaseReproducibilityFailures(fixtureRoot, {
    rustcVersion: 'rustc 1.96.0 (test fixture)',
    cargoVersion: 'cargo 1.96.0 (test fixture)',
    nodeVersion: `v${PINNED_NODE_VERSION}`,
    npmVersion: PINNED_NPM_VERSION,
  });
  assert.match(result.join('\n'), /rustc must be 1\.95\.0/u);
  assert.match(result.join('\n'), /cargo must be 1\.95\.0/u);
});

runTest('rejects different Node.js and npm releases', fixtureRoot => {
  const result = collectReleaseReproducibilityFailures(fixtureRoot, {
    rustcVersion: `rustc ${PINNED_RUST_VERSION} (test fixture)`,
    cargoVersion: `cargo ${PINNED_RUST_VERSION} (test fixture)`,
    nodeVersion: 'v24.20.1',
    npmVersion: '11.19.1',
  });
  assert.match(result.join('\n'), /Node\.js must be 24\.20\.0/u);
  assert.match(result.join('\n'), /npm must be 11\.19\.0/u);
});

console.log('[release-reproducibility-test] Negative policy checks passed.');

function runTest(name, body) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokamak-release-reproducibility-'));
  try {
    for (const relativePath of new Set([...REQUIRED_LOCKFILES, ...POLICY_SURFACES])) {
      const source = path.join(repositoryRoot, relativePath);
      const destination = path.join(fixtureRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    body(fixtureRoot);
    console.log(`[release-reproducibility-test] ${name}`);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function failures(fixtureRoot) {
  return collectReleaseReproducibilityFailures(fixtureRoot, validVersions).join('\n');
}

function replace(fixtureRoot, relativePath, from, to) {
  const target = path.join(fixtureRoot, relativePath);
  const original = fs.readFileSync(target, 'utf8');
  assert.ok(original.includes(from), `Fixture ${relativePath} must contain ${from}`);
  fs.writeFileSync(target, original.replace(from, to), 'utf8');
}
