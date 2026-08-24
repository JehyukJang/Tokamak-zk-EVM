import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { CliPlatform, RuntimeContext, RuntimeState } from './model.js';

type DockerHostPlatform = 'linux' | 'windows';

const CACHE_DIR_ENV = 'TOKAMAK_ZKEVM_CLI_CACHE_DIR';
const MAX_U64 = 18_446_744_073_709_551_615n;

export function detectPlatform(): CliPlatform {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      throw new Error(
        `Unsupported platform: ${process.platform}. Native tokamak-cli installs currently support only macOS and Linux. Use WSL2 or Docker Desktop with \`--install --docker\` on Windows.`,
      );
  }
}

function detectDockerHostPlatform(): DockerHostPlatform {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    case 'darwin':
      throw new Error('`tokamak-cli --install --docker` is not supported on macOS hosts.');
    default:
      throw new Error(
        `Unsupported Docker host platform: ${process.platform}. Use Linux or Windows with Docker Desktop.`,
      );
  }
}

export function resolveCacheRoot(): string {
  const configured = process.env[CACHE_DIR_ENV]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.tokamak-zk-evm');
}

export function resolvePackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function normalizeCompatibleBackendVersion(value: string, label: string): string {
  const [major, minor] = parseCanonicalVersion(value, label, 'MAJOR.MINOR', 2);
  return `${major}.${minor}`;
}

export function packageCompatibleVersion(packageVersion: string, label: string): string {
  const [major, minor] = parseCanonicalVersion(packageVersion, label, 'MAJOR.MINOR.PATCH', 3);
  return `${major}.${minor}`;
}

function parseCanonicalVersion(
  value: string,
  label: string,
  expected: 'MAJOR.MINOR' | 'MAJOR.MINOR.PATCH',
  componentCount: number,
): bigint[] {
  const components = value.split('.');
  if (components.length !== componentCount) {
    throw new Error(`${label} must be canonical ${expected}, got ${JSON.stringify(value)} (wrong component count).`);
  }
  return components.map(component => parseCanonicalComponent(component, label, expected, value));
}

function parseCanonicalComponent(component: string, label: string, expected: string, originalValue: string): bigint {
  if (!/^[0-9]+$/u.test(component)) {
    throw new Error(
      `${label} must be canonical ${expected}, got ${JSON.stringify(originalValue)} (components must contain ASCII digits).`,
    );
  }
  if (component.length > 1 && component.startsWith('0')) {
    throw new Error(
      `${label} must be canonical ${expected}, got ${JSON.stringify(originalValue)} (leading zeroes are not canonical).`,
    );
  }
  const numeric = BigInt(component);
  if (numeric > MAX_U64) {
    throw new Error(
      `${label} must be canonical ${expected}, got ${JSON.stringify(originalValue)} (numeric component is out of range).`,
    );
  }
  return numeric;
}

async function resolvePackageMetadata(packageRoot: string): Promise<{
  compatibleBackendVersion: string;
  packageVersion: string;
}> {
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
    tokamakZkEvm?: {
      compatibleBackendVersion?: string;
    };
    version?: string;
  };
  if (!manifest.version) {
    throw new Error(`Package version is missing from ${manifestPath}.`);
  }
  const configuredCompatibleVersion = manifest.tokamakZkEvm?.compatibleBackendVersion;
  if (!configuredCompatibleVersion) {
    throw new Error(`Compatible backend version is missing from ${manifestPath}.`);
  }
  const packageVersion = manifest.version;
  const compatibleBackendVersion = normalizeCompatibleBackendVersion(
    configuredCompatibleVersion,
    `${manifestPath} tokamakZkEvm.compatibleBackendVersion`,
  );
  const expectedCompatibleVersion = packageCompatibleVersion(packageVersion, `${manifestPath} version`);
  if (compatibleBackendVersion !== expectedCompatibleVersion) {
    throw new Error(
      `${manifestPath} compatible backend version ${compatibleBackendVersion} must match package major.minor ${expectedCompatibleVersion}.`,
    );
  }
  return { compatibleBackendVersion, packageVersion };
}

async function createRuntimeContextForPlatform(platform: CliPlatform): Promise<RuntimeContext> {
  const packageRoot = resolvePackageRoot();
  const { compatibleBackendVersion, packageVersion } = await resolvePackageMetadata(packageRoot);
  const cacheRoot = resolveCacheRoot();
  const platformDir = path.join(cacheRoot, platform);
  return {
    cacheRoot,
    packageRoot,
    platform,
    platformDir,
    runtimeDir: path.join(platformDir, 'runtime'),
    statePath: path.join(platformDir, 'installation.json'),
    compatibleBackendVersion,
    packageVersion,
  };
}

export async function createRuntimeContext(): Promise<RuntimeContext> {
  return await createRuntimeContextForPlatform(detectPlatform());
}

export async function createDockerRuntimeContext(): Promise<RuntimeContext> {
  detectDockerHostPlatform();
  return await createRuntimeContextForPlatform('linux');
}

export async function readInstalledState(platform: CliPlatform): Promise<RuntimeState | null> {
  const statePath = path.join(resolveCacheRoot(), platform, 'installation.json');
  try {
    const contents = await fs.readFile(statePath, 'utf8');
    return JSON.parse(contents) as RuntimeState;
  } catch {
    return null;
  }
}

export async function requireInstalledRuntime(): Promise<RuntimeContext> {
  if (process.platform === 'win32') {
    const context = await createDockerRuntimeContext();
    const state = await readInstalledState(context.platform);
    if (state?.installMode !== 'docker') {
      throw new Error('Tokamak zk-EVM Docker runtime is not installed. Run `tokamak-cli --install --docker` first.');
    }
    await fs.access(context.runtimeDir);
    return {
      ...context,
      compatibleBackendVersion: packageCompatibleVersion(state.packageVersion, 'installed package version'),
      packageVersion: state.packageVersion,
    };
  }

  const context = await createRuntimeContext();
  const state = await readInstalledState(context.platform);
  if (state === null) {
    throw new Error('Tokamak zk-EVM runtime is not installed. Run `tokamak-cli --install` first.');
  }
  await fs.access(context.runtimeDir);
  return {
    ...context,
    compatibleBackendVersion: packageCompatibleVersion(state.packageVersion, 'installed package version'),
    packageVersion: state.packageVersion,
  };
}

export async function removeDirectoryIfEmpty(target: string): Promise<void> {
  try {
    const entries = await fs.readdir(target);
    if (entries.length === 0) {
      await fs.rmdir(target);
    }
  } catch {
    // Ignore missing directories or directories that cannot be removed.
  }
}

export function runtimePaths(context: RuntimeContext) {
  const resourceDir = path.join(context.runtimeDir, 'resource');
  const setupOutputDir = path.join(resourceDir, 'setup', 'output');
  const synthOutputDir = path.join(resourceDir, 'synthesizer', 'output');
  const preprocessOutputDir = path.join(resourceDir, 'preprocess', 'output');
  const proveOutputDir = path.join(resourceDir, 'prove', 'output');
  const binaryDir = path.join(context.runtimeDir, 'bin');
  const icicleLibDir = path.join(context.runtimeDir, 'backend-lib', 'icicle', 'lib');
  return {
    resourceDir,
    setupOutputDir,
    synthOutputDir,
    preprocessOutputDir,
    proveOutputDir,
    binaryDir,
    icicleLibDir,
    preprocessBinary: path.join(binaryDir, 'preprocess'),
    proveBinary: path.join(binaryDir, 'prove'),
    verifyBinary: path.join(binaryDir, 'verify'),
    trustedSetupBinary: path.join(binaryDir, 'trusted-setup'),
  };
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function emptyDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

function prependEnvPath(existing: string | undefined, nextValue: string): string {
  return existing && existing.length > 0 ? `${nextValue}:${existing}` : nextValue;
}

export function backendEnvironment(context: RuntimeContext): NodeJS.ProcessEnv {
  const paths = runtimePaths(context);
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.LD_LIBRARY_PATH = prependEnvPath(env.LD_LIBRARY_PATH, paths.icicleLibDir);
  if (context.platform === 'macos') {
    env.DYLD_LIBRARY_PATH = prependEnvPath(env.DYLD_LIBRARY_PATH, paths.icicleLibDir);
    env.ICICLE_BACKEND_INSTALL_DIR = path.join(paths.icicleLibDir, 'backend');
    return env;
  }

  const backendDir = path.join(paths.icicleLibDir, 'backend');
  env.ICICLE_BACKEND_INSTALL_DIR = '';
  if (process.platform === 'linux') {
    env.ICICLE_BACKEND_INSTALL_DIR = backendDir;
  }
  return env;
}

export async function writeRuntimeState(context: RuntimeContext, state: RuntimeState): Promise<void> {
  await ensureDir(path.dirname(context.statePath));
  await fs.writeFile(context.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
