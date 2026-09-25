#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_RUST_VERSION = '1.95.0';
export const PINNED_NODE_VERSION = '24.20.0';
export const PINNED_NPM_VERSION = '11.19.0';
export const REQUIRED_RELEASE_FILES = Object.freeze([
  'package-lock.json',
  'packages/frontend/qap-compiler/package-lock.json',
  'packages/frontend/synthesizer/package-lock.json',
  'packages/frontend/synthesizer/node-cli/package-lock.json',
  'packages/frontend/synthesizer/web-app/package-lock.json',
  'packages/backend/wasm/package-lock.json',
  'packages/backend/Cargo.lock',
  'rust-toolchain.toml',
]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function collectReleaseReproducibilityFailures(
  root,
  {
    rustcVersion = commandVersion('rustc'),
    cargoVersion = commandVersion('cargo'),
    nodeVersion = commandVersion('node'),
    npmVersion = commandVersion('npm'),
  } = {},
) {
  const failures = [];
  const fail = message => failures.push(message);
  const absolutePath = relativePath => path.join(root, relativePath);
  const read = relativePath => fs.readFileSync(absolutePath(relativePath), 'utf8');

  for (const relativePath of REQUIRED_RELEASE_FILES) {
    if (!fs.existsSync(absolutePath(relativePath))) {
      fail(`${relativePath} is required by the release reproducibility policy.`);
    }
  }
  if (failures.length > 0) return failures;

  const toolchain = read('rust-toolchain.toml');
  if (!new RegExp(`^channel = "${PINNED_RUST_VERSION.replaceAll('.', '\\.')}"$`, 'mu').test(toolchain)) {
    fail(`rust-toolchain.toml must pin channel ${PINNED_RUST_VERSION}.`);
  }
  if (!rustcVersion.startsWith(`rustc ${PINNED_RUST_VERSION} `)) {
    fail(`rustc must be ${PINNED_RUST_VERSION}, found ${rustcVersion || 'unavailable'}.`);
  }
  if (!cargoVersion.startsWith(`cargo ${PINNED_RUST_VERSION} `)) {
    fail(`cargo must be ${PINNED_RUST_VERSION}, found ${cargoVersion || 'unavailable'}.`);
  }
  if (nodeVersion !== `v${PINNED_NODE_VERSION}`) {
    fail(`Node.js must be ${PINNED_NODE_VERSION}, found ${nodeVersion || 'unavailable'}.`);
  }
  if (npmVersion !== PINNED_NPM_VERSION) {
    fail(`npm must be ${PINNED_NPM_VERSION}, found ${npmVersion || 'unavailable'}.`);
  }

  for (const relativePath of REQUIRED_RELEASE_FILES.filter(file => file.endsWith('package-lock.json'))) {
    const lock = JSON.parse(read(relativePath));
    if (lock.lockfileVersion !== 3) {
      fail(`${relativePath} must use npm lockfileVersion 3.`);
    }
  }

  return failures;
}

function commandVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return '';
  return result.stdout.trim();
}

function checkLockedCargoMetadata(root) {
  const result = spawnSync(
    'cargo',
    ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', 'packages/backend/Cargo.toml'],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    return `packages/backend/Cargo.lock is inconsistent with the workspace manifests.${detail ? ` ${detail}` : ''}`;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = collectReleaseReproducibilityFailures(repositoryRoot);
  if (failures.length === 0) {
    const cargoMetadataFailure = checkLockedCargoMetadata(repositoryRoot);
    if (cargoMetadataFailure) failures.push(cargoMetadataFailure);
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[release-reproducibility] ${failure}`);
    process.exit(1);
  }
  console.log(
    `[release-reproducibility] Locks and release commands are reproducible with Rust/Cargo ${PINNED_RUST_VERSION}.`,
  );
}
