#!/usr/bin/env node
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { stopPrivateStateAnvil } from './private-state-anvil-fixture.ts';

type Family = 'mint' | 'transfer' | 'redeem';

type FamilyDefinition = Readonly<{
  exampleType: 'private-state-mint' | 'private-state-transfer' | 'private-state-redeem';
  prepFile: string;
}>;

type MatrixConfig = Readonly<{
  network?: string;
  function?: Readonly<{
    entryContractAddress?: string;
    selector?: string;
  }>;
}>;

class CommandFailure extends Error {
  public constructor(
    readonly output: string,
    command: string,
    code: number | null,
  ) {
    super(`${command} exited with code ${code ?? 'unknown'}`);
  }
}

const packageRoot = path.resolve(process.cwd());
const configRunner = path.resolve(packageRoot, '..', 'examples', 'config-runner.ts');
const outputDir = path.resolve(packageRoot, '..', 'outputs');
const capacityFailurePattern = /Insufficient buffer.*length|sMax/iu;
const errorLogPattern = /error:/iu;

const familyDefinitions: Readonly<Record<Family, FamilyDefinition>> = {
  mint: {
    exampleType: 'private-state-mint',
    prepFile: 'run-private-state-mint-config-matrix.ts',
  },
  transfer: {
    exampleType: 'private-state-transfer',
    prepFile: 'run-private-state-transfer-config-matrix.ts',
  },
  redeem: {
    exampleType: 'private-state-redeem',
    prepFile: 'run-private-state-redeem-config-matrix.ts',
  },
};

const runCaptured = async (command: string, args: readonly string[]): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const appendOutput = (chunk: Buffer | string) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve(output);
      return;
    }
    reject(new CommandFailure(output, command, code));
  });
});

const normalize = (value: string | undefined): string => value?.trim().toLowerCase() ?? '';

const groupKey = (config: MatrixConfig): string => [
  normalize(config.network),
  normalize(config.function?.entryContractAddress),
  normalize(config.function?.selector),
].join('|');

const copyOutput = async (destination: string): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(outputDir)) {
    await fs.cp(path.join(outputDir, entry), path.join(destination, entry), { recursive: true });
  }
};

const assertNoOutputErrors = (output: string, configName: string): void => {
  const errors = output.split(/\r?\n/u).filter((line) => errorLogPattern.test(line));
  if (errors.length > 0) {
    throw new Error(`Final execution emitted error logs for ${configName}:\n${errors.join('\n')}`);
  }
};

const comparePermutations = async (
  archiveDir: string,
  configNames: readonly string[],
  key: string,
): Promise<boolean> => {
  if (configNames.length < 2) {
    console.log(`[private-state-topology] Unverified group ${key}: fewer than two successful members`);
    return false;
  }

  const baselineName = configNames[0];
  const baseline = await fs.readFile(path.join(archiveDir, baselineName, 'permutation.json'));
  for (const configName of configNames.slice(1)) {
    const candidate = await fs.readFile(path.join(archiveDir, configName, 'permutation.json'));
    if (!baseline.equals(candidate)) {
      throw new Error(
        `Permutation mismatch for ${key}: baseline=${baselineName} mismatch=${configName}`,
      );
    }
  }
  return true;
};

const runFamily = async (family: Family, familyArgs: readonly string[]): Promise<void> => {
  const definition = familyDefinitions[family];
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `tokamak-${family}-topology-`));
  const configDir = path.join(workDir, 'configs');
  const archiveDir = path.join(workDir, 'outputs');
  let anvilMayBeRunning = false;

  try {
    const prepFile = path.resolve(packageRoot, 'tests', 'scripts', definition.prepFile);
    console.log(`[private-state-topology] Preparing ${family} matrix`);
    anvilMayBeRunning = true;
    await runCaptured('tsx', [
      '--tsconfig', path.resolve(packageRoot, 'tsconfig.dev.json'),
      prepFile,
      ...familyArgs,
      '--output-dir', configDir,
    ]);

    const configNames = (await fs.readdir(configDir))
      .filter((entry) => entry.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
    if (configNames.length !== 4) {
      throw new Error(`Expected four ${family} matrix configurations, received ${configNames.length}`);
    }

    const configs = await Promise.all(configNames.map(async (name) => ({
      name,
      config: JSON.parse(await fs.readFile(path.join(configDir, name), 'utf8')) as MatrixConfig,
    })));
    const groups = new Set(configs.map(({ config }) => groupKey(config)));
    if (groups.size !== 1) {
      throw new Error(`Private-state ${family} matrix does not share one network/contract/selector group`);
    }

    const successfulConfigs: string[] = [];
    const capacityConfigs: string[] = [];
    for (const { name } of configs) {
      const configPath = path.join(configDir, name);
      console.log(`[private-state-topology] Running ${name}`);
      try {
        const output = await runCaptured('tsx', [
          '--tsconfig', path.resolve(packageRoot, 'tsconfig.dev.json'),
          configRunner,
          definition.exampleType,
          configPath,
        ]);
        assertNoOutputErrors(output, name);
        await copyOutput(path.join(archiveDir, path.parse(name).name));
        successfulConfigs.push(path.parse(name).name);
      } catch (error) {
        if (error instanceof CommandFailure && capacityFailurePattern.test(error.output)) {
          capacityConfigs.push(name);
          console.log(`[private-state-topology] Accepted capacity result: ${name}`);
          continue;
        }
        throw error;
      }
    }

    if (capacityConfigs.length > 0) {
      console.log(`[private-state-topology] Unverified capacity members: ${capacityConfigs.join(', ')}`);
    }
    const key = groups.values().next().value as string;
    if (await comparePermutations(archiveDir, successfulConfigs, key)) {
      console.log(`[private-state-topology] Topology verified for ${family}: ${successfulConfigs.join(', ')}`);
    }
  } finally {
    if (anvilMayBeRunning) {
      await stopPrivateStateAnvil(packageRoot);
    }
    await fs.rm(workDir, { recursive: true, force: true });
  }
};

const fullMatrix: readonly Readonly<{ family: Family; args: readonly string[] }>[] = [
  { family: 'mint', args: ['--outputs', '1'] },
  { family: 'mint', args: ['--outputs', '2'] },
  { family: 'mint', args: ['--outputs', '3'] },
  { family: 'transfer', args: ['--inputs', '1', '--outputs', '1'] },
  { family: 'transfer', args: ['--inputs', '1', '--outputs', '2'] },
  { family: 'transfer', args: ['--inputs', '1', '--outputs', '3'] },
  { family: 'transfer', args: ['--inputs', '2', '--outputs', '1'] },
  { family: 'transfer', args: ['--inputs', '2', '--outputs', '2'] },
  { family: 'redeem', args: ['--inputs', '1'] },
  { family: 'redeem', args: ['--inputs', '2'] },
];

const main = async (): Promise<void> => {
  const [requestedFamily, ...familyArgs] = process.argv.slice(2);
  if (requestedFamily === 'all') {
    for (const entry of fullMatrix) {
      await runFamily(entry.family, entry.args);
    }
    return;
  }
  if (requestedFamily !== 'mint' && requestedFamily !== 'transfer' && requestedFamily !== 'redeem') {
    throw new Error('Usage: run-private-state-topology-matrix.ts <all|mint|transfer|redeem> [family options]');
  }
  await runFamily(requestedFamily, familyArgs);
};

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
