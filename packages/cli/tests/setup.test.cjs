const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  installValidatedCrsGeneration,
  validateDownloadedCrsArchive,
  validateFinalMpcCrsProvenanceContract,
} = require('../dist/runtime/setup.js');

const SUBCIRCUIT_LIBRARY_PACKAGE_NAME = '@tokamak-zk-evm/subcircuit-library';
const BACKEND_BINARY_NAMES = ['preprocess', 'prove', 'verify'];
const CRS_PROVENANCE_CONTRACT = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'crs-provenance-contract.json'),
    'utf8',
  ),
);
const BACKEND_BUILD_METADATA_CONTRACT = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'backend-build-metadata-contract.json'),
    'utf8',
  ),
);
function readBackendBuildMetadataFixture(filename) {
  return JSON.parse(
    require('node:fs').readFileSync(
      path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', filename),
      'utf8',
    ),
  );
}
const INVALID_BUILD_METADATA_FIXTURES = {
  missingRuntimeMode: readBackendBuildMetadataFixture('backend-build-metadata-invalid.json'),
  declaredRange: readBackendBuildMetadataFixture('backend-build-metadata-invalid-declared-range.json'),
  runtimeMode: readBackendBuildMetadataFixture('backend-build-metadata-invalid-runtime-mode.json'),
  libraryPackage: readBackendBuildMetadataFixture('backend-build-metadata-invalid-library-package.json'),
  unexpectedField: readBackendBuildMetadataFixture('backend-build-metadata-invalid-unexpected-field.json'),
  packageName: readBackendBuildMetadataFixture('backend-build-metadata-invalid-package-name.json'),
  leadingZeroPackageVersion: readBackendBuildMetadataFixture(
    'backend-build-metadata-invalid-leading-zero-package-version.json',
  ),
  leadingZeroCompatibleVersion: readBackendBuildMetadataFixture(
    'backend-build-metadata-invalid-leading-zero-compatible-version.json',
  ),
};
const CANONICAL_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance.json'),
    'utf8',
  ),
);
const MALFORMED_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance-malformed.json'),
    'utf8',
  ),
);
const LEGACY_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance-legacy.json'),
    'utf8',
  ),
);
const LEADING_ZERO_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance-leading-zero.json'),
    'utf8',
  ),
);
const DATE_ONLY_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance-date-only.json'),
    'utf8',
  ),
);
const INVALID_DIGEST_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance-invalid-digest.json'),
    'utf8',
  ),
);
const EMPTY_STRING_FINAL_MPC_PROVENANCE = JSON.parse(
  require('node:fs').readFileSync(
    path.resolve(__dirname, '..', '..', 'backend', 'contracts', 'fixtures', 'final-mpc-crs-provenance-empty-string.json'),
    'utf8',
  ),
);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeBackendMetadata(backendReleaseDir, mutate = undefined) {
  for (const name of BACKEND_BINARY_NAMES) {
    const metadata = {
      compatibleBackendVersion: '2.1',
      dependencies: {
        subcircuitLibrary: {
          buildVersion: '2.1.5',
          declaredRange: 'latest',
          packageName: SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
          runtimeMode: 'bundled',
        },
      },
      packageName: name,
      packageVersion: '2.1.5',
    };
    await fs.writeFile(
      path.join(backendReleaseDir, `build-metadata-${name}.json`),
      `${JSON.stringify(mutate?.(structuredClone(metadata), name) ?? metadata)}\n`,
      'utf8',
    );
  }
}

async function writeCrsArchiveFixture(
  extractedDir,
  subcircuitLibraryVersion = '2.1.5',
  label = 'fixture',
  provenance = undefined,
) {
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
    `${JSON.stringify(provenance ?? {
      documentKind: 'finalMpcCrs',
      releaseEligible: false,
      generatedAtUtc: '2026-08-24T00:00:00Z',
      compatibleBackendVersion: '2.1',
      subcircuitLibrary: {
        packageName: SUBCIRCUIT_LIBRARY_PACKAGE_NAME,
        packageVersion: subcircuitLibraryVersion,
        origin: 'npmSnapshot',
      },
      phase1SourceProvenance: null,
      combinedSigmaSha256: sha256(artifacts['combined_sigma.rkyv']),
      sigmaPreprocessSha256: sha256(artifacts['sigma_preprocess.rkyv']),
      sigmaVerifySha256: sha256(artifacts['sigma_verify.json']),
    })}\n`,
    'utf8',
  );
}

test('packages the backend CRS provenance contract unchanged for runtime validation', () => {
  const packagedContract = require('../dist/generated/crs-provenance-contract.generated.js').default;
  assert.deepEqual(packagedContract, CRS_PROVENANCE_CONTRACT);
});

test('packages the backend build-metadata contract unchanged for runtime validation', () => {
  const packagedContract = require('../dist/generated/backend-build-metadata-contract.generated.js').default;
  assert.deepEqual(packagedContract, BACKEND_BUILD_METADATA_CONTRACT);
});

test('validates canonical and legacy backend final-MPC provenance fixtures', async () => {
  const archiveName = 'tokamak-backend-crs-v2.1-20260824T000000Z.zip';
  const validated = await validateFinalMpcCrsProvenanceContract(CANONICAL_FINAL_MPC_PROVENANCE, archiveName);
  assert.deepEqual(validated, CANONICAL_FINAL_MPC_PROVENANCE);

  await assert.rejects(
    validateFinalMpcCrsProvenanceContract(LEGACY_FINAL_MPC_PROVENANCE, archiveName),
    /does not match exactly one allowed contract shape/u,
  );
});

async function generationTarget(setupOutputDir) {
  const target = await fs.readlink(setupOutputDir);
  return path.resolve(path.dirname(setupOutputDir), target);
}

test('installer ingress accepts the canonical provenance fixture without removed MPC build metadata', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
  try {
    const extractedDir = path.join(tempDir, 'archive');
    const backendReleaseDir = path.join(tempDir, 'backend');
    await fs.mkdir(extractedDir);
    await fs.mkdir(backendReleaseDir);
    await writeCrsArchiveFixture(extractedDir, '2.1.5', 'canonical', CANONICAL_FINAL_MPC_PROVENANCE);
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

test('rejects a development trusted-setup provenance before CRS installation', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
  try {
    const extractedDir = path.join(tempDir, 'archive');
    const backendReleaseDir = path.join(tempDir, 'backend');
    await fs.mkdir(extractedDir);
    await fs.mkdir(backendReleaseDir);
    await writeCrsArchiveFixture(extractedDir);
    const provenancePath = path.join(extractedDir, 'crs_provenance.json');
    const provenance = JSON.parse(await fs.readFile(provenancePath, 'utf8'));
    provenance.documentKind = 'developmentTrustedSetupSigma';
    await fs.writeFile(provenancePath, `${JSON.stringify(provenance)}\n`, 'utf8');

    await assert.rejects(
      validateDownloadedCrsArchive(
        extractedDir,
        backendReleaseDir,
        'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
        '2.1',
      ),
      /documentKind must equal "finalMpcCrs"/u,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('installer ingress rejects malformed and semantically invalid provenance fixtures', async () => {
  const cases = [
    {
      name: 'leading-zero compatibility version',
      provenance: LEADING_ZERO_FINAL_MPC_PROVENANCE,
      expected: /compatibleBackendVersion.*leading zeroes are not canonical/u,
    },
    {
      name: 'unknown provenance field',
      provenance: MALFORMED_FINAL_MPC_PROVENANCE,
      expected: /has unsupported field unexpected/u,
    },
    {
      name: 'legacy Dusk variant',
      provenance: LEGACY_FINAL_MPC_PROVENANCE,
      expected: /does not match exactly one allowed contract shape/u,
    },
    {
      name: 'date-only timestamp',
      provenance: DATE_ONLY_FINAL_MPC_PROVENANCE,
      expected: /generatedAtUtc must be an RFC 3339 date-time/u,
    },
    {
      name: 'invalid digest',
      provenance: INVALID_DIGEST_FINAL_MPC_PROVENANCE,
      expected: /combinedSigmaSha256 does not match the contract pattern/u,
    },
    {
      name: 'empty required string',
      provenance: EMPTY_STRING_FINAL_MPC_PROVENANCE,
      expected: /subcircuitLibrary\.packageName is shorter than the contract allows/u,
    },
  ];

  for (const testCase of cases) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
    try {
      const extractedDir = path.join(tempDir, 'archive');
      const backendReleaseDir = path.join(tempDir, 'backend');
      await fs.mkdir(extractedDir);
      await fs.mkdir(backendReleaseDir);
      await writeCrsArchiveFixture(extractedDir, '2.1.5', 'canonical', testCase.provenance);

      await assert.rejects(
        validateDownloadedCrsArchive(
          extractedDir,
          backendReleaseDir,
          'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
          '2.1',
        ),
        testCase.expected,
        testCase.name,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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

test('installer ingress rejects every build-metadata contract violation', async () => {
  const cases = [
    {
      name: 'missing runtime mode',
      metadata: INVALID_BUILD_METADATA_FIXTURES.missingRuntimeMode,
      expected: /subcircuitLibrary is missing runtimeMode/u,
    },
    {
      name: 'invalid declared range',
      metadata: INVALID_BUILD_METADATA_FIXTURES.declaredRange,
      expected: /declaredRange must equal "latest"/u,
    },
    {
      name: 'invalid runtime mode',
      metadata: INVALID_BUILD_METADATA_FIXTURES.runtimeMode,
      expected: /runtimeMode must equal "bundled"/u,
    },
    {
      name: 'invalid subcircuit-library package name',
      metadata: INVALID_BUILD_METADATA_FIXTURES.libraryPackage,
      expected: /subcircuitLibrary\.packageName must equal/u,
    },
    {
      name: 'unexpected metadata field',
      metadata: INVALID_BUILD_METADATA_FIXTURES.unexpectedField,
      expected: /has unsupported field unexpected/u,
    },
    {
      name: 'wrong backend package',
      metadata: INVALID_BUILD_METADATA_FIXTURES.packageName,
      expected: /Backend package prove build metadata\.packageName must equal "prove"/u,
    },
    {
      name: 'leading-zero backend package version',
      metadata: INVALID_BUILD_METADATA_FIXTURES.leadingZeroPackageVersion,
      expected: /packageVersion.*leading zeroes are not canonical/u,
    },
    {
      name: 'leading-zero backend compatibility version',
      metadata: INVALID_BUILD_METADATA_FIXTURES.leadingZeroCompatibleVersion,
      expected: /compatibleBackendVersion.*leading zeroes are not canonical/u,
    },
  ];

  for (const testCase of cases) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-crs-'));
    try {
      const extractedDir = path.join(tempDir, 'archive');
      const backendReleaseDir = path.join(tempDir, 'backend');
      await fs.mkdir(extractedDir);
      await fs.mkdir(backendReleaseDir);
      await writeCrsArchiveFixture(extractedDir, '2.1.5', 'canonical', CANONICAL_FINAL_MPC_PROVENANCE);
      await writeBackendMetadata(backendReleaseDir, (metadata, backendName) =>
        backendName === 'prove' ? testCase.metadata : metadata,
      );

      await assert.rejects(
        validateDownloadedCrsArchive(
          extractedDir,
          backendReleaseDir,
          'tokamak-backend-crs-v2.1-20260824T000000Z.zip',
          '2.1',
        ),
        testCase.expected,
        testCase.name,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
    assert.deepEqual(await fs.readdir(path.join(tempDir, 'resource', 'setup', 'generations')), [
      path.basename(secondGeneration),
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
