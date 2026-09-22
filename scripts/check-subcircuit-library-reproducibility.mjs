#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_NODE_VERSION = '24.20.0';
export const PINNED_CIRCOM_VERSION = '2.2.3';
export const DIGEST_LIBRARY_DIRECTORIES = Object.freeze(['json', 'r1cs', 'wasm']);
export const DIGEST_LIBRARY_FILES = Object.freeze([
  'frontendCfg.json',
  'setupParams.json',
  'subcircuitInfo.json',
]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const qapCompilerRoot = path.join(repositoryRoot, 'packages/frontend/qap-compiler');
const trackedLibraryRoot = path.join(qapCompilerRoot, 'subcircuits/library');
const constantsPath = path.join(qapCompilerRoot, 'subcircuits/circom/constants.circom');
const qapCompilerCommand = path.join(qapCompilerRoot, 'scripts/qap-compiler.mjs');

export function collectArtifactEntries(root) {
  const entries = [];
  visit(root, '');
  return entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));

  function visit(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'info') continue;
      const relativePath = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        entries.push({ path: relativePath, content: fs.readFileSync(absolutePath) });
      } else {
        throw new Error(`Publishable library surface contains unsupported entry ${relativePath}.`);
      }
    }
  }
}

export function digestEntries(entries) {
  const digest = createHash('sha256');
  for (const entry of entries) {
    const entryPath = Buffer.from(entry.path, 'utf8');
    const content = Buffer.from(entry.content);
    digest.update(u64be(entryPath.byteLength));
    digest.update(entryPath);
    digest.update(u64be(content.byteLength));
    digest.update(content);
  }
  return `sha256:${digest.digest('hex')}`;
}

export function sourceDigestForLibrary(libraryRoot, constants = constantsPath) {
  const entries = [{
    path: 'subcircuits/circom/constants.circom',
    content: fs.readFileSync(constants),
  }];
  for (const file of DIGEST_LIBRARY_FILES) {
    entries.push({
      path: `subcircuits/library/${file}`,
      content: fs.readFileSync(path.join(libraryRoot, file)),
    });
  }
  for (const directory of DIGEST_LIBRARY_DIRECTORIES) {
    for (const entry of collectArtifactEntries(path.join(libraryRoot, directory))) {
      entries.push({
        path: `subcircuits/library/${directory}/${entry.path}`,
        content: entry.content,
      });
    }
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return digestEntries(entries);
}

export function compareArtifactSurfaces(expectedRoot, actualRoot) {
  const expected = collectArtifactEntries(expectedRoot);
  const actual = collectArtifactEntries(actualRoot);
  if (expected.length !== actual.length) {
    throw new Error(
      `Publishable library file count differs: ${expectedRoot} has ${expected.length}, ${actualRoot} has ${actual.length}.`,
    );
  }
  for (let index = 0; index < expected.length; index++) {
    if (expected[index].path !== actual[index].path) {
      throw new Error(
        `Publishable library path differs at entry ${index}: ${expected[index].path} != ${actual[index].path}.`,
      );
    }
    if (!expected[index].content.equals(actual[index].content)) {
      throw new Error(`Publishable library content differs at ${expected[index].path}.`);
    }
  }
}

export function verifyPinnedToolchain({ nodeVersion = process.version, circomVersion } = {}) {
  if (nodeVersion !== `v${PINNED_NODE_VERSION}`) {
    throw new Error(`Node.js must be ${PINNED_NODE_VERSION}, found ${nodeVersion}.`);
  }
  const resolvedCircomVersion = circomVersion ?? commandOutput('circom', ['--version']);
  if (resolvedCircomVersion !== `circom compiler ${PINNED_CIRCOM_VERSION}`) {
    throw new Error(`Circom must be ${PINNED_CIRCOM_VERSION}, found ${resolvedCircomVersion || 'unavailable'}.`);
  }
}

export function checkSubcircuitLibraryReproducibility({ root = repositoryRoot, build = buildLibrary } = {}) {
  const qapRoot = path.join(root, 'packages/frontend/qap-compiler');
  const trackedRoot = path.join(qapRoot, 'subcircuits/library');
  const sourceConstants = path.join(qapRoot, 'subcircuits/circom/constants.circom');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokamak-subcircuit-reproducibility-'));
  const firstOutput = path.join(temporaryRoot, 'first');
  const secondOutput = path.join(temporaryRoot, 'second');
  try {
    build(firstOutput, qapRoot);
    build(secondOutput, qapRoot);
    compareArtifactSurfaces(firstOutput, secondOutput);
    compareArtifactSurfaces(trackedRoot, firstOutput);
    const surfaceDigest = digestEntries(collectArtifactEntries(firstOutput));
    const sourceDigest = sourceDigestForLibrary(firstOutput, sourceConstants);
    if (
      sourceDigest !== sourceDigestForLibrary(secondOutput, sourceConstants)
      || sourceDigest !== sourceDigestForLibrary(trackedRoot, sourceConstants)
    ) {
      throw new Error('Canonical subcircuit source digest differs across clean builds or from tracked artifacts.');
    }
    return { surfaceDigest, sourceDigest };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function buildLibrary(outputDirectory, qapRoot) {
  const result = spawnSync(process.execPath, [qapCompilerCommand, '--build', outputDirectory], {
    cwd: qapRoot,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    stdio: 'pipe',
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Subcircuit library build failed for ${outputDirectory}.`);
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) return '';
  return `${result.stdout}${result.stderr}`.trim();
}

function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Digest frame length must be a non-negative safe integer.');
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyPinnedToolchain();
    const { surfaceDigest, sourceDigest } = checkSubcircuitLibraryReproducibility();
    console.log(`[subcircuit-reproducibility] publishable surface ${surfaceDigest}`);
    console.log(`[subcircuit-reproducibility] source identity ${sourceDigest}`);
  } catch (error) {
    console.error(`[subcircuit-reproducibility] ${error.message}`);
    process.exit(1);
  }
}
