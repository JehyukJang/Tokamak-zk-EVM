

export type CliPlatform = 'linux' | 'macos';

export interface InstallOptions {
  docker: boolean;
  includePrerequisite: boolean;
  noSetup: boolean;
  verbose: boolean;
}

export type DockerEnvironment = 'ubuntu22' | 'ubuntu22-cuda122';

interface RuntimeStateBase {
  packageVersion: string;
  platform: CliPlatform;
  installedAt: string;
}

export interface NativeRuntimeState extends RuntimeStateBase {
  dockerEnvironment?: never;
  installMode: 'native';
}

export interface DockerRuntimeState extends RuntimeStateBase {
  dockerEnvironment: DockerEnvironment;
  installMode: 'docker';
}

export type RuntimeState = NativeRuntimeState | DockerRuntimeState;

export interface RuntimeContext {
  cacheRoot: string;
  packageRoot: string;
  platform: CliPlatform;
  platformDir: string;
  runtimeDir: string;
  statePath: string;
  compatibleBackendVersion: string;
  packageVersion: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type NativeRuntimeOs =
  | { platform: 'macos' }
  | { platform: 'linux'; ubuntuVersion: '20.04' | '22.04' };

export interface DockerBootstrap {
  version: 1;
  createdAt: string;
  dockerEnvironment: DockerEnvironment;
  imageName: string;
  packageVersion: string;
  platform: 'linux';
  useGpus: boolean;
}

export interface InstalledRuntime {
  context: RuntimeContext;
  state: RuntimeState;
}

export type RuntimeExecution =
  | {
      mode: 'native';
      context: RuntimeContext;
      state: NativeRuntimeState;
    }
  | {
      mode: 'docker';
      bootstrap: DockerBootstrap;
      context: RuntimeContext;
      state: DockerRuntimeState;
    };
