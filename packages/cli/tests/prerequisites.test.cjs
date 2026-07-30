const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  assertPrerequisiteInstallIsInteractive,
  assertPrerequisiteInstallMayRunAsCurrentUser,
  buildPrerequisiteInstallationPlan,
  confirmPrerequisiteInstallation,
  detectManagedPrerequisites,
  detectSupportedNativeOs,
  extractNumericVersion,
  isPrerequisiteConfirmationAccepted,
  loadPrerequisiteManifest,
  parseOsRelease,
  parseSupportedUbuntuRelease,
  prependPathValue,
  prerequisiteVerificationFailures,
  renderPrerequisiteInstallationPlan,
  versionMeetsMinimum,
} = require('../dist/prerequisites.js');
const { parseArgs } = require('../dist/cli.js');

const linux = { platform: 'linux', ubuntuVersion: '22.04' };
const macos = { platform: 'macos' };

function createProbe(installed, versions = {}) {
  const defaults = {
    rustc: 'rustc 1.85.0',
    cargo: 'cargo 1.85.0',
    cmake: 'cmake version 3.18.0',
    cc: 'Apple clang version 11.0.0',
    gcc: 'gcc (GCC) 9.0.0',
    'g++': 'g++ (GCC) 9.0.0',
    make: 'GNU Make 4.2.1',
    'pkg-config': '0.29.1',
    tar: 'tar (GNU tar) 1.30',
    unzip: 'UnZip 6.00',
  };
  return {
    exists(command) {
      return installed.has(command);
    },
    version(command) {
      return versions[command] ?? defaults[command] ?? `${command} test-version`;
    },
  };
}

test('parses quoted os-release values and accepts only the supported Ubuntu releases', async () => {
  const contents = [
    'NAME="Ubuntu"',
    'ID=ubuntu',
    'VERSION_ID="20.04"',
    'PRETTY_NAME="Ubuntu 20.04.6 LTS"',
  ].join('\n');
  assert.deepEqual(parseOsRelease(contents), {
    NAME: 'Ubuntu',
    ID: 'ubuntu',
    VERSION_ID: '20.04',
    PRETTY_NAME: 'Ubuntu 20.04.6 LTS',
  });
  assert.equal(parseSupportedUbuntuRelease(contents), '20.04');
  assert.deepEqual(
    await detectSupportedNativeOs('linux', async () => contents),
    { platform: 'linux', ubuntuVersion: '20.04' },
  );
});

test('rejects unsupported and unidentified Linux environments', async () => {
  assert.equal(
    parseSupportedUbuntuRelease('ID=ubuntu\nVERSION_ID="22.04"\n'),
    '22.04',
  );
  for (const [contents, error] of [
    ['ID=ubuntu\nVERSION_ID="24.04"\n', /Unsupported Ubuntu version/u],
    ['ID=debian\nVERSION_ID="12"\n', /Unsupported Linux distribution/u],
    ['NAME=Ubuntu\n', /Unsupported Linux distribution/u],
  ]) {
    assert.throws(() => parseSupportedUbuntuRelease(contents), error);
  }
  for (const distribution of ['rhel', 'fedora', 'arch']) {
    assert.throws(
      () => parseSupportedUbuntuRelease(`ID=${distribution}\nVERSION_ID="1"\n`),
      /Unsupported Linux distribution/u,
    );
  }
  await assert.rejects(
    detectSupportedNativeOs('linux', async () => {
      throw new Error('missing');
    }),
    /Unable to identify the Linux distribution/u,
  );
});

test('detects supported macOS without reading Linux metadata', async () => {
  let readAttempted = false;
  const detected = await detectSupportedNativeOs('darwin', async () => {
    readAttempted = true;
    return '';
  });
  assert.deepEqual(detected, macos);
  assert.equal(readAttempted, false);
});

test('detects all managed prerequisites and their representative versions', () => {
  const installed = new Set([
    'rustc',
    'cargo',
    'cmake',
    'gcc',
    'g++',
    'make',
    'pkg-config',
    'tar',
    'unzip',
  ]);
  const statuses = detectManagedPrerequisites(linux, createProbe(installed));
  assert.equal(statuses.length, 7);
  assert.ok(statuses.every((status) => status.installed));
  assert.ok(statuses.every((status) => status.version !== null));
  assert.ok(statuses.every((status) => status.compatible));
});

test('maps missing Ubuntu tools to bootstrap and official provider artifacts', () => {
  const statuses = detectManagedPrerequisites(linux, createProbe(new Set()));
  const plan = buildPrerequisiteInstallationPlan(linux, statuses);
  assert.deepEqual(plan.actions, [
    {
      kind: 'apt-bootstrap',
      packages: ['build-essential'],
    },
    { id: 'make', kind: 'official-artifact' },
    { id: 'gcc', kind: 'official-artifact' },
    { id: 'tar', kind: 'official-artifact' },
    { id: 'cmake', kind: 'official-artifact' },
    { id: 'pkg-config', kind: 'official-artifact' },
    { id: 'unzip', kind: 'official-artifact' },
    { id: 'rust', kind: 'official-artifact' },
  ]);
  const rendered = renderPrerequisiteInstallationPlan(plan);
  assert.match(rendered, /sudo apt-get update/u);
  assert.match(rendered, /checksum-verified/u);
  assert.match(rendered, /tokamak-cli --uninstall.*does not remove/u);
});

test('orders Xcode before official artifacts on macOS', () => {
  const statuses = detectManagedPrerequisites(macos, createProbe(new Set()));
  const plan = buildPrerequisiteInstallationPlan(macos, statuses);
  assert.deepEqual(plan.actions, [
    { kind: 'xcode-command-line-tools' },
    { id: 'tar', kind: 'official-artifact' },
    { id: 'cmake', kind: 'official-artifact' },
    { id: 'pkg-config', kind: 'official-artifact' },
    { id: 'unzip', kind: 'official-artifact' },
    { id: 'rust', kind: 'official-artifact' },
  ]);
});

test('does not plan upgrades for compatible installed prerequisites', () => {
  const installed = new Set([
    'rustc',
    'cargo',
    'cmake',
    'cc',
    'c++',
    'install_name_tool',
    'pkg-config',
    'tar',
    'unzip',
  ]);
  const statuses = detectManagedPrerequisites(macos, createProbe(installed));
  assert.deepEqual(buildPrerequisiteInstallationPlan(macos, statuses).actions, []);
});

test('targets incompatible installed versions without upgrading compatible tools', () => {
  const installed = new Set([
    'rustc',
    'cargo',
    'cmake',
    'gcc',
    'g++',
    'make',
    'pkg-config',
    'tar',
    'unzip',
  ]);
  const statuses = detectManagedPrerequisites(
    linux,
    createProbe(installed, {
      cmake: 'cmake version 3.16.3',
      gcc: 'gcc (Ubuntu) 9.4.0',
      make: 'GNU Make 4.2.1',
    }),
  );
  assert.deepEqual(buildPrerequisiteInstallationPlan(linux, statuses).actions, [
    { id: 'cmake', kind: 'official-artifact' },
  ]);
  assert.match(renderPrerequisiteInstallationPlan(buildPrerequisiteInstallationPlan(linux, statuses)), /incompatible/u);
});

test('parses and compares numeric prerequisite versions', () => {
  assert.equal(extractNumericVersion('UnZip 6.00 of 20 April 2009'), '6.0.0');
  assert.equal(extractNumericVersion('cmake version 3.18'), '3.18.0');
  assert.equal(extractNumericVersion('unknown'), null);
  assert.equal(versionMeetsMinimum('3.18.0', '3.18.0'), true);
  assert.equal(versionMeetsMinimum('4.4.0', '3.18.0'), true);
  assert.equal(versionMeetsMinimum('3.16.3', '3.18.0'), false);
});

test('loads a pinned official-provider manifest with checksummed assets', () => {
  const manifest = loadPrerequisiteManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.rust.minimumVersion, '1.85.0');
  assert.equal(manifest.cmake.minimumVersion, '3.18.0');
  assert.match(manifest.cmake.assets['linux-x64'].sha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.linuxToolchain.gcc.asset.sha512, /^[a-f0-9]{128}$/u);
});

test('accepts only explicit y or yes confirmation', () => {
  for (const accepted of ['y', 'Y', 'yes', ' YES ']) {
    assert.equal(isPrerequisiteConfirmationAccepted(accepted), true);
  }
  for (const declined of ['', 'n', 'no', 'true', '1', 'y please']) {
    assert.equal(isPrerequisiteConfirmationAccepted(declined), false);
  }
});

async function answerPrompt(plan, answer) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  output.resume();
  const result = confirmPrerequisiteInstallation(plan, input, output);
  setImmediate(() => input.end(answer));
  return await result;
}

test('confirms and declines through a real default-deny prompt', async () => {
  const plan = {
    actions: [{ kind: 'rustup' }],
    os: linux,
    statuses: [],
  };

  for (const [answer, expected] of [['yes\n', true], ['\n', false], [undefined, false]]) {
    assert.equal(await answerPrompt(plan, answer), expected);
  }
});

test('rejects root execution and non-TTY execution', () => {
  assert.throws(
    () => assertPrerequisiteInstallMayRunAsCurrentUser(() => 0),
    /must not be run as root/u,
  );
  assert.doesNotThrow(() => assertPrerequisiteInstallMayRunAsCurrentUser(() => 501));
  assert.throws(
    () => assertPrerequisiteInstallIsInteractive({ isTTY: false }, { isTTY: true }),
    /requires a terminal/u,
  );
});

test('reports missing commands and failed version probes during verification', () => {
  const status = (id, installed) => ({
    compatible: false,
    commands: [id],
    id,
    installed,
    label: id,
    requirement: 'a compatible test version',
    version: installed ? null : `${id} test-version`,
  });
  const failures = prerequisiteVerificationFailures([
    status('cargo', false),
    status('cmake', true),
  ]);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /required command/u);
  assert.match(failures[1], /version verification failed/u);
});

test('prepends tool paths exactly once', () => {
  const original = ['/usr/bin', '/bin'].join(path.delimiter);
  const updated = prependPathValue(original, '/example/bin');
  assert.equal(
    updated,
    ['/example/bin', '/usr/bin', '/bin'].join(path.delimiter),
  );
  assert.equal(prependPathValue(updated, '/example/bin'), updated);
});

function runCli(args) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli.js'), ...args], {
    encoding: 'utf8',
  });
}

test('rejects invalid options at the executable boundary', () => {
  for (const [args, error] of [
    [['--install', '--include-prerequisite', '--docker'], /cannot be combined with --docker/u],
    [['--install', '--trusted-setup', '--no-setup'], /cannot be combined with --no-setup/u],
    [['--uninstall', '--include-prerequisite'], /Unknown option for --uninstall/u],
  ]) {
    const result = runCli(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  }
});

test('parses every supported include-prerequisite combination', () => {
  for (const [options, expected] of [
    [[], { verbose: false, trustedSetup: false, noSetup: false }],
    [['--verbose', '--trusted-setup'], { verbose: true, trustedSetup: true, noSetup: false }],
    [['--no-setup'], { verbose: false, trustedSetup: false, noSetup: true }],
  ]) {
    assert.deepEqual(parseArgs(['--install', '--include-prerequisite', ...options]), {
      command: 'install',
      verbose: expected.verbose,
      installOptions: {
        docker: false,
        includePrerequisite: true,
        trustedSetup: expected.trustedSetup,
        noSetup: expected.noSetup,
      },
    });
  }
});
