import { createReadStream, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { Readable as NodeReadable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createSystemCommandProbe, type CommandProbe } from './system.js';

export type SupportedUbuntuVersion = '20.04' | '22.04';

export type SupportedNativeOs =
  | {
      platform: 'linux';
      ubuntuVersion: SupportedUbuntuVersion;
    }
  | {
      platform: 'macos';
    };

export type ManagedPrerequisiteId =
  | 'rust'
  | 'cargo'
  | 'cmake'
  | 'toolchain'
  | 'pkg-config'
  | 'tar'
  | 'unzip';

export interface PrerequisiteStatus {
  compatible: boolean;
  commands: readonly string[];
  id: ManagedPrerequisiteId;
  incompatibleComponents?: readonly LinuxToolchainComponent[];
  installed: boolean;
  label: string;
  requirement: string;
  version: string | null;
}

type LinuxToolchainComponent = 'gcc' | 'make';
type OfficialArtifactId = 'cmake' | 'gcc' | 'make' | 'pkg-config' | 'rust' | 'tar' | 'unzip';

export type PrerequisiteInstallationAction =
  | {
      kind: 'apt-bootstrap';
      packages: readonly string[];
    }
  | {
      id: OfficialArtifactId;
      kind: 'official-artifact';
    }
  | {
      kind: 'xcode-command-line-tools';
    };

export interface PrerequisiteInstallationPlan {
  actions: readonly PrerequisiteInstallationAction[];
  os: SupportedNativeOs;
  statuses: readonly PrerequisiteStatus[];
}

export interface PrerequisiteInstallExecutionOptions {
  verbose: boolean;
}

export type PrerequisiteInstallExecutionResult = 'complete' | 'rerun-required';

interface Artifact {
  sha256?: string;
  sha512?: string;
  url: string;
}

type PlatformAssetKey = 'linux-x64' | 'linux-arm64' | 'macos-x64' | 'macos-arm64';

interface VersionedArtifact {
  asset: Artifact;
  minimumVersion: string;
  version: string;
}

interface PrerequisiteManifest {
  appleCommandLineTools: {
    delivery: 'xcode-select';
    integrity: 'apple-signed-software-update';
    minimumClangVersion: string;
  };
  cmake: {
    assets: Record<PlatformAssetKey, Artifact>;
    minimumVersion: string;
    version: string;
  };
  linuxToolchain: {
    gcc: VersionedArtifact;
    make: VersionedArtifact;
  };
  pkgConfig: VersionedArtifact;
  reviewedAt: string;
  rust: {
    assets: Record<PlatformAssetKey, Artifact>;
    minimumVersion: string;
    rustupVersion: string;
    version: string;
  };
  schemaVersion: 1;
  tar: VersionedArtifact;
  unzip: VersionedArtifact;
}

const PREREQUISITE_MANIFEST_PATH = path.resolve(
  __dirname,
  '..',
  'manifests',
  'prerequisites-v1.json',
);

let cachedManifest: PrerequisiteManifest | undefined;

export interface OsRelease {
  [key: string]: string;
}

function unquoteOsReleaseValue(value: string): string {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) {
    return value;
  }

  const unquoted = value.slice(1, -1);
  if (quote === "'") {
    return unquoted;
  }
  return unquoted.replace(/\\(["\\$`])/gu, '$1');
}

export function parseOsRelease(contents: string): OsRelease {
  const values: OsRelease = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Z0-9_]+)=(.*)$/u.exec(trimmed);
    if (match === null) {
      continue;
    }
    values[match[1]] = unquoteOsReleaseValue(match[2].trim());
  }
  return values;
}

export function parseSupportedUbuntuRelease(contents: string): SupportedUbuntuVersion {
  const release = parseOsRelease(contents);
  if (release.ID !== 'ubuntu') {
    throw new Error(
      `Unsupported Linux distribution: expected Ubuntu 20.04 or 22.04, found ${release.ID ?? 'an unknown distribution'}.`,
    );
  }
  if (release.VERSION_ID !== '20.04' && release.VERSION_ID !== '22.04') {
    throw new Error(
      `Unsupported Ubuntu version: expected 20.04 or 22.04, found ${release.VERSION_ID ?? 'an unknown version'}.`,
    );
  }
  return release.VERSION_ID;
}

export async function detectSupportedNativeOs(
  platform: NodeJS.Platform = process.platform,
  readOsRelease: () => Promise<string> = async () => await fs.readFile('/etc/os-release', 'utf8'),
): Promise<SupportedNativeOs> {
  if (platform === 'darwin') {
    return { platform: 'macos' };
  }
  if (platform !== 'linux') {
    throw new Error(
      `Unsupported platform: ${platform}. Native tokamak-cli installs support macOS, Ubuntu 20.04, and Ubuntu 22.04.`,
    );
  }

  let contents: string;
  try {
    contents = await readOsRelease();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to identify the Linux distribution from /etc/os-release: ${message}`);
  }
  return {
    platform: 'linux',
    ubuntuVersion: parseSupportedUbuntuRelease(contents),
  };
}

function assertVersion(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${label} must be a stable numeric version, got ${JSON.stringify(value)}.`);
  }
}

function assertArtifact(value: unknown, label: string): asserts value is Artifact {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an artifact object.`);
  }
  const artifact = value as Partial<Artifact>;
  if (typeof artifact.url !== 'string' || !artifact.url.startsWith('https://')) {
    throw new Error(`${label}.url must use HTTPS.`);
  }
  const checksums = [
    typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(artifact.sha256),
    typeof artifact.sha512 === 'string' && /^[a-f0-9]{128}$/u.test(artifact.sha512),
  ].filter(Boolean);
  if (checksums.length !== 1) {
    throw new Error(`${label} must contain exactly one valid SHA-256 or SHA-512 checksum.`);
  }
}

function assertVersionedArtifact(value: unknown, label: string): asserts value is VersionedArtifact {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be a versioned artifact object.`);
  }
  const entry = value as Partial<VersionedArtifact>;
  assertVersion(entry.minimumVersion, `${label}.minimumVersion`);
  assertVersion(entry.version, `${label}.version`);
  assertArtifact(entry.asset, `${label}.asset`);
}

export function loadPrerequisiteManifest(
  manifestPath = PREREQUISITE_MANIFEST_PATH,
): PrerequisiteManifest {
  if (manifestPath === PREREQUISITE_MANIFEST_PATH && cachedManifest !== undefined) {
    return cachedManifest;
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<PrerequisiteManifest>;
  if (parsed.schemaVersion !== 1 || typeof parsed.reviewedAt !== 'string') {
    throw new Error(`Unsupported or incomplete prerequisite manifest: ${manifestPath}.`);
  }
  assertVersionedArtifact(parsed.linuxToolchain?.gcc, 'linuxToolchain.gcc');
  assertVersionedArtifact(parsed.linuxToolchain?.make, 'linuxToolchain.make');
  assertVersionedArtifact(parsed.pkgConfig, 'pkgConfig');
  assertVersionedArtifact(parsed.tar, 'tar');
  assertVersionedArtifact(parsed.unzip, 'unzip');
  assertVersion(parsed.cmake?.minimumVersion, 'cmake.minimumVersion');
  assertVersion(parsed.cmake?.version, 'cmake.version');
  assertVersion(parsed.rust?.minimumVersion, 'rust.minimumVersion');
  assertVersion(parsed.rust?.version, 'rust.version');
  assertVersion(parsed.rust?.rustupVersion, 'rust.rustupVersion');
  for (const key of ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'] as const) {
    assertArtifact(parsed.cmake?.assets?.[key], `cmake.assets.${key}`);
    assertArtifact(parsed.rust?.assets?.[key], `rust.assets.${key}`);
  }
  if (
    parsed.appleCommandLineTools?.delivery !== 'xcode-select'
    || parsed.appleCommandLineTools.integrity !== 'apple-signed-software-update'
  ) {
    throw new Error('The prerequisite manifest has an unsupported Apple Command Line Tools policy.');
  }
  assertVersion(
    parsed.appleCommandLineTools.minimumClangVersion,
    'appleCommandLineTools.minimumClangVersion',
  );
  const manifest = parsed as PrerequisiteManifest;
  if (manifestPath === PREREQUISITE_MANIFEST_PATH) {
    cachedManifest = manifest;
  }
  return manifest;
}

function normalizeVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function extractNumericVersion(output: string | null): string | null {
  const match = output === null ? null : /(?:^|\D)(\d+\.\d+(?:\.\d+)?)(?:\D|$)/u.exec(output);
  if (match === null) {
    return null;
  }
  const version = normalizeVersion(match[1]);
  return version === null ? null : version.join('.');
}

export function versionMeetsMinimum(version: string | null, minimumVersion: string): boolean {
  const actual = version === null ? null : normalizeVersion(version);
  const minimum = normalizeVersion(minimumVersion);
  if (actual === null || minimum === null) {
    return false;
  }
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) {
      return actual[index] > minimum[index];
    }
  }
  return true;
}

function platformAssetKey(osInfo: SupportedNativeOs, architecture = process.arch): PlatformAssetKey {
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error(
      `Unsupported architecture for prerequisite installation: ${architecture}. Expected x64 or arm64.`,
    );
  }
  return `${osInfo.platform}-${architecture}`;
}

export function resolveManagedPrerequisitePrefix(): string {
  return path.join(os.homedir(), '.local');
}

export function activateManagedPrerequisiteEnvironment(): void {
  const prefix = resolveManagedPrerequisitePrefix();
  prependPath(path.join(prefix, 'bin'));
  const pkgConfigPaths = [path.join(prefix, 'lib', 'pkgconfig'), path.join(prefix, 'lib64', 'pkgconfig')];
  process.env.PKG_CONFIG_PATH = pkgConfigPaths.reduce(
    (current, entry) => prependPathValue(current, entry),
    process.env.PKG_CONFIG_PATH,
  );
}

function logInstallProgress(message: string): void {
  console.error(`[prerequisite] ${message}`);
}

async function runInteractiveCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    verbose: boolean;
  },
): Promise<void> {
  if (options.verbose) {
    logInstallProgress(`Running: ${command} ${args.join(' ')}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const termination = signal === null ? `code ${code ?? 'unknown'}` : `signal ${signal}`;
      reject(new Error(`${command} exited with ${termination}.`));
    });
  });
}

export function prependPathValue(currentPath: string | undefined, entry: string): string {
  const entries = (currentPath ?? '').split(path.delimiter);
  if (!entries.includes(entry)) {
    return [entry, ...entries].filter((value) => value.length > 0).join(path.delimiter);
  }
  return currentPath ?? '';
}

function prependPath(entry: string): void {
  process.env.PATH = prependPathValue(process.env.PATH, entry);
}

async function hashFile(filePath: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function downloadToFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(NodeReadable.fromWeb(response.body), (await fs.open(destination, 'w')).createWriteStream());
}

async function downloadVerifiedArtifact(asset: Artifact, destination: string): Promise<void> {
  await downloadToFile(asset.url, destination);
  const algorithm = asset.sha256 === undefined ? 'sha512' : 'sha256';
  const expected = asset.sha256 ?? asset.sha512;
  const actual = await hashFile(destination, algorithm);
  if (actual !== expected) {
    await fs.rm(destination, { force: true });
    throw new Error(
      `Checksum mismatch for ${asset.url}: expected ${algorithm} ${expected}, got ${actual}.`,
    );
  }
}

async function withVerifiedArtifact(
  asset: Artifact,
  prefix: string,
  run: (artifactPath: string, tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const fileName = path.basename(new URL(asset.url).pathname) || 'artifact';
  const artifactPath = path.join(tempDir, fileName);
  try {
    logInstallProgress(`Downloading official artifact: ${asset.url}`);
    await downloadVerifiedArtifact(asset, artifactPath);
    await run(artifactPath, tempDir);
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}

async function extractSourceArchive(
  archivePath: string,
  tempDir: string,
  options: PrerequisiteInstallExecutionOptions,
): Promise<string> {
  const extractDir = path.join(tempDir, 'source');
  await fs.mkdir(extractDir);
  await runInteractiveCommand('tar', ['-xzf', archivePath, '-C', extractDir], options);
  const entries = (await fs.readdir(extractDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  if (entries.length !== 1) {
    throw new Error(`Expected one source directory in ${archivePath}, found ${entries.length}.`);
  }
  return path.join(extractDir, entries[0].name);
}

async function makeInstall(
  sourceDir: string,
  configureArgs: readonly string[],
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  const buildDir = path.join(path.dirname(sourceDir), 'build');
  await fs.mkdir(buildDir);
  await runInteractiveCommand(path.join(sourceDir, 'configure'), [...configureArgs], {
    ...options,
    cwd: buildDir,
  });
  await runInteractiveCommand('make', ['-j', String(Math.max(1, os.availableParallelism()))], {
    ...options,
    cwd: buildDir,
  });
  await runInteractiveCommand('make', ['install'], { ...options, cwd: buildDir });
}

async function installAutoconfArtifact(
  id: Exclude<OfficialArtifactId, 'cmake' | 'gcc' | 'rust' | 'unzip'>,
  entry: VersionedArtifact,
  extraConfigureArgs: readonly string[],
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  const prefix = resolveManagedPrerequisitePrefix();
  logInstallProgress(`Installing ${id} ${entry.version} from its official provider.`);
  await withVerifiedArtifact(entry.asset, `tokamak-${id}`, async (archivePath, tempDir) => {
    const sourceDir = await extractSourceArchive(archivePath, tempDir, options);
    await makeInstall(sourceDir, [`--prefix=${prefix}`, ...extraConfigureArgs], options);
  });
  activateManagedPrerequisiteEnvironment();
}

async function installRustup(
  osInfo: SupportedNativeOs,
  manifest: PrerequisiteManifest,
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  logInstallProgress(`Installing Rust ${manifest.rust.version} with official rustup.`);
  const cargoHome = path.join(os.homedir(), '.cargo');
  const rustupHome = path.join(os.homedir(), '.rustup');
  const rustEnvironment = {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
  };
  const commandOptions = {
    ...options,
    env: rustEnvironment,
  };
  const probe = createSystemCommandProbe(rustEnvironment);
  if (probe.exists('rustup')) {
    await runInteractiveCommand(
      'rustup',
      ['toolchain', 'install', manifest.rust.version],
      commandOptions,
    );
    await runInteractiveCommand('rustup', ['default', manifest.rust.version], commandOptions);
  } else {
    const asset = manifest.rust.assets[platformAssetKey(osInfo)];
    await withVerifiedArtifact(asset, 'tokamak-rustup', async (installerPath) => {
      await fs.chmod(installerPath, 0o700);
      await runInteractiveCommand(
        installerPath,
        ['-y', '--no-modify-path', '--profile', 'default', '--default-toolchain', manifest.rust.version],
        commandOptions,
      );
    });
  }
  process.env.CARGO_HOME = cargoHome;
  process.env.RUSTUP_HOME = rustupHome;
  prependPath(path.join(cargoHome, 'bin'));
}

async function installAptPackages(
  packages: readonly string[],
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  const probe = createSystemCommandProbe();
  if (!probe.exists('sudo')) {
    throw new Error('sudo is required to install Ubuntu packages, but it is not available on PATH.');
  }
  if (!probe.exists('apt-get')) {
    throw new Error('apt-get is required to install prerequisites on Ubuntu, but it is not available on PATH.');
  }
  logInstallProgress(`Installing bootstrap Ubuntu packages: ${packages.join(', ')}.`);
  await runInteractiveCommand('sudo', ['apt-get', 'update'], options);
  await runInteractiveCommand('sudo', ['apt-get', 'install', '-y', ...packages], options);
}

async function installCmake(
  osInfo: SupportedNativeOs,
  manifest: PrerequisiteManifest,
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  const entry = manifest.cmake;
  logInstallProgress(`Installing CMake ${entry.version} from Kitware's official artifact.`);
  await withVerifiedArtifact(entry.assets[platformAssetKey(osInfo)], 'tokamak-cmake', async (archivePath, tempDir) => {
    const sourceDir = await extractSourceArchive(archivePath, tempDir, options);
    await fs.mkdir(resolveManagedPrerequisitePrefix(), { recursive: true });
    await fs.cp(sourceDir, resolveManagedPrerequisitePrefix(), { force: true, recursive: true });
  });
  activateManagedPrerequisiteEnvironment();
}

async function downloadGccPrerequisites(sourceDir: string): Promise<void> {
  const checksumFile = path.join(sourceDir, 'contrib', 'prerequisites.sha512');
  const lines = (await fs.readFile(checksumFile, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => /^([a-f0-9]{128})\s+(\S+)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
  for (const match of lines) {
    const [, checksum, fileName] = match;
    await downloadVerifiedArtifact(
      {
        url: `https://gcc.gnu.org/pub/gcc/infrastructure/${fileName}`,
        sha512: checksum,
      },
      path.join(sourceDir, fileName),
    );
  }
}

async function installGcc(
  entry: VersionedArtifact,
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  logInstallProgress(`Installing GNU GCC ${entry.version} from its official source release.`);
  await withVerifiedArtifact(entry.asset, 'tokamak-gcc', async (archivePath, tempDir) => {
    const sourceDir = await extractSourceArchive(archivePath, tempDir, options);
    await downloadGccPrerequisites(sourceDir);
    await runInteractiveCommand('/bin/sh', ['contrib/download_prerequisites'], {
      ...options,
      cwd: sourceDir,
    });
    await makeInstall(
      sourceDir,
      [
        `--prefix=${resolveManagedPrerequisitePrefix()}`,
        '--disable-bootstrap',
        '--disable-multilib',
        '--enable-languages=c,c++',
      ],
      options,
    );
  });
  const binDir = path.join(resolveManagedPrerequisitePrefix(), 'bin');
  for (const [linkName, target] of [['cc', 'gcc'], ['c++', 'g++']] as const) {
    const linkPath = path.join(binDir, linkName);
    await fs.rm(linkPath, { force: true });
    await fs.symlink(target, linkPath);
  }
  activateManagedPrerequisiteEnvironment();
}

async function installUnzip(
  entry: VersionedArtifact,
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  logInstallProgress(`Installing Info-ZIP UnZip ${entry.version} from its official source release.`);
  await withVerifiedArtifact(entry.asset, 'tokamak-unzip', async (archivePath, tempDir) => {
    const sourceDir = await extractSourceArchive(archivePath, tempDir, options);
    await runInteractiveCommand('make', ['-f', 'unix/Makefile', 'generic'], {
      ...options,
      cwd: sourceDir,
    });
    await runInteractiveCommand(
      'make',
      ['-f', 'unix/Makefile', `prefix=${resolveManagedPrerequisitePrefix()}`, 'install'],
      { ...options, cwd: sourceDir },
    );
  });
  activateManagedPrerequisiteEnvironment();
}

async function installOfficialArtifact(
  id: OfficialArtifactId,
  osInfo: SupportedNativeOs,
  manifest: PrerequisiteManifest,
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  switch (id) {
    case 'rust':
      await installRustup(osInfo, manifest, options);
      return;
    case 'cmake':
      await installCmake(osInfo, manifest, options);
      return;
    case 'gcc':
      await installGcc(manifest.linuxToolchain.gcc, options);
      return;
    case 'make':
      await installAutoconfArtifact('make', manifest.linuxToolchain.make, [], options);
      return;
    case 'pkg-config':
      await installAutoconfArtifact('pkg-config', manifest.pkgConfig, ['--with-internal-glib'], options);
      return;
    case 'tar':
      await installAutoconfArtifact('tar', manifest.tar, [], options);
      return;
    case 'unzip':
      await installUnzip(manifest.unzip, options);
  }
}

export async function executePrerequisiteInstallationPlan(
  plan: PrerequisiteInstallationPlan,
  options: PrerequisiteInstallExecutionOptions,
): Promise<PrerequisiteInstallExecutionResult> {
  const manifest = loadPrerequisiteManifest();
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'apt-bootstrap':
        await installAptPackages(action.packages, options);
        break;
      case 'official-artifact':
        await installOfficialArtifact(action.id, plan.os, manifest, options);
        break;
      case 'xcode-command-line-tools':
        logInstallProgress('Launching Apple\'s Command Line Tools installer.');
        await runInteractiveCommand('xcode-select', ['--install'], options);
        return 'rerun-required';
    }
  }
  return 'complete';
}

interface PrerequisiteDefinition {
  commands: (os: SupportedNativeOs) => readonly string[];
  id: ManagedPrerequisiteId;
  label: string;
  minimumVersion: (manifest: PrerequisiteManifest) => string;
  versionArgs: readonly string[];
}

const PREREQUISITE_DEFINITIONS: readonly PrerequisiteDefinition[] = [
  {
    id: 'rust',
    label: 'Rust',
    commands: () => ['rustc'],
    minimumVersion: (manifest) => manifest.rust.minimumVersion,
    versionArgs: ['--version'],
  },
  {
    id: 'cargo',
    label: 'Cargo',
    commands: () => ['cargo'],
    minimumVersion: (manifest) => manifest.rust.minimumVersion,
    versionArgs: ['--version'],
  },
  {
    id: 'cmake',
    label: 'CMake',
    commands: () => ['cmake'],
    minimumVersion: (manifest) => manifest.cmake.minimumVersion,
    versionArgs: ['--version'],
  },
  {
    id: 'pkg-config',
    label: 'pkg-config',
    commands: () => ['pkg-config'],
    minimumVersion: (manifest) => manifest.pkgConfig.minimumVersion,
    versionArgs: ['--version'],
  },
  {
    id: 'tar',
    label: 'tar',
    commands: () => ['tar'],
    minimumVersion: (manifest) => manifest.tar.minimumVersion,
    versionArgs: ['--version'],
  },
  {
    id: 'unzip',
    label: 'unzip',
    commands: () => ['unzip'],
    minimumVersion: (manifest) => manifest.unzip.minimumVersion,
    versionArgs: ['-v'],
  },
];

function detectToolchainStatus(
  osInfo: SupportedNativeOs,
  probe: CommandProbe,
  manifest: PrerequisiteManifest,
): PrerequisiteStatus {
  if (osInfo.platform === 'macos') {
    const commands = ['cc', 'c++', 'install_name_tool'];
    const installed = commands.every((command) => probe.exists(command));
    const version = installed ? extractNumericVersion(probe.version('cc', ['--version'])) : null;
    const minimumVersion = manifest.appleCommandLineTools.minimumClangVersion;
    return {
      compatible: installed && versionMeetsMinimum(version, minimumVersion),
      commands,
      id: 'toolchain',
      installed,
      label: 'Apple C/C++ toolchain',
      requirement: `Apple Clang ${minimumVersion} or newer`,
      version,
    };
  }

  const commands = ['gcc', 'g++', 'make'];
  const installed = commands.every((command) => probe.exists(command));
  const gccVersion = probe.exists('gcc')
    ? extractNumericVersion(probe.version('gcc', ['--version']))
    : null;
  const makeVersion = probe.exists('make')
    ? extractNumericVersion(probe.version('make', ['--version']))
    : null;
  const incompatibleComponents: LinuxToolchainComponent[] = [];
  if (
    !probe.exists('gcc')
    || !probe.exists('g++')
    || !versionMeetsMinimum(gccVersion, manifest.linuxToolchain.gcc.minimumVersion)
  ) {
    incompatibleComponents.push('gcc');
  }
  if (!probe.exists('make') || !versionMeetsMinimum(makeVersion, manifest.linuxToolchain.make.minimumVersion)) {
    incompatibleComponents.push('make');
  }
  return {
    compatible: incompatibleComponents.length === 0,
    commands,
    id: 'toolchain',
    incompatibleComponents,
    installed,
    label: 'GNU C/C++ toolchain',
    requirement: [
      `GCC ${manifest.linuxToolchain.gcc.minimumVersion} or newer`,
      `GNU Make ${manifest.linuxToolchain.make.minimumVersion} or newer`,
    ].join('; '),
    version: gccVersion === null && makeVersion === null
      ? null
      : `GCC ${gccVersion ?? 'unknown'}, GNU Make ${makeVersion ?? 'unknown'}`,
  };
}

export function detectManagedPrerequisites(
  osInfo: SupportedNativeOs,
  probe: CommandProbe = createSystemCommandProbe(),
  manifest: PrerequisiteManifest = loadPrerequisiteManifest(),
): PrerequisiteStatus[] {
  const statuses = PREREQUISITE_DEFINITIONS.map((definition) => {
    const commands = definition.commands(osInfo);
    const commandsPresent = commands.every((command) => probe.exists(command));
    const version = commandsPresent
      ? extractNumericVersion(probe.version(commands[0], definition.versionArgs))
      : null;
    const minimumVersion = definition.minimumVersion(manifest);
    return {
      compatible: commandsPresent && versionMeetsMinimum(version, minimumVersion),
      commands,
      id: definition.id,
      installed: commandsPresent,
      label: definition.label,
      requirement: `version ${minimumVersion} or newer`,
      version,
    };
  });
  statuses.splice(3, 0, detectToolchainStatus(osInfo, probe, manifest));
  return statuses;
}

export function prerequisiteVerificationFailures(
  statuses: readonly PrerequisiteStatus[],
): string[] {
  return statuses.flatMap((status) => {
    if (!status.installed) {
      return [`${status.label}: required command(s) not found: ${status.commands.join(', ')}`];
    }
    if (status.version === null) {
      return [`${status.label}: installed commands were found, but version verification failed`];
    }
    if (!status.compatible) {
      return [
        `${status.label}: installed version ${status.version} is incompatible; requires ${status.requirement}`,
      ];
    }
    return [];
  });
}

function installationTargetIds(statuses: readonly PrerequisiteStatus[]): Set<ManagedPrerequisiteId> {
  return new Set(
    statuses
      .filter((status) => !status.compatible)
      .map((status) => status.id),
  );
}

export function buildPrerequisiteInstallationPlan(
  osInfo: SupportedNativeOs,
  statuses: readonly PrerequisiteStatus[],
): PrerequisiteInstallationPlan {
  const targets = installationTargetIds(statuses);
  const actions: PrerequisiteInstallationAction[] = [];
  const toolchain = statuses.find((status) => status.id === 'toolchain');

  if (osInfo.platform === 'linux') {
    const components = new Set(toolchain?.incompatibleComponents ?? []);
    if (components.has('gcc')) {
      actions.push({ kind: 'apt-bootstrap', packages: ['build-essential'] });
    }
    if (components.has('make')) {
      actions.push({ id: 'make', kind: 'official-artifact' });
    }
    if (components.has('gcc')) {
      actions.push({ id: 'gcc', kind: 'official-artifact' });
    }
  } else if (targets.has('toolchain')) {
      actions.push({ kind: 'xcode-command-line-tools' });
  }

  for (const id of ['tar', 'cmake', 'pkg-config', 'unzip'] as const) {
    if (targets.has(id)) {
      actions.push({ id, kind: 'official-artifact' });
    }
  }
  if (targets.has('rust') || targets.has('cargo')) {
    actions.push({ id: 'rust', kind: 'official-artifact' });
  }
  return { actions, os: osInfo, statuses };
}

function actionDescription(action: PrerequisiteInstallationAction): string {
  const manifest = loadPrerequisiteManifest();
  switch (action.kind) {
    case 'apt-bootstrap':
      return [
        'Install Ubuntu bootstrap build tools; these do not satisfy the final GNU toolchain target.',
        '`sudo apt-get update`',
        `\`sudo apt-get install -y ${action.packages.join(' ')}\``,
      ].join('\n      ');
    case 'official-artifact': {
      const versions: Record<OfficialArtifactId, string> = {
        cmake: manifest.cmake.version,
        gcc: manifest.linuxToolchain.gcc.version,
        make: manifest.linuxToolchain.make.version,
        'pkg-config': manifest.pkgConfig.version,
        rust: manifest.rust.version,
        tar: manifest.tar.version,
        unzip: manifest.unzip.version,
      };
      return action.id === 'rust'
        ? `Install official Rust ${versions[action.id]} with rustup into ~/.rustup and ~/.cargo.`
        : `Download, verify, and install official ${action.id} ${versions[action.id]} into ~/.local.`;
    }
    case 'xcode-command-line-tools':
      return [
        'Launch Apple\'s Command Line Tools installer with `xcode-select --install`.',
        'The CLI will stop after launching it; rerun the install after Apple\'s installer finishes.',
      ].join('\n      ');
  }
}

function osDescription(os: SupportedNativeOs): string {
  return os.platform === 'macos' ? 'macOS' : `Ubuntu ${os.ubuntuVersion}`;
}

export function renderPrerequisiteInstallationPlan(plan: PrerequisiteInstallationPlan): string {
  const lines = [
    'Prerequisite installation plan',
    `  Operating system: ${osDescription(plan.os)}`,
    '',
    '  Detection results:',
  ];
  for (const status of plan.statuses) {
    let detail: string;
    if (!status.installed) {
      detail = `missing (${status.commands.join(', ')}); requires ${status.requirement}`;
    } else if (status.version === null) {
      detail = `present, but version verification failed; requires ${status.requirement}`;
    } else if (!status.compatible) {
      detail = `installed but incompatible (${status.version}); requires ${status.requirement}`;
    } else {
      detail = `installed and compatible (${status.version})`;
    }
    lines.push(`    - ${status.label}: ${detail}`);
  }

  lines.push('', '  Planned actions:');
  if (plan.actions.length === 0) {
    lines.push('    - None. All managed prerequisites are already installed.');
  } else {
    plan.actions.forEach((action, index) => {
      lines.push(`    ${index + 1}. ${actionDescription(action)}`);
    });
  }

  lines.push(
    '',
    '  Important notices:',
    '    - Missing and incompatible tools are installation targets; compatible tools are retained.',
    '    - CLI-downloaded artifacts come directly from official providers and are checksum-verified.',
    '    - Ubuntu uses sudo only for the build-essential bootstrap and may modify system directories.',
    '    - Official source builds can take substantial time, CPU, memory, network, and disk space.',
    '    - Apple Command Line Tools are delivered by Apple\'s signed Software Update without a pinned URL.',
    '    - Official artifacts install under ~/.local; Rust and Cargo use ~/.rustup and ~/.cargo.',
    '    - `tokamak-cli --uninstall` does not remove any prerequisite installed here.',
    '    - Review this plan and your organization\'s security policies before approving.',
  );
  return lines.join('\n');
}

export function isPrerequisiteConfirmationAccepted(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

export function assertPrerequisiteInstallMayRunAsCurrentUser(
  getUid: (() => number) | undefined = process.getuid,
): void {
  if (getUid?.() === 0) {
    throw new Error(
      '`--include-prerequisite` must not be run as root. Run tokamak-cli as your normal user; the CLI invokes sudo only for Ubuntu package-manager commands.',
    );
  }
}

export function assertPrerequisiteInstallIsInteractive(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): void {
  if (!('isTTY' in input) || input.isTTY !== true || !('isTTY' in output) || output.isTTY !== true) {
    throw new Error(
      '`--include-prerequisite` is interactive and requires a terminal (TTY). It cannot run unattended.',
    );
  }
}

export async function confirmPrerequisiteInstallation(
  plan: PrerequisiteInstallationPlan,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<boolean> {
  assertPrerequisiteInstallIsInteractive(input, output);

  output.write(`${renderPrerequisiteInstallationPlan(plan)}\n\n`);
  const prompt = createInterface({ input, output });
  let answer = '';
  let resolveEnd: (() => void) | undefined;
  const inputEnded = new Promise<void>((resolve) => {
    resolveEnd = resolve;
    input.once('end', resolve);
    input.once('close', resolve);
  });
  try {
    const response = prompt
      .question('Proceed with prerequisite installation? [y/N] ')
      .catch(() => '');
    answer = await Promise.race([
      response,
      inputEnded.then(() => ''),
    ]);
  } catch {
    answer = '';
  } finally {
    if (resolveEnd !== undefined) {
      input.off('end', resolveEnd);
      input.off('close', resolveEnd);
    }
    prompt.close();
  }
  return isPrerequisiteConfirmationAccepted(answer);
}
