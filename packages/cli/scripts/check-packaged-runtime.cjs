#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const vendoredBackendRoot = path.join(packageRoot, 'vendor', 'backend');
const staticOnly = process.argv.includes('--static-only');

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
    'vendor/backend/cli-vendor-product.json',
    'vendor/backend/versioning/compatibility.rs',
  ]) {
    if (!fs.existsSync(path.join(packageRoot, requiredPath))) {
      fail(`Prepared package tree is missing ${requiredPath}.`);
    }
    if (!files.has(requiredPath)) {
      fail(`npm package is missing ${requiredPath}.`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(vendoredBackendRoot, 'cli-vendor-product.json'), 'utf8'));
  if (manifest?.contractVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.every((file) => typeof file === 'string')) {
    fail('Prepared backend vendor product manifest is invalid.');
  }
  const expected = new Set([
    'vendor/backend/cli-vendor-product.json',
    ...manifest.files.map((file) => `vendor/backend/${file}`),
  ]);
  const actual = new Set([...files].filter((file) => file.startsWith('vendor/backend/')));
  if (expected.size !== actual.size || [...expected].some((file) => !actual.has(file))) {
    fail('npm package backend vendor closure does not match the backend product manifest.');
  }
  if ([...files].some((file) => file === 'versioning' || file.startsWith('versioning/'))) {
    fail('npm package must not contain a CLI-owned top-level versioning payload.');
  }
}

async function main() {
  assertPackagedVendorTree(packedFiles());
  if (staticOnly) {
    return;
  }

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokamak-cli-packaged-runtime-'));
  try {
    const { backendProductionBuildArgs, validateProductionBuildMetadata } = require('../dist/runtime/native.js');
    const { BACKEND_PACKAGE_NAMES } = require('../dist/generated/backend-build-metadata-validator.generated.js');
    for (const packageName of BACKEND_PACKAGE_NAMES) {
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
