import fs from 'node:fs/promises';
import {
  activateManagedPrerequisiteEnvironment,
  assertPrerequisiteInstallMayRunAsCurrentUser,
  assertPrerequisiteInstallIsInteractive,
  buildPrerequisiteInstallationPlan,
  confirmPrerequisiteInstallation,
  detectManagedPrerequisites,
  detectSupportedNativeOs,
  executePrerequisiteInstallationPlan,
  prerequisiteVerificationFailures,
  renderPrerequisiteInstallationPlan,
  type SupportedNativeOs,
} from './prerequisites.js';
import {
  createDockerRuntimeContext,
  createRuntimeContext,
  emptyDir,
  removeDirectoryIfEmpty,
  writeRuntimeState,
} from './runtime/context.js';
import { installDockerRuntime } from './runtime/docker.js';
import { installIcicleRuntime } from './runtime/icicle.js';
import {
  buildBackendReleaseBinaries,
  configureMacosRuntime,
  copyBuiltBackendBinaries,
  ensureVendoredBackendExists,
} from './runtime/native.js';
import { installDownloadedSetup, runTrustedSetup, writeSkippedSetupNotice } from './runtime/setup.js';
import type { CliPlatform, InstallOptions, RuntimeContext, RuntimeState } from './runtime/model.js';

interface PrerequisiteFailure {
  name: string;
  reason: string;
}
import { commandExists, createSystemCommandProbe, logVerbose } from './system.js';

export {
  createRuntimeContext,
  detectPlatform,
  readInstalledState,
  requireInstalledRuntime,
  resolveCacheRoot,
  resolvePackageRoot,
  runtimePaths,
} from './runtime/context.js';
export { runBackendCommand } from './runtime/docker.js';
export type {
  CliPlatform,
  CommandResult,
  DockerEnvironment,
  InstallOptions,
  RuntimeContext,
  RuntimeState,
} from './runtime/model.js';

function prerequisiteInstallHint(platform: CliPlatform): string {
  if (platform === 'macos') {
    return [
      'Install the missing prerequisites and retry:',
      '  Install Apple developer tools with either `xcode-select --install` or a full Xcode installation.',
      '  brew install node cmake',
      '  curl https://sh.rustup.rs -sSf | sh',
      '  source "$HOME/.cargo/env"',
    ].join('\n');
  }

  return [
    'Install the missing prerequisites and retry:',
    '  sudo apt-get update',
    '  sudo apt-get install -y build-essential cmake unzip tar pkg-config',
    '  curl https://sh.rustup.rs -sSf | sh',
    '  source "$HOME/.cargo/env"',
    '  Install Node.js 20 or newer from nodejs.org or NodeSource if your distro packages are older.',
  ].join('\n');
}

function collectPrerequisiteFailures(
  platform: CliPlatform,
  options: InstallOptions,
): PrerequisiteFailure[] {
  const failures: PrerequisiteFailure[] = [];
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    failures.push({
      name: 'node',
      reason: `Node.js ${process.version} is installed, but tokamak-cli requires Node.js 20 or newer.`,
    });
  }

  const requiredCommands = ['npm', 'rustc', 'cargo', 'cmake', 'tar'];
  if (!options.noSetup && !options.trustedSetup) {
    requiredCommands.push('unzip');
  }

  for (const command of requiredCommands) {
    if (!commandExists(command)) {
      failures.push({
        name: command,
        reason: `${command} is not available on PATH.`,
      });
    }
  }

  if (platform === 'macos') {
    for (const compiler of ['cc', 'c++', 'install_name_tool']) {
      if (!commandExists(compiler)) {
        failures.push({
          name: compiler,
          reason: `${compiler} is not available on PATH. Install Apple developer tools.`,
        });
      }
    }
  } else {
    for (const command of ['cc', 'c++', 'make', 'pkg-config']) {
      if (!commandExists(command)) {
        failures.push({
          name: command,
          reason: `${command} is not available on PATH.`,
        });
      }
    }
  }

  return failures;
}

function ensureInstallPrerequisites(platform: CliPlatform, options: InstallOptions): void {
  if (options.docker) {
    return;
  }

  const failures = collectPrerequisiteFailures(platform, options);
  if (failures.length === 0) {
    return;
  }

  const lines = failures.map((failure) => `- ${failure.name}: ${failure.reason}`);
  throw new Error(
    [
      'tokamak-cli cannot start the local install because required build prerequisites are missing.',
      ...lines,
      prerequisiteInstallHint(platform),
    ].join('\n'),
  );
}

async function installMissingPrerequisites(
  nativeOs: SupportedNativeOs,
  verbose: boolean,
): Promise<void> {
  assertPrerequisiteInstallMayRunAsCurrentUser();
  assertPrerequisiteInstallIsInteractive();
  const probe = createSystemCommandProbe();
  const statuses = detectManagedPrerequisites(nativeOs, probe);
  const plan = buildPrerequisiteInstallationPlan(nativeOs, statuses);

  if (plan.actions.length === 0) {
    process.stdout.write(`${renderPrerequisiteInstallationPlan(plan)}\n`);
  } else {
    if (!(await confirmPrerequisiteInstallation(plan))) {
      throw new Error('Prerequisite installation was declined. No host or runtime changes were made.');
    }

    const result = await executePrerequisiteInstallationPlan(plan, { verbose });
    if (result === 'rerun-required') {
      throw new Error(
        'Apple\'s Command Line Tools installer was launched. Complete the installation, then rerun the same tokamak-cli command.',
      );
    }
  }

  const verifiedStatuses = detectManagedPrerequisites(nativeOs);
  const verificationFailures = prerequisiteVerificationFailures(verifiedStatuses);
  if (verificationFailures.length > 0) {
    throw new Error(
      [
        'Prerequisite installation finished, but verification failed. The backend install was not started.',
        ...verificationFailures.map((failure) => `- ${failure}`),
        'Resolve the reported issue and rerun the same tokamak-cli command. No alternate version or installer was attempted.',
      ].join('\n'),
    );
  }
}

export async function installRuntime(options: InstallOptions): Promise<RuntimeContext> {
  if (options.docker) {
    return await installDockerRuntime(options);
  }

  activateManagedPrerequisiteEnvironment();
  const nativeOs = await detectSupportedNativeOs();
  const context = await createRuntimeContext();
  if (options.includePrerequisite) {
    await installMissingPrerequisites(nativeOs, options.verbose);
  }
  ensureInstallPrerequisites(context.platform, options);
  const backendRoot = await ensureVendoredBackendExists(context.packageRoot);

  logVerbose(options.verbose, `Using vendored backend ${backendRoot}`);
  await emptyDir(context.runtimeDir);
  const backendReleaseDir = await buildBackendReleaseBinaries(backendRoot, options);
  logVerbose(options.verbose, `Using backend release output ${backendReleaseDir}`);
  await copyBuiltBackendBinaries(context, backendReleaseDir, options);
  await installIcicleRuntime(context, nativeOs, options.verbose);
  await configureMacosRuntime(context, options.verbose);

  if (options.noSetup) {
    await writeSkippedSetupNotice(context);
  } else if (options.trustedSetup) {
    await runTrustedSetup(context, options.verbose);
  } else {
    await installDownloadedSetup(context, backendReleaseDir, options.verbose);
  }

  const state: RuntimeState = {
    installMode: 'native',
    packageVersion: context.packageVersion,
    platform: context.platform,
    installedAt: new Date().toISOString(),
  };
  await writeRuntimeState(context, state);
  return context;
}

export async function uninstallRuntime(): Promise<RuntimeContext> {
  const context = process.platform === 'win32'
    ? await createDockerRuntimeContext()
    : await createRuntimeContext();
  await fs.rm(context.platformDir, { recursive: true, force: true });
  await removeDirectoryIfEmpty(context.cacheRoot);
  return context;
}
