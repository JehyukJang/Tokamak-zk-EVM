const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');
const publishScript = path.join(packageRoot, 'scripts', 'publish-package.cjs');

test('manual publish stops before npm publish when root version validation fails', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokamak-cli-release-publish-'));
  const fakeBin = path.join(temporaryRoot, 'bin');
  const invocationLog = path.join(temporaryRoot, 'npm-invocations.jsonl');
  const fakeNpm = path.join(fakeBin, 'npm');
  try {
    await fs.mkdir(fakeBin);
    await fs.writeFile(
      fakeNpm,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.TOKAMAK_TEST_NPM_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
        "process.exit(process.argv.includes('version:check') ? 23 : 0);",
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    assert.throws(
      () => execFileSync(process.execPath, [publishScript, '--dry-run'], {
        cwd: packageRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          TOKAMAK_TEST_NPM_LOG: invocationLog,
        },
        stdio: 'pipe',
      }),
      (error) => error.status === 23,
    );

    const invocations = (await fs.readFile(invocationLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(invocations, [
      ['--prefix', repositoryRoot, 'run', 'version:check'],
    ]);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
