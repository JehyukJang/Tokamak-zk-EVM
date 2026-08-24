const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateDownloadedCrsArchive } = require('../dist/runtime/setup.js');

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

async function writeCrsArchiveFixture(extractedDir, subcircuitLibraryVersion = '2.1.5') {
  const artifacts = {
    'combined_sigma.rkyv': 'combined sigma',
    'sigma_preprocess.rkyv': 'preprocess sigma',
    'sigma_verify.json': 'verify sigma',
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
