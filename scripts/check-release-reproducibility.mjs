#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_WORKSPACE_PACKAGE_NAMES } from './version-targets.mjs';

export const PINNED_RUST_VERSION = '1.95.0';
export const PINNED_NODE_VERSION = '24.20.0';
export const PINNED_NPM_VERSION = '11.19.0';
export const PINNED_CIRCOM_VERSION = '2.2.3';
export const REQUIRED_LOCKFILES = Object.freeze([
  'package-lock.json',
  'packages/frontend/qap-compiler/package-lock.json',
  'packages/frontend/synthesizer/package-lock.json',
  'packages/frontend/synthesizer/node-cli/package-lock.json',
  'packages/frontend/synthesizer/web-app/package-lock.json',
  'packages/backend/wasm/package-lock.json',
  'packages/backend/Cargo.lock',
]);
export const POLICY_SURFACES = Object.freeze([
  '.gitignore',
  'rust-toolchain.toml',
  'package.json',
  'packages/frontend/qap-compiler/package.json',
  'packages/frontend/qap-compiler/scripts/qap-compiler.mjs',
  'packages/frontend/qap-compiler/scripts/dist-package.mjs',
  'scripts/check-subcircuit-library-reproducibility.mjs',
  'docs/version-rules.md',
  '.github/workflows/build-release.yml',
  '.github/workflows/publish-tokamak-zk-evm.yml',
  'packages/backend/.vscode/launch.json',
  'packages/backend/wasm/test/checks/fixtures/check-native-verifier-fixture.ts',
  'packages/cli/src/runtime/native.ts',
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

  for (const relativePath of [...REQUIRED_LOCKFILES, ...POLICY_SURFACES]) {
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

  const gitignore = read('.gitignore');
  if (!/^Cargo\.lock$/mu.test(gitignore) || !/^!packages\/backend\/Cargo\.lock$/mu.test(gitignore)) {
    fail('.gitignore must ignore nested Cargo locks while tracking packages/backend/Cargo.lock.');
  }

  const rootVersion = JSON.parse(read('package.json')).version;
  const backendLock = read('packages/backend/Cargo.lock');
  for (const packageName of BACKEND_WORKSPACE_PACKAGE_NAMES) {
    const packageBlock = new RegExp(
      `\\[\\[package\\]\\]\\n(?:(?!\\n\\[\\[package\\]\\])[\\s\\S])*?^name = "${packageName}"$(?:(?!\\n\\[\\[package\\]\\])[\\s\\S])*?^version = "([^"]+)"$`,
      'mu',
    ).exec(backendLock);
    if (packageBlock?.[1] !== rootVersion) {
      fail(`packages/backend/Cargo.lock must contain ${packageName}@${rootVersion}.`);
    }
  }

  for (const relativePath of REQUIRED_LOCKFILES.filter(file => file.endsWith('package-lock.json'))) {
    const lock = JSON.parse(read(relativePath));
    if (lock.lockfileVersion !== 3) {
      fail(`${relativePath} must use npm lockfileVersion 3.`);
    }
  }

  const buildWorkflow = read('.github/workflows/build-release.yml');
  const controllerWorkflow = read('.github/workflows/publish-tokamak-zk-evm.yml');
  for (const [relativePath, workflow] of [
    ['.github/workflows/build-release.yml', buildWorkflow],
    ['.github/workflows/publish-tokamak-zk-evm.yml', controllerWorkflow],
  ]) {
    const nodeSetups = [...workflow.matchAll(/node-version:\s*['"]?([^'"\s]+)/gu)];
    for (const match of nodeSetups) {
      if (match[1] !== PINNED_NODE_VERSION) {
        fail(`${relativePath} must use Node.js ${PINNED_NODE_VERSION}, found ${match[1]}.`);
      }
    }
    const npmPins = workflow.match(new RegExp(`npm@${PINNED_NPM_VERSION.replaceAll('.', '\\.')}`, 'gu')) ?? [];
    if (npmPins.length !== nodeSetups.length) {
      fail(`${relativePath} must install npm ${PINNED_NPM_VERSION} after every Node.js setup.`);
    }
    if (workflow.includes('dtolnay/rust-toolchain@stable')) {
      fail(`${relativePath} must not resolve the floating Rust stable channel.`);
    }
    if (workflow.includes('npm install --package-lock=false')) {
      fail(`${relativePath} must not bypass committed npm locks.`);
    }
    const circomPins = [
      ...workflow.matchAll(/QAP_COMPILER_EXPECTED_CIRCOM_VERSION:\s*['"]?([^'"\s]+)/gu),
    ];
    if (circomPins.length === 0 || circomPins.some(match => match[1] !== PINNED_CIRCOM_VERSION)) {
      fail(`${relativePath} must require Circom ${PINNED_CIRCOM_VERSION}.`);
    }
    if (!workflow.includes(`--tag v${PINNED_CIRCOM_VERSION} circom`)) {
      fail(`${relativePath} must install Circom ${PINNED_CIRCOM_VERSION}.`);
    }
    if (!workflow.includes(`circom compiler ${PINNED_CIRCOM_VERSION}`)) {
      fail(`${relativePath} must verify Circom ${PINNED_CIRCOM_VERSION}.`);
    }
    for (const line of workflow.split('\n')) {
      if (/\bcargo\s+(?:build|check|run|test|bench|install)\b/u.test(line) && !line.includes('--locked')) {
        fail(`${relativePath} contains an unlocked Cargo command: ${line.trim()}`);
      }
    }
  }
  if (
    !buildWorkflow.includes(`node-version: '${PINNED_NODE_VERSION}'`) ||
    !buildWorkflow.includes(`npm@${PINNED_NPM_VERSION}`) ||
    !buildWorkflow.includes('run: npm ci')
  ) {
    fail(`The pull-request source build must use Node.js ${PINNED_NODE_VERSION}, npm ${PINNED_NPM_VERSION}, and npm ci.`);
  }
  if (!buildWorkflow.includes(`dtolnay/rust-toolchain@${PINNED_RUST_VERSION}`)) {
    fail(`The pull-request source build must install Rust ${PINNED_RUST_VERSION}.`);
  }
  if (!buildWorkflow.includes('npm run release:reproducibility:check')) {
    fail('The pull-request source build must execute the release reproducibility check.');
  }
  for (const [relativePath, workflow] of [
    ['.github/workflows/build-release.yml', buildWorkflow],
    ['.github/workflows/publish-tokamak-zk-evm.yml', controllerWorkflow],
  ]) {
    if (!workflow.includes('npm run subcircuit-library:reproducibility:check')) {
      fail(`${relativePath} must check the canonical subcircuit-library surface before building release artifacts.`);
    }
  }
  if (!controllerWorkflow.includes('npm ci --ignore-scripts')) {
    fail('The browser production jobs must use the committed standalone npm lock with npm ci.');
  }
  if (!controllerWorkflow.includes(`dtolnay/rust-toolchain@${PINNED_RUST_VERSION}`)) {
    fail(`The fixed release controller must install Rust ${PINNED_RUST_VERSION} for candidate validation.`);
  }
  if (!controllerWorkflow.includes('npm run release:reproducibility:check')) {
    fail('The fixed release controller must execute the reproducibility policy against the candidate.');
  }
  if (!buildWorkflow.includes('run: ./download-ICICLE-lib.sh')) {
    fail('The pull-request source build must install the ICICLE CPU runtime before generating a local verifier key.');
  }
  if (!buildWorkflow.includes('cargo run --locked --release -p trusted-setup --')) {
    fail('The pull-request source build must generate a local verifier key before checking the backend workspace.');
  }
  if (!buildWorkflow.includes('TOKAMAK_VERIFIER_KEYS: ${{ runner.temp }}/tokamak-development-crs/verifier_keys.rkyv')) {
    fail('The pull-request source build must provide the generated verifier key to the backend workspace check.');
  }

  const launchConfiguration = read('packages/backend/.vscode/launch.json');
  for (const line of launchConfiguration.split('\n')) {
    if (/"args": \["(?:build|test)"/u.test(line) && !line.includes('"--locked"')) {
      fail(`packages/backend/.vscode/launch.json contains an unlocked Cargo launch: ${line.trim()}`);
    }
  }

  requirePattern(
    'packages/backend/wasm/test/checks/fixtures/check-native-verifier-fixture.ts',
    /const args = \[\s*'run',\s*'--locked'/su,
    'the native fixture verification build must be locked',
  );
  requirePattern(
    'packages/cli/src/runtime/native.ts',
    /return \[\s*'build',\s*'--locked'/su,
    'packaged backend production builds must be locked',
  );
  requireFragment(
    'packages/frontend/qap-compiler/package.json',
    '"publish": "npm ci --workspaces=false',
    'the subcircuit-library release script must use its committed lock',
  );
  for (const relativePath of [
    'packages/frontend/qap-compiler/scripts/qap-compiler.mjs',
    'packages/frontend/qap-compiler/scripts/dist-package.mjs',
  ]) {
    requireFragment(
      relativePath,
      `const expectedCircomVersion = '${PINNED_CIRCOM_VERSION}';`,
      `the local subcircuit-library build must require Circom ${PINNED_CIRCOM_VERSION}`,
    );
  }
  requireFragment(
    'docs/version-rules.md',
    `Circom\n  \`${PINNED_CIRCOM_VERSION}\`, and committed locks.`,
    `the release policy must record Circom ${PINNED_CIRCOM_VERSION}`,
  );
  return failures;

  function requireFragment(relativePath, fragment, description) {
    if (!read(relativePath).includes(fragment)) fail(`${relativePath}: ${description}.`);
  }

  function requirePattern(relativePath, pattern, description) {
    if (!pattern.test(read(relativePath))) fail(`${relativePath}: ${description}.`);
  }
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
