#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectReleaseReproducibilityFailures,
  PINNED_NODE_VERSION,
  PINNED_NPM_VERSION,
  PINNED_RUST_VERSION,
  REQUIRED_RELEASE_FILES,
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

runTest('rejects a floating Rust toolchain', fixtureRoot => {
  replace(fixtureRoot, 'rust-toolchain.toml', 'channel = "1.95.0"', 'channel = "stable"');
  assert.match(failures(fixtureRoot), /must pin channel 1\.95\.0/u);
});

runTest('rejects a noncanonical npm lock format', fixtureRoot => {
  replace(fixtureRoot, 'package-lock.json', '"lockfileVersion": 3', '"lockfileVersion": 2');
  assert.match(failures(fixtureRoot), /package-lock\.json must use npm lockfileVersion 3/u);
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
    for (const relativePath of REQUIRED_RELEASE_FILES) {
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
