#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectReleaseReproducibilityFailures,
  PINNED_RUST_VERSION,
  POLICY_SURFACES,
  REQUIRED_LOCKFILES,
} from './check-release-reproducibility.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const validVersions = {
  rustcVersion: `rustc ${PINNED_RUST_VERSION} (test fixture)`,
  cargoVersion: `cargo ${PINNED_RUST_VERSION} (test fixture)`,
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

runTest('rejects an unlocked Cargo build', fixtureRoot => {
  replace(
    fixtureRoot,
    '.github/workflows/build-release.yml',
    'cargo check --workspace --locked',
    'cargo check --workspace',
  );
  assert.match(failures(fixtureRoot), /contains an unlocked Cargo command/u);
});

runTest('rejects a different compiler release', fixtureRoot => {
  const result = collectReleaseReproducibilityFailures(fixtureRoot, {
    rustcVersion: 'rustc 1.96.0 (test fixture)',
    cargoVersion: 'cargo 1.96.0 (test fixture)',
  });
  assert.match(result.join('\n'), /rustc must be 1\.95\.0/u);
  assert.match(result.join('\n'), /cargo must be 1\.95\.0/u);
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
