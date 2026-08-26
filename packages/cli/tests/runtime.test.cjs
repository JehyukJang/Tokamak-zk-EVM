const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { installRuntime } = require('../dist/runtime.js');
const { streamDownloadToFile } = require('../dist/runtime/download.js');

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
