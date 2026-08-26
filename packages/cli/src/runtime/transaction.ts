import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeRuntimeState } from './context.js';
import type { RuntimeContext, RuntimeState } from './model.js';

export async function installStagedRuntime(
  context: RuntimeContext,
  state: RuntimeState,
  populateStagingRuntime: (stagingContext: RuntimeContext) => Promise<void>,
  writeState: typeof writeRuntimeState = writeRuntimeState,
): Promise<void> {
  const stagingContext = await createStagingRuntimeContext(context);
  let committed = false;
  try {
    await populateStagingRuntime(stagingContext);
    await commitStagedRuntime(context, stagingContext, state, writeState);
    committed = true;
  } finally {
    if (!committed) {
      await fs.rm(stagingContext.runtimeDir, { recursive: true, force: true });
    }
  }
}

async function createStagingRuntimeContext(context: RuntimeContext): Promise<RuntimeContext> {
  await ensureDir(context.platformDir);
  const runtimeDir = await fs.mkdtemp(path.join(context.platformDir, '.runtime-staging-'));
  return { ...context, runtimeDir };
}

async function commitStagedRuntime(
  context: RuntimeContext,
  stagingContext: RuntimeContext,
  state: RuntimeState,
  writeState: typeof writeRuntimeState,
): Promise<void> {
  if (stagingContext.platformDir !== context.platformDir || stagingContext.statePath !== context.statePath) {
    throw new Error('Staged runtime context must use the active runtime platform and state paths.');
  }
  if (stagingContext.runtimeDir === context.runtimeDir) {
    throw new Error('Staged runtime directory must differ from the active runtime directory.');
  }

  const runtimeBackupPath = path.join(context.platformDir, `.runtime-backup-${randomUUID()}`);
  const stateBackupPath = path.join(context.platformDir, `.installation-backup-${randomUUID()}.json`);
  let runtimeBackedUp = false;
  let stagedRuntimeActivated = false;
  let stateBackedUp = false;
  let stateWriteStarted = false;

  try {
    if (await pathExists(context.runtimeDir)) {
      await fs.rename(context.runtimeDir, runtimeBackupPath);
      runtimeBackedUp = true;
    }
    await fs.rename(stagingContext.runtimeDir, context.runtimeDir);
    stagedRuntimeActivated = true;

    if (await pathExists(context.statePath)) {
      await fs.rename(context.statePath, stateBackupPath);
      stateBackedUp = true;
    }
    stateWriteStarted = true;
    await writeState(context, state);
  } catch (error) {
    const rollbackFailures = await rollbackStagedRuntime(
      context,
      stagingContext,
      runtimeBackupPath,
      stateBackupPath,
      runtimeBackedUp,
      stagedRuntimeActivated,
      stateBackedUp,
      stateWriteStarted,
    );
    if (rollbackFailures.length > 0) {
      throw new Error(
        `Runtime installation failed: ${errorMessage(error)}. Rollback also failed: ${rollbackFailures.join('; ')}`,
      );
    }
    throw error;
  }

  await fs.rm(runtimeBackupPath, { recursive: true, force: true });
  await fs.rm(stateBackupPath, { force: true });
}

async function rollbackStagedRuntime(
  context: RuntimeContext,
  stagingContext: RuntimeContext,
  runtimeBackupPath: string,
  stateBackupPath: string,
  runtimeBackedUp: boolean,
  stagedRuntimeActivated: boolean,
  stateBackedUp: boolean,
  stateWriteStarted: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  if (stateBackedUp) {
    await recordRollbackFailure(failures, 'remove new runtime state', async () => {
      await fs.rm(context.statePath, { force: true });
    });
    await recordRollbackFailure(failures, 'restore previous runtime state', async () => {
      await fs.rename(stateBackupPath, context.statePath);
    });
  } else if (stateWriteStarted) {
    await recordRollbackFailure(failures, 'remove incomplete runtime state', async () => {
      await fs.rm(context.statePath, { force: true });
    });
  }
  if (stagedRuntimeActivated) {
    await recordRollbackFailure(failures, 'move failed staged runtime aside', async () => {
      await fs.rename(context.runtimeDir, stagingContext.runtimeDir);
    });
  }
  if (runtimeBackedUp) {
    await recordRollbackFailure(failures, 'restore previous runtime directory', async () => {
      await fs.rename(runtimeBackupPath, context.runtimeDir);
    });
  }
  return failures;
}

async function recordRollbackFailure(
  failures: string[],
  operation: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(`${operation}: ${errorMessage(error)}`);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
