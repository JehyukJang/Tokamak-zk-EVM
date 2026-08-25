const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installValidatedCrsGeneration, validateDownloadedCrsArchive } = require('../dist/runtime/setup.js');

const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = '@tokamak-zk-evm/subcircuit-library';
const BACKEND_BINARY_NAMES = ['preprocess', 'prove', 'verify'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeBackendMetadata(backendReleaseDir) {
  for (const name of BACKEND_BINARY_NAMES) {
    await fs.writeFile(
      path.join(backendReleaseDir, `build-metadata-${name}.json`),
      `${JSON.stringify({
        compatibleBackendVersion: '2.1',
        packageVersion: '2.1.5',
        dependencies: {
          subcircuitLibrary: {
            buildVersion: '2.1.5',
            packageName: SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
          },
        },
      })}\n`,
      'utf8',
    );
  }
}

async function writeCrsArchiveFixture(extractedDir, subcircuitLibraryVersion = '2.1.5', label = 'fixture') {
  const artifacts = {
    'combined_sigma.rkyv': `${label} combined sigma`,
    'sigma_preprocess.rkyv': `${label} preprocess sigma`,
    'sigma_verify.json': `${label} verify sigma`,
  };
  for (const [filename, contents] of Object.entries(artifacts)) {
    await fs.writeFile(path.join(extractedDir, filename), contents, 'utf8');
  }
  await fs.writeFile(
    path.join(extractedDir, 'crs_provenance.json'),
    `${JSON.stringify({
      compatibleBackendVersion: '2.1',
      subcircuitLibrary: {
        packageName: SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
        packageVersion: subcircuitLibraryVersion,
        origin: 'npmSnapshot',
      },
      combined_sigma_sha256: sha256(artifacts['combined_sigma.rkyv']),
      sigma_preprocess_sha256: sha256(artifacts['sigma_preprocess.rkyv']),
      sigma_verify_sha256: sha256(artifacts['sigma_verify.json']),
    })}\n`,
    'utf8',
  );
}

async function generationTarget(setupOutputDir) {
  const target = await fs.readlink(setupOutputDir);
  return path.resolve(path.dirname(setupOutputDir), target);
}

test('accepts a current CRS archive that contains provenance but no removed MPC build metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
  try {
    const extractedDir = path.join(tempDir, 'archive');
    const backendReleaseDir = path.join(tempDir, 'backend');
    await fs.mkdir(extractedDir);
    await fs.mkdir(backendReleaseDir);
    await writeCrsArchiveFixture(extractedDir);
    await writeBackendMetadata(backendReleaseDir);

    const result = await validateDownloadedCrsArchive(
      extractedDir,
      backendReleaseDir,
      'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
      '2.1',
    );

    assert.equal(result.provenancePath, path.join(extractedDir, 'crs_provenance.json'));
    await assert.rejects(fs.access(path.join(extractedDir, 'build-metadata-mpc-setup.json')));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rejects CRS provenance with an incompatible subcircuit-library package version', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
  try {
    const extractedDir = path.join(tempDir, 'archive');
    const backendReleaseDir = path.join(tempDir, 'backend');
    await fs.mkdir(extractedDir);
    await fs.mkdir(backendReleaseDir);
    await writeCrsArchiveFixture(extractedDir, '2.2.0');
    await writeBackendMetadata(backendReleaseDir);

    await assert.rejects(
      validateDownloadedCrsArchive(
        extractedDir,
        backendReleaseDir,
        'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
        '2.1',
      ),
      /provenance subcircuit-library version 2\.2\.0 is not compatible with 2\.1/u,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('migrates a legacy setup output directory to one active CRS generation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
  try {
    const extractedDir = path.join(tempDir, 'archive');
    const setupOutputDir = path.join(tempDir, 'resource', 'setup', 'output');
    await fs.mkdir(extractedDir, { recursive: true });
    await fs.mkdir(setupOutputDir, { recursive: true });
    await fs.writeFile(path.join(setupOutputDir, 'README.txt'), 'legacy setup output\n', 'utf8');
    await writeCrsArchiveFixture(extractedDir, '2.1.5', 'first');

    await installValidatedCrsGeneration(
      extractedDir,
      path.join(extractedDir, 'crs_provenance.json'),
      setupOutputDir,
      'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
    );

    assert.equal((await fs.lstat(setupOutputDir)).isSymbolicLink(), true);
    const activeGeneration = await generationTarget(setupOutputDir);
    assert.equal(await fs.readFile(path.join(activeGeneration, 'combined_sigma.rkyv'), 'utf8'), 'first combined sigma');
    await assert.rejects(fs.access(path.join(activeGeneration, 'README.txt')));
    const generations = await fs.readdir(path.join(tempDir, 'resource', 'setup', 'generations'));
    assert.deepEqual(generations, [path.basename(activeGeneration)]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('keeps the prior setup output intact when any staged CRS copy fails', async () => {
  for (let failingCopy = 1; failingCopy <= 4; failingCopy += 1) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
    try {
      const extractedDir = path.join(tempDir, 'archive');
      const setupOutputDir = path.join(tempDir, 'resource', 'setup', 'output');
      await fs.mkdir(extractedDir, { recursive: true });
      await fs.mkdir(setupOutputDir, { recursive: true });
      await fs.writeFile(path.join(setupOutputDir, 'legacy.txt'), 'keep this output\n', 'utf8');
      await writeCrsArchiveFixture(extractedDir);

      let copyCount = 0;
      await assert.rejects(
        installValidatedCrsGeneration(
          extractedDir,
          path.join(extractedDir, 'crs_provenance.json'),
          setupOutputDir,
          'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
          async (source, destination) => {
            copyCount += 1;
            if (copyCount === failingCopy) {
              throw new Error(`injected copy failure ${failingCopy}`);
            }
            await fs.copyFile(source, destination);
          },
        ),
        new RegExp(`injected copy failure ${failingCopy}`, 'u'),
      );

      assert.equal((await fs.lstat(setupOutputDir)).isDirectory(), true);
      assert.equal(await fs.readFile(path.join(setupOutputDir, 'legacy.txt'), 'utf8'), 'keep this output\n');
      assert.deepEqual(await fs.readdir(path.join(tempDir, 'resource', 'setup', 'generations')), []);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('atomically replaces the active CRS generation and immediately deletes the prior generation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
  try {
    const firstArchiveDir = path.join(tempDir, 'archive-first');
    const secondArchiveDir = path.join(tempDir, 'archive-second');
    const setupOutputDir = path.join(tempDir, 'resource', 'setup', 'output');
    await fs.mkdir(firstArchiveDir, { recursive: true });
    await fs.mkdir(secondArchiveDir, { recursive: true });
    await writeCrsArchiveFixture(firstArchiveDir, '2.1.5', 'first');
    await writeCrsArchiveFixture(secondArchiveDir, '2.1.5', 'second');

    await installValidatedCrsGeneration(
      firstArchiveDir,
      path.join(firstArchiveDir, 'crs_provenance.json'),
      setupOutputDir,
      'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
    );
    const firstGeneration = await generationTarget(setupOutputDir);

    await installValidatedCrsGeneration(
      secondArchiveDir,
      path.join(secondArchiveDir, 'crs_provenance.json'),
      setupOutputDir,
      'tokamak-backend-crs-v2.1-20260825T000000Z.zip',
    );

    const secondGeneration = await generationTarget(setupOutputDir);
    assert.notEqual(secondGeneration, firstGeneration);
    assert.equal(await fs.readFile(path.join(setupOutputDir, 'combined_sigma.rkyv'), 'utf8'), 'second combined sigma');
    await assert.rejects(fs.access(firstGeneration));
    assert.deepEqual(
      await fs.readdir(path.join(tempDir, 'resource', 'setup', 'generations')),
      [path.basename(secondGeneration)],
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
