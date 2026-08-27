#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compatibilityFromPackageVersion,
  parseCompatibleBackendVersion,
  parsePackageVersion,
} from './version-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceOnly = process.argv.slice(2).includes('--source-only');

function fail(message) {
  console.error(`[version-check] ${message}`);
  process.exitCode = 1;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function getBackendWorkspaceVersion() {
  const manifest = readText('packages/backend/Cargo.toml');
  const match = /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/u.exec(manifest);
  return match?.[1] ?? null;
}

function getCargoLockPackageVersions() {
  if (!fileExists('packages/backend/Cargo.lock')) {
    return new Map();
  }

  const workspacePackages = new Set(['libs', 'mpc-setup', 'preprocess', 'prove', 'trusted-setup', 'verify']);
  const versions = new Map();
  const lockfile = readText('packages/backend/Cargo.lock');

  for (const block of lockfile.matchAll(/\[\[package\]\]\n([\s\S]*?)(?=\n\[\[package\]\]|\s*$)/gu)) {
    const name = /^name = "([^"]+)"/mu.exec(block[1])?.[1];
    const version = /^version = "([^"]+)"/mu.exec(block[1])?.[1];
    if (name && workspacePackages.has(name)) {
      versions.set(name, version);
    }
  }

  return versions;
}

const rootManifest = readJson('package.json');
const expectedVersion = rootManifest.version;
let expectedCompatibleBackendVersion = null;

try {
  expectedCompatibleBackendVersion = compatibilityFromPackageVersion(expectedVersion);
} catch (error) {
  fail(`Root package.json version ${error.message}`);
}

const packageTargets = [
  'packages/cli/package.json',
  'packages/backend-wasm/package.json',
  'packages/backend-wasm/tools/rkyv-decoder-wasm/package.json',
  'packages/frontend/qap-compiler/package.json',
  'packages/frontend/synthesizer/node-cli/package.json',
  'packages/frontend/synthesizer/web-app/package.json',
];

for (const relativePath of packageTargets) {
  if (!fileExists(relativePath)) {
    continue;
  }
  const manifest = readJson(relativePath);
  if (manifest.version !== expectedVersion) {
    fail(`${relativePath} version is '${manifest.version}', expected '${expectedVersion}'.`);
  }
}

const dependencyTargets = [
  ['packages/cli/package.json', '@tokamak-zk-evm/synthesizer-node', expectedVersion],
  ['packages/backend-wasm/package.json', '@tokamak-zk-evm/subcircuit-library', expectedVersion],
  ['packages/frontend/synthesizer/node-cli/package.json', '@tokamak-zk-evm/subcircuit-library', expectedVersion],
  ['packages/frontend/synthesizer/web-app/package.json', '@tokamak-zk-evm/subcircuit-library', expectedVersion],
  ['packages/backend-wasm/examples/browser/package.json', '@tokamak-zk-evm/snark-browser-compat', expectedVersion],
];

for (const [relativePath, dependencyName, expectedRange] of dependencyTargets) {
  const manifest = readJson(relativePath);
  const actualRange = manifest.dependencies?.[dependencyName];
  if (actualRange !== expectedRange) {
    fail(`${relativePath} dependency ${dependencyName} is '${actualRange}', expected '${expectedRange}'.`);
  }
}

const lockfileTargets = [
  ['package-lock.json', '', expectedVersion],
  ['package-lock.json', 'packages/cli', expectedVersion],
  ['package-lock.json', 'packages/frontend/qap-compiler', expectedVersion],
  ['package-lock.json', 'packages/frontend/synthesizer/node-cli', expectedVersion],
  ['package-lock.json', 'packages/frontend/synthesizer/web-app', expectedVersion],
  ['packages/backend-wasm/package-lock.json', '', expectedVersion],
  ['packages/frontend/qap-compiler/package-lock.json', '', expectedVersion],
  ['packages/frontend/synthesizer/package-lock.json', 'node-cli', expectedVersion],
  ['packages/frontend/synthesizer/package-lock.json', 'web-app', expectedVersion],
  ['packages/frontend/synthesizer/node-cli/package-lock.json', '', expectedVersion],
  ['packages/frontend/synthesizer/web-app/package-lock.json', '', expectedVersion],
];

if (!sourceOnly) {
  for (const [relativePath, packageKey, expectedPackageVersion] of lockfileTargets) {
    if (!fileExists(relativePath)) {
      continue;
    }
    const lockfile = readJson(relativePath);
    const packageEntry = lockfile.packages?.[packageKey];
    const actualVersion = packageKey === '' ? (packageEntry?.version ?? lockfile.version) : packageEntry?.version;
    if (actualVersion !== expectedPackageVersion) {
      fail(
        `${relativePath} package entry '${packageKey}' is '${actualVersion}', expected '${expectedPackageVersion}'.`,
      );
    }
  }

  const backendWasmPackageLock = readJson('packages/backend-wasm/package-lock.json');
  const backendWasmLockDependency =
    backendWasmPackageLock.packages?.['']?.dependencies?.['@tokamak-zk-evm/subcircuit-library'];
  if (backendWasmLockDependency !== expectedVersion) {
    fail(
      `packages/backend-wasm/package-lock.json dependency @tokamak-zk-evm/subcircuit-library is '${backendWasmLockDependency}', expected '${expectedVersion}'.`,
    );
  }

  const backendWasmResolvedSubcircuitVersion =
    backendWasmPackageLock.packages?.['node_modules/@tokamak-zk-evm/subcircuit-library']?.version;
  if (backendWasmResolvedSubcircuitVersion !== expectedVersion) {
    fail(
      `packages/backend-wasm/package-lock.json resolved @tokamak-zk-evm/subcircuit-library is '${backendWasmResolvedSubcircuitVersion ?? 'missing'}', expected '${expectedVersion}'.`,
    );
  }
}

const backendWasmVersionModule = readText('packages/backend-wasm/src/version.ts');
const backendWasmVersionMatch = /BACKEND_WASM_PACKAGE_VERSION\s*=\s*"([^"]+)"/u.exec(backendWasmVersionModule);
if (backendWasmVersionMatch?.[1] !== expectedVersion) {
  fail(
    `packages/backend-wasm/src/version.ts package version is '${backendWasmVersionMatch?.[1] ?? 'missing'}', expected '${expectedVersion}'.`,
  );
}

// backend-wasm active generated inputs are ignored, mode-specific build
// products. Its build and generated-input checks own their version validation;
// the repository source policy must remain valid in a fresh checkout.

const backendVersion = getBackendWorkspaceVersion();
if (backendVersion !== expectedVersion) {
  fail(`packages/backend/Cargo.toml workspace version is '${backendVersion}', expected '${expectedVersion}'.`);
}

const cliManifest = readJson('packages/cli/package.json');
const compatibleBackendVersion = cliManifest.tokamakZkEvm?.compatibleBackendVersion;

try {
  parseCompatibleBackendVersion(compatibleBackendVersion);
} catch (error) {
  fail(`packages/cli/package.json tokamakZkEvm.compatibleBackendVersion ${error.message}`);
}
if (compatibleBackendVersion !== expectedCompatibleBackendVersion) {
  fail(
    `packages/cli/package.json tokamakZkEvm.compatibleBackendVersion is '${compatibleBackendVersion}', expected '${expectedCompatibleBackendVersion}' from package version '${expectedVersion}'.`,
  );
}

if (!sourceOnly) {
  for (const [name, version] of getCargoLockPackageVersions()) {
    if (version !== expectedVersion) {
      fail(`packages/backend/Cargo.lock package ${name} is '${version}', expected '${expectedVersion}'.`);
    }
  }
}

if (!sourceOnly) {
  if (!fileExists('CHANGELOG.md')) {
    fail('Root CHANGELOG.md is missing.');
  } else {
    const changelog = readText('CHANGELOG.md');
    if (
      !new RegExp(`^## \\[${expectedVersion.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'mu').test(changelog)
    ) {
      fail(`Root CHANGELOG.md must contain a release entry for ${expectedVersion}.`);
    }
  }
}

if (process.exitCode) {
  process.exit();
}

console.log(
  sourceOnly
    ? `[version-check] Source version is synchronized at ${expectedVersion}; lockfiles and generated artifacts are intentionally excluded.`
    : `[version-check] Repository release version is synchronized at ${expectedVersion}.`,
);
