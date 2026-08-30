#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function packedFiles() {
  const output = execFileSync(
    npmCommand(),
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const entries = JSON.parse(output);
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]?.files)) {
    fail('npm pack --dry-run did not report one package file manifest.');
  }
  return new Set(entries[0].files.map((entry) => entry.path));
}

function packPackage(destination) {
  const output = execFileSync(
    npmCommand(),
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  const entries = JSON.parse(output);
  if (entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    fail('npm pack did not create exactly one package archive.');
  }
  const archivePath = path.join(destination, entries[0].filename);
  if (!fs.existsSync(archivePath)) {
    fail(`npm pack did not create ${archivePath}.`);
  }
  return archivePath;
}

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function runInstalledPackageFixture(installedRoot, targetRoot) {
  const packageManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  const compatibleBackendVersion = packageManifest.tokamakZkEvm?.compatibleBackendVersion;
  if (typeof packageManifest.version !== 'string' || typeof compatibleBackendVersion !== 'string') {
    fail('Installed package manifest is missing its version identity.');
  }

  const native = require(path.join(installedRoot, 'dist', 'runtime', 'native.js'));
  const setup = require(path.join(installedRoot, 'dist', 'runtime', 'setup.js'));
  const metadata = require(path.join(installedRoot, 'dist', 'generated', 'backend-build-metadata-validator.generated.js'));
  const provenance = require(path.join(installedRoot, 'dist', 'generated', 'crs-provenance-validator.generated.js'));
  const backendReleaseDir = path.join(targetRoot, 'release');
  const runtimeIdentity = await native.validateProductionBuildMetadata(backendReleaseDir);
  if (runtimeIdentity.length !== metadata.BACKEND_PACKAGE_NAMES.length) {
    fail('Installed backend build metadata did not describe every backend package.');
  }

  const fixtureRoot = await fsp.mkdtemp(path.join(targetRoot, 'installed-fixture-'));
  try {
    const archivePath = path.join(fixtureRoot, 'final-crs.zip');
    const extractedDir = path.join(fixtureRoot, 'extracted');
    const activatedOutputDir = path.join(fixtureRoot, 'runtime', 'resource', 'setup', 'output');
    const artifacts = {
      'combined_sigma.rkyv': 'installed consumer combined sigma',
      'sigma_preprocess.rkyv': 'installed consumer preprocess sigma',
      'sigma_verify.json': 'installed consumer verify sigma',
    };
    const subcircuitLibrary = runtimeIdentity[0]?.dependencies?.subcircuitLibrary;
    if (subcircuitLibrary === undefined) {
      fail('Installed backend build metadata is missing subcircuit-library identity.');
    }
    const finalProvenance = {
      documentKind: 'finalMpcCrs',
      releaseEligible: false,
      generatedAtUtc: '2026-08-29T00:00:00Z',
      compatibleBackendVersion,
      subcircuitLibrary: {
        packageName: subcircuitLibrary.packageName,
        packageVersion: subcircuitLibrary.buildVersion,
        origin: 'npmSnapshot',
      },
      phase1SourceProvenance: null,
      combinedSigmaSha256: sha256(artifacts['combined_sigma.rkyv']),
      sigmaPreprocessSha256: sha256(artifacts['sigma_preprocess.rkyv']),
      sigmaVerifySha256: sha256(artifacts['sigma_verify.json']),
    };

    const archive = new AdmZip();
    for (const fileName of provenance.finalMpcCrsArchiveRootFileNames()) {
      const contents = fileName === provenance.crsProvenanceFileName()
        ? `${JSON.stringify(finalProvenance)}\n`
        : artifacts[fileName];
      if (typeof contents !== 'string') {
        fail(`Installed CRS contract declared an unexpected fixture entry ${fileName}.`);
      }
      archive.addFile(fileName, Buffer.from(contents));
    }
    archive.writeZip(archivePath);

    await setup.extractApprovedFinalMpcCrsArchive(archivePath, extractedDir);
    await setup.validateDownloadedCrsArchive(
      extractedDir,
      backendReleaseDir,
      'tokamak-backend-crs-v2.1-20260829T000000Z.zip',
      compatibleBackendVersion,
      packageManifest.version,
    );
    await setup.installValidatedCrsGeneration(
      extractedDir,
      path.join(extractedDir, provenance.crsProvenanceFileName()),
      activatedOutputDir,
      'tokamak-backend-crs-v2.1-20260829T000000Z.zip',
    );
    if (!fs.lstatSync(activatedOutputDir).isSymbolicLink()) {
      fail('Installed package fixture did not atomically activate the CRS generation.');
    }
    const activeProvenance = path.join(activatedOutputDir, provenance.crsProvenanceFileName());
    if (!fs.existsSync(activeProvenance)) {
      fail('Installed package fixture did not expose CRS provenance through the active generation.');
    }
  } finally {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }
}

function installPackedConsumer(archivePath, consumerRoot) {
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ private: true, name: 'tokamak-cli-packed-consumer' })}\n`,
    'utf8',
  );
  run(npmCommand(), ['install', '--ignore-scripts', '--no-audit', '--no-fund', archivePath], { cwd: consumerRoot });
  const installedRoot = path.join(consumerRoot, 'node_modules', '@tokamak-zk-evm', 'cli');
  if (!fs.existsSync(path.join(installedRoot, 'package.json'))) {
    fail('Consumer installation did not contain @tokamak-zk-evm/cli.');
  }
  return installedRoot;
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
    const archivePath = packPackage(targetRoot);
    const installedRoot = installPackedConsumer(archivePath, path.join(targetRoot, 'consumer'));
    run(process.execPath, [path.join(installedRoot, 'dist', 'cli.js'), '--help'], { cwd: path.join(targetRoot, 'consumer') });

    const { backendProductionBuildArgs } = require(path.join(installedRoot, 'dist', 'runtime', 'native.js'));
    const { BACKEND_PACKAGE_NAMES } = require(path.join(installedRoot, 'dist', 'generated', 'backend-build-metadata-validator.generated.js'));
    for (const packageName of BACKEND_PACKAGE_NAMES) {
      run('cargo', backendProductionBuildArgs(packageName), {
        cwd: path.join(installedRoot, 'vendor', 'backend'),
        env: { ...process.env, CARGO_TARGET_DIR: targetRoot },
      });
    }
    await runInstalledPackageFixture(installedRoot, targetRoot);
  } finally {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
