const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installRuntime } = require('../dist/runtime.js');
const {
  assertInstalledRuntimeMatchesContext,
  parseInstalledRuntimeState,
} = require('../dist/runtime/context.js');
const { installStagedRuntime } = require('../dist/runtime/transaction.js');
const { streamDownloadToFile } = require('../dist/runtime/download.js');

function runtimeContext(platform = 'linux') {
  return {
    cacheRoot: '/cache',
    packageRoot: '/package',
    platform,
    platformDir: `/cache/${platform}`,
    runtimeDir: `/cache/${platform}/runtime`,
    statePath: `/cache/${platform}/installation.json`,
    compatibleBackendVersion: '2.1',
    packageVersion: '2.1.5',
  };
}

function runtimeState(packageVersion = '2.1.5') {
  return {
    installMode: 'native',
    packageVersion,
    platform: 'linux',
    installedAt: '2026-08-27T00:00:00.000Z',
  };
}

async function createInstalledRuntimeFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-runtime-transaction-'));
  const context = {
    ...runtimeContext(),
    cacheRoot: path.join(temporaryRoot, 'cache'),
  };
  context.platformDir = path.join(context.cacheRoot, context.platform);
  context.runtimeDir = path.join(context.platformDir, 'runtime');
  context.statePath = path.join(context.platformDir, 'installation.json');
  await fs.mkdir(context.runtimeDir, { recursive: true });
  await fs.writeFile(path.join(context.runtimeDir, 'marker.txt'), 'previous runtime\n', 'utf8');
  const previousState = runtimeState('2.1.4');
  await fs.writeFile(context.statePath, `${JSON.stringify(previousState, null, 2)}\n`, 'utf8');
  return { context, previousState, temporaryRoot };
}

test('accepts only a structurally valid state for the current CLI runtime', () => {
  const native = parseInstalledRuntimeState({
    installMode: 'native',
    packageVersion: '2.1.5',
    platform: 'linux',
    installedAt: '2026-08-27T00:00:00.000Z',
  });
  assert.doesNotThrow(() => {
    assertInstalledRuntimeMatchesContext(runtimeContext(), native, ['native', 'docker']);
  });

  const docker = parseInstalledRuntimeState({
    installMode: 'docker',
    dockerEnvironment: 'ubuntu22',
    packageVersion: '2.1.5',
    platform: 'linux',
    installedAt: '2026-08-27T00:00:00.000Z',
  });
  assert.doesNotThrow(() => {
    assertInstalledRuntimeMatchesContext(runtimeContext(), docker, ['docker']);
  });

  assert.throws(
    () => assertInstalledRuntimeMatchesContext(runtimeContext(), { ...native, packageVersion: '2.1.4' }, ['native']),
    /does not match current CLI package version/u,
  );
  assert.throws(
    () => assertInstalledRuntimeMatchesContext(runtimeContext(), { ...native, platform: 'macos' }, ['native']),
    /does not match current CLI platform/u,
  );
  assert.throws(
    () => assertInstalledRuntimeMatchesContext(runtimeContext('macos'), { ...docker, platform: 'macos' }, ['native']),
    /not supported for the current CLI execution path/u,
  );
  assert.throws(
    () => parseInstalledRuntimeState({ ...native, installMode: 'docker' }),
    /Docker runtime must include a supported dockerEnvironment/u,
  );
  assert.throws(
    () => parseInstalledRuntimeState({ ...native, installedAt: 'not-a-timestamp' }),
    /installedAt must be an ISO-8601 timestamp/u,
  );
});

test('keeps the previous native runtime and state when staging fails before activation', async () => {
  for (const failingStep of ['backend copy', 'ICICLE installation', 'CRS installation']) {
    const { context, previousState, temporaryRoot } = await createInstalledRuntimeFixture();
    try {
      await assert.rejects(
        installStagedRuntime(context, runtimeState(), async (stagingContext) => {
          await fs.writeFile(path.join(stagingContext.runtimeDir, 'marker.txt'), 'new runtime\n', 'utf8');
          throw new Error(`injected ${failingStep} failure`);
        }),
        new RegExp(`injected ${failingStep} failure`, 'u'),
      );
      assert.equal(await fs.readFile(path.join(context.runtimeDir, 'marker.txt'), 'utf8'), 'previous runtime\n');
      assert.deepEqual(JSON.parse(await fs.readFile(context.statePath, 'utf8')), previousState);
      assert.deepEqual(await fs.readdir(context.platformDir), ['installation.json', 'runtime']);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test('restores the previous native runtime and state after activation or state-write failure', async () => {
  const promotionFixture = await createInstalledRuntimeFixture();
  try {
    await assert.rejects(
      installStagedRuntime(promotionFixture.context, runtimeState(), async (stagingContext) => {
        await fs.rm(stagingContext.runtimeDir, { recursive: true, force: true });
      }),
      /ENOENT/u,
    );
    assert.equal(
      await fs.readFile(path.join(promotionFixture.context.runtimeDir, 'marker.txt'), 'utf8'),
      'previous runtime\n',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(promotionFixture.context.statePath, 'utf8')),
      promotionFixture.previousState,
    );
  } finally {
    await fs.rm(promotionFixture.temporaryRoot, { recursive: true, force: true });
  }

  const stateFixture = await createInstalledRuntimeFixture();
  try {
    await assert.rejects(
      installStagedRuntime(
        stateFixture.context,
        runtimeState(),
        async (stagingContext) => {
          await fs.writeFile(path.join(stagingContext.runtimeDir, 'marker.txt'), 'new runtime\n', 'utf8');
        },
        async () => {
          throw new Error('injected state write failure');
        },
      ),
      /injected state write failure/u,
    );
    assert.equal(await fs.readFile(path.join(stateFixture.context.runtimeDir, 'marker.txt'), 'utf8'), 'previous runtime\n');
    assert.deepEqual(JSON.parse(await fs.readFile(stateFixture.context.statePath, 'utf8')), stateFixture.previousState);
    assert.deepEqual(await fs.readdir(stateFixture.context.platformDir), ['installation.json', 'runtime']);
  } finally {
    await fs.rm(stateFixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('streams downloads by overwriting and appending complete response bodies', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-download-'));
  const destinationPath = path.join(temporaryRoot, 'download.bin');
  try {
    await fs.writeFile(destinationPath, 'stale');
    await streamDownloadToFile(
      new Response(new Blob(['abc', 'def']).stream()),
      destinationPath,
      { label: 'download.bin', totalBytes: 6 },
    );
    assert.equal(await fs.readFile(destinationPath, 'utf8'), 'abcdef');

    await streamDownloadToFile(
      new Response(new Blob(['gh']).stream()),
      destinationPath,
      {
        append: true,
        initialBytes: 6,
        label: 'download.bin',
        totalBytes: 8,
      },
    );
    assert.equal(await fs.readFile(destinationPath, 'utf8'), 'abcdefgh');

    await assert.rejects(
      streamDownloadToFile(
        new Response(null),
        destinationPath,
        { label: 'empty.bin', totalBytes: null },
      ),
      /did not contain a body/u,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('writes only Docker bootstrap state and removes the legacy launcher', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-runtime-'));
  const cacheRoot = path.join(temporaryRoot, 'cache');
  const fakeBin = path.join(temporaryRoot, 'bin');
  const originalPath = process.env.PATH;
  const originalCacheRoot = process.env.TOKAMAK_ZKEVM_CLI_CACHE_DIR;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  try {
    await fs.mkdir(fakeBin);
    const dockerPath = path.join(fakeBin, 'docker');
    await fs.writeFile(dockerPath, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
    await fs.chmod(dockerPath, 0o755);
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ''}`;
    process.env.TOKAMAK_ZKEVM_CLI_CACHE_DIR = cacheRoot;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });

    const dockerDir = path.join(cacheRoot, 'linux', 'docker');
    const legacyLauncher = path.join(dockerDir, 'run.sh');
    await fs.mkdir(dockerDir, { recursive: true });
    await fs.writeFile(legacyLauncher, 'legacy\n', 'utf8');

    await installRuntime({
      docker: true,
      includePrerequisite: false,
      noSetup: true,
      verbose: false,
    });

    const bootstrap = JSON.parse(
      await fs.readFile(path.join(dockerDir, 'bootstrap.json'), 'utf8'),
    );
    assert.equal(bootstrap.dockerEnvironment, 'ubuntu22');
    assert.equal(bootstrap.platform, 'linux');
    assert.equal(bootstrap.useGpus, false);
    await assert.rejects(fs.access(legacyLauncher));
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCacheRoot === undefined) {
      delete process.env.TOKAMAK_ZKEVM_CLI_CACHE_DIR;
    } else {
      process.env.TOKAMAK_ZKEVM_CLI_CACHE_DIR = originalCacheRoot;
    }
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
