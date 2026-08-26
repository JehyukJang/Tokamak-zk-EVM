#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const vendoredBackendRoot = path.join(packageRoot, 'vendor', 'backend');
const packagedVersionPolicyPath = path.join(packageRoot, 'versioning', 'compatibility.rs');
const BACKEND_BINARY_NAMES = ['preprocess', 'prove', 'verify'];

function fail(message) {
  throw new Error(`[packaged-runtime-check] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} exited with code ${result.status ?? 'unknown'}.`);
  }
}

function packedFiles() {
  const output = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const entries = JSON.parse(output);
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]?.files)) {
    fail('npm pack --dry-run did not report one package file manifest.');
  }
  return new Set(entries[0].files.map((entry) => entry.path));
}

function assertPackagedVendorTree(files) {
  for (const requiredPath of [
    'vendor/backend/Cargo.toml',
    'versioning/compatibility.rs',
  ]) {
    if (!fs.existsSync(path.join(packageRoot, requiredPath))) {
      fail(`Prepared package tree is missing ${requiredPath}.`);
    }
    if (!files.has(requiredPath)) {
      fail(`npm package is missing ${requiredPath}.`);
    }
  }
}

async function main() {
  assertPackagedVendorTree(packedFiles());
  if (!fs.existsSync(packagedVersionPolicyPath)) {
    fail(`Packaged version-policy source is missing: ${packagedVersionPolicyPath}`);
  }

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokamak-cli-packaged-runtime-'));
  try {
    const { backendProductionBuildArgs, validateProductionBuildMetadata } = require('../dist/runtime/native.js');
    for (const packageName of BACKEND_BINARY_NAMES) {
      run('cargo', backendProductionBuildArgs(packageName), {
        cwd: vendoredBackendRoot,
        env: { ...process.env, CARGO_TARGET_DIR: targetRoot },
      });
    }
    await validateProductionBuildMetadata(path.join(targetRoot, 'release'));
    run(process.execPath, ['--test', 'tests/setup.test.cjs']);
  } finally {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
