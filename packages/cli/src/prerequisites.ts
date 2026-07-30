import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import {
  commandExists,
  createSystemCommandProbe,
  type CommandProbe,
} from './system.js';

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
  installed: boolean;
  label: string;
  requirement: string;
  version: string | null;
}

export type PrerequisiteInstallationAction =
  | {
      kind: 'apt';
      packages: readonly string[];
    }
  | {
      kind: 'kitware-cmake';
    }
  | {
      kind: 'brew';
      formulas: readonly string[];
    }
  | {
      kind: 'homebrew';
    }
  | {
      kind: 'rustup';
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

const MINIMUM_RUST_VERSION = '1.85.0';
const MINIMUM_CMAKE_VERSION = '3.18.0';

interface CmakeManifest {
  assets: Record<'arm64' | 'x64', {
    sha256: string;
    url: string;
  }>;
  minimumCompatibleVersion: string;
  version: string;
}

export interface OsRelease {
  [key: string]: string;
}

function extractNumericVersion(output: string | null): string | null {
  const match = output === null ? null : /(?:^|\D)(\d+\.\d+(?:\.\d+)?)(?:\D|$)/u.exec(output);
  return match === null ? null : match[1];
}

function versionParts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(version);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function versionMeetsMinimum(version: string | null, minimumVersion: string): boolean {
  const actual = version === null ? null : versionParts(version);
  const minimum = versionParts(minimumVersion);
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

function logInstallProgress(message: string): void {
  console.error(`[prerequisite] ${message}`);
}

async function runInteractiveCommand(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    verbose: boolean;
  },
): Promise<void> {
  if (options.verbose) {
    logInstallProgress(`Running: ${command} ${args.join(' ')}`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
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

async function withDownloadedInstaller(
  url: string,
  prefix: string,
  run: (installerPath: string) => Promise<void>,
  expectedSha256?: string,
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const installerPath = path.join(tempDir, 'install.sh');
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const contents = new Uint8Array(await response.arrayBuffer());
    if (expectedSha256 !== undefined) {
      const actualSha256 = createHash('sha256').update(contents).digest('hex');
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `Downloaded installer from ${url} has SHA-256 ${actualSha256}, expected ${expectedSha256}.`,
        );
      }
    }
    await fs.writeFile(installerPath, contents, {
      mode: 0o700,
    });
    await run(installerPath);
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
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

export function activateManagedPrerequisiteEnvironment(): void {
  prependPath(path.join(os.homedir(), '.local', 'bin'));
  prependPath(path.join(os.homedir(), '.cargo', 'bin'));
}

async function installRustup(options: PrerequisiteInstallExecutionOptions): Promise<void> {
  logInstallProgress('Installing the latest stable Rust toolchain with rustup.');
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
    await runInteractiveCommand('rustup', ['toolchain', 'install', 'stable'], commandOptions);
    await runInteractiveCommand('rustup', ['default', 'stable'], commandOptions);
  } else {
    await withDownloadedInstaller('https://sh.rustup.rs', 'tokamak-rustup', async (installerPath) => {
      await runInteractiveCommand(
        '/bin/sh',
        [installerPath, '-y', '--default-toolchain', 'stable'],
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
  logInstallProgress(`Installing Ubuntu packages: ${packages.join(', ')}.`);
  await runInteractiveCommand('sudo', ['apt-get', 'update'], options);
  await runInteractiveCommand('sudo', ['apt-get', 'install', '-y', ...packages], options);
}

async function loadCmakeManifest(): Promise<CmakeManifest> {
  const manifestPath = path.resolve(__dirname, '..', 'manifests', 'cmake-v4.4.0.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<CmakeManifest>;
  if (
    typeof manifest.version !== 'string'
    || manifest.minimumCompatibleVersion !== MINIMUM_CMAKE_VERSION
    || typeof manifest.assets !== 'object'
    || manifest.assets === null
  ) {
    throw new Error(`Invalid CMake prerequisite manifest: ${manifestPath}.`);
  }
  for (const architecture of ['x64', 'arm64'] as const) {
    const asset = manifest.assets[architecture];
    if (
      typeof asset?.url !== 'string'
      || !asset.url.startsWith('https://cmake.org/')
      || typeof asset.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) {
      throw new Error(`Invalid ${architecture} asset in CMake prerequisite manifest: ${manifestPath}.`);
    }
  }
  return manifest as CmakeManifest;
}

async function installKitwareCmake(options: PrerequisiteInstallExecutionOptions): Promise<void> {
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error(
      `Official CMake installation supports x64 and arm64, but this host reports ${process.arch}.`,
    );
  }
  const manifest = await loadCmakeManifest();
  const asset = manifest.assets[process.arch];
  const installPrefix = path.join(os.homedir(), '.local');
  await fs.mkdir(installPrefix, { recursive: true });
  logInstallProgress(
    `Installing Kitware CMake ${manifest.version} into ${installPrefix}.`,
  );
  await withDownloadedInstaller(
    asset.url,
    'tokamak-cmake',
    async (installerPath) => {
      await runInteractiveCommand(
        '/bin/sh',
        [installerPath, '--skip-license', `--prefix=${installPrefix}`],
        options,
      );
    },
    asset.sha256,
  );
  prependPath(path.join(installPrefix, 'bin'));
}

function resolveBrewExecutable(): string | null {
  const candidates = [
    '/opt/homebrew/bin/brew',
    '/usr/local/bin/brew',
    '/home/linuxbrew/.linuxbrew/bin/brew',
  ];
  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }
  return createSystemCommandProbe().exists('brew') ? 'brew' : null;
}

function refreshHomebrewEnvironment(brewExecutable: string): void {
  const result = spawnSync(
    '/bin/sh',
    ['-c', 'eval "$("$1" shellenv)"; env -0', 'tokamak-homebrew-shellenv', brewExecutable],
    {
      encoding: 'buffer',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Unable to load Homebrew shell environment: ${result.stderr.toString('utf8').trim()}`,
    );
  }

  const allowedVariables = new Set([
    'HOMEBREW_CELLAR',
    'HOMEBREW_PREFIX',
    'HOMEBREW_REPOSITORY',
    'INFOPATH',
    'MANPATH',
    'PATH',
  ]);
  for (const entry of result.stdout.toString('utf8').split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = entry.slice(0, separator);
    if (allowedVariables.has(name)) {
      process.env[name] = entry.slice(separator + 1);
    }
  }
}

async function installHomebrew(options: PrerequisiteInstallExecutionOptions): Promise<void> {
  logInstallProgress('Installing Homebrew with the official upstream installer.');
  await withDownloadedInstaller(
    'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh',
    'tokamak-homebrew',
    async (installerPath) => {
      await runInteractiveCommand('/bin/bash', [installerPath], options);
    },
  );
  const brewExecutable = resolveBrewExecutable();
  if (brewExecutable === null) {
    throw new Error('Homebrew installation completed, but brew could not be found.');
  }
  refreshHomebrewEnvironment(brewExecutable);
}

function brewFormulaPrefix(brewExecutable: string, formula: string): string {
  const result = spawnSync(brewExecutable, ['--prefix', formula], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Unable to resolve the Homebrew prefix for ${formula}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function installBrewFormulas(
  formulas: readonly string[],
  options: PrerequisiteInstallExecutionOptions,
): Promise<void> {
  const brewExecutable = resolveBrewExecutable();
  if (brewExecutable === null) {
    throw new Error('Homebrew is required to install the missing macOS prerequisites.');
  }
  refreshHomebrewEnvironment(brewExecutable);
  for (const formula of formulas) {
    const installed = spawnSync(brewExecutable, ['list', '--versions', formula], {
      env: process.env,
      stdio: 'ignore',
    }).status === 0;
    const operation = installed ? 'upgrade' : 'install';
    logInstallProgress(`${operation === 'install' ? 'Installing' : 'Upgrading'} Homebrew formula: ${formula}.`);
    await runInteractiveCommand(brewExecutable, [operation, formula], options);
  }

  if (formulas.includes('gnu-tar')) {
    prependPath(path.join(brewFormulaPrefix(brewExecutable, 'gnu-tar'), 'libexec', 'gnubin'));
  }
  if (formulas.includes('unzip')) {
    prependPath(path.join(brewFormulaPrefix(brewExecutable, 'unzip'), 'bin'));
  }
}

export async function executePrerequisiteInstallationPlan(
  plan: PrerequisiteInstallationPlan,
  options: PrerequisiteInstallExecutionOptions,
): Promise<PrerequisiteInstallExecutionResult> {
  for (const action of plan.actions) {
    switch (action.kind) {
      case 'apt':
        await installAptPackages(action.packages, options);
        break;
      case 'kitware-cmake':
        await installKitwareCmake(options);
        break;
      case 'brew':
        await installBrewFormulas(action.formulas, options);
        break;
      case 'homebrew':
        await installHomebrew(options);
        break;
      case 'rustup':
        await installRustup(options);
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
  minimumVersion?: string;
  versionArgs: readonly string[];
}

const PREREQUISITE_DEFINITIONS: readonly PrerequisiteDefinition[] = [
  {
    id: 'rust',
    label: 'Rust',
    commands: () => ['rustc'],
    minimumVersion: MINIMUM_RUST_VERSION,
    versionArgs: ['--version'],
  },
  {
    id: 'cargo',
    label: 'Cargo',
    commands: () => ['cargo'],
    minimumVersion: MINIMUM_RUST_VERSION,
    versionArgs: ['--version'],
  },
  {
    id: 'cmake',
    label: 'CMake',
    commands: () => ['cmake'],
    minimumVersion: MINIMUM_CMAKE_VERSION,
    versionArgs: ['--version'],
  },
  {
    id: 'toolchain',
    label: 'C/C++ toolchain',
    commands: (os) =>
      os.platform === 'macos' ? ['cc', 'c++', 'install_name_tool'] : ['cc', 'c++', 'make'],
    versionArgs: ['--version'],
  },
  {
    id: 'pkg-config',
    label: 'pkg-config',
    commands: () => ['pkg-config'],
    versionArgs: ['--version'],
  },
  {
    id: 'tar',
    label: 'tar',
    commands: () => ['tar'],
    versionArgs: ['--version'],
  },
  {
    id: 'unzip',
    label: 'unzip',
    commands: () => ['unzip'],
    versionArgs: ['-v'],
  },
];

export function detectManagedPrerequisites(
  os: SupportedNativeOs,
  probe: CommandProbe = createSystemCommandProbe(),
): PrerequisiteStatus[] {
  return PREREQUISITE_DEFINITIONS.map((definition) => {
    const commands = definition.commands(os);
    const commandsPresent = commands.every((command) => probe.exists(command));
    const version = commandsPresent
      ? probe.version(commands[0], definition.versionArgs)
      : null;
    const requirement = definition.minimumVersion === undefined
      ? 'an installed command with verifiable version output'
      : `version ${definition.minimumVersion} or newer`;
    return {
      compatible: commandsPresent
        && version !== null
        && (
          definition.minimumVersion === undefined
          || versionMeetsMinimum(extractNumericVersion(version), definition.minimumVersion)
        ),
      commands,
      id: definition.id,
      installed: commandsPresent,
      label: definition.label,
      requirement,
      version,
    };
  });
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
      return [`${status.label}: ${status.version} does not satisfy ${status.requirement}`];
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
  os: SupportedNativeOs,
  statuses: readonly PrerequisiteStatus[],
  homebrewInstalled = false,
): PrerequisiteInstallationPlan {
  const targets = installationTargetIds(statuses);
  const actions: PrerequisiteInstallationAction[] = [];

  if (os.platform === 'linux') {
    const packages: string[] = [];
    if (targets.has('toolchain')) packages.push('build-essential');
    if (targets.has('cmake') && os.ubuntuVersion === '22.04') packages.push('cmake');
    if (targets.has('pkg-config')) packages.push('pkg-config');
    if (targets.has('tar')) packages.push('tar');
    if (targets.has('unzip')) packages.push('unzip');
    if (packages.length > 0) {
      actions.push({ kind: 'apt', packages });
    }
    if (targets.has('cmake') && os.ubuntuVersion === '20.04') {
      actions.push({ kind: 'kitware-cmake' });
    }
  } else {
    if (targets.has('toolchain')) {
      actions.push({ kind: 'xcode-command-line-tools' });
    }

    const formulas: string[] = [];
    if (targets.has('cmake')) formulas.push('cmake');
    if (targets.has('pkg-config')) formulas.push('pkg-config');
    if (targets.has('tar')) formulas.push('gnu-tar');
    if (targets.has('unzip')) formulas.push('unzip');
    if (formulas.length > 0) {
      if (!homebrewInstalled) {
        actions.push({ kind: 'homebrew' });
      }
      actions.push({ kind: 'brew', formulas });
    }
  }

  if (targets.has('rust') || targets.has('cargo')) {
    actions.push({ kind: 'rustup' });
  }

  return { actions, os, statuses };
}

function actionDescription(action: PrerequisiteInstallationAction): string {
  switch (action.kind) {
    case 'apt':
      return [
        '`sudo apt-get update`',
        `\`sudo apt-get install -y ${action.packages.join(' ')}\``,
      ].join('\n      ');
    case 'kitware-cmake':
      return [
        'Download the manifest-pinned official Kitware CMake binary.',
        'Verify its SHA-256 checksum and install it under `~/.local`.',
      ].join('\n      ');
    case 'brew':
      return `Install or upgrade as needed with Homebrew: ${action.formulas.join(', ')}.`;
    case 'homebrew':
      return 'Download and run the official Homebrew installer from brew.sh.';
    case 'rustup':
      return [
        'Install the latest stable Rust toolchain with the official rustup installer.',
        'Use the standard ~/.rustup and ~/.cargo directories.',
      ].join('\n      ');
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
    '    - Missing or incompatible tools are installed; compatible tools are not upgraded or replaced.',
    '    - Downloads and package-manager operations contact third-party services.',
    '    - Ubuntu package installation uses sudo for apt only and may modify system directories.',
    '    - Ubuntu 20.04 receives checksum-verified CMake from Kitware under ~/.local.',
    '    - The Homebrew installer may request administrator authentication.',
    '    - Homebrew and rustup run their official upstream installers and modify their standard locations.',
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
