

export type CliPlatform = 'linux' | 'macos';

export interface InstallOptions {
  docker: boolean;
  includePrerequisite: boolean;
  noSetup: boolean;
  verbose: boolean;
}

export interface RuntimeState {
  dockerEnvironment?: DockerEnvironment;
  installMode: 'native' | 'docker';
  packageVersion: string;
  platform: CliPlatform;
  installedAt: string;
}

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

export type DockerEnvironment = 'ubuntu22' | 'ubuntu22-cuda122';

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
