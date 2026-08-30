#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageTarball, inspectTarball, queryExactPackage } from './release-registry.mjs';
import { FOUNDATION_PACKAGE, RELEASE_PACKAGES, classifyReleaseState } from './release-state.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseOptions(process.argv.slice(2));
const eventName = process.env.GITHUB_EVENT_NAME || options.eventName;
const ref = process.env.GITHUB_REF || options.ref;
if (!eventName || !ref) throw new Error('Release event name and ref are required.');
const currentSha = git(['rev-parse', 'HEAD']);
const currentVersion = readJson(path.join(repositoryRoot, 'package.json')).version;
const gitFacts = deriveGitFacts(eventName, currentSha, currentVersion);
const packageFacts =
  gitFacts.changeKind === 'unchanged-general'
    ? Object.fromEntries(RELEASE_PACKAGES.map(name => [name, 'not-checked']))
    : collectPackageFacts(currentVersion, options.tarballDir);
const foundation =
  packageFacts[FOUNDATION_PACKAGE] === 'exact' ? queryExactPackage(FOUNDATION_PACKAGE, currentVersion) : null;
const validationOnly = gitFacts.changeKind === 'unchanged-general' && eventName === 'push';
const productionSnapshot = validationOnly
  ? 'not-checked'
  : inspectProductionLock(currentVersion, foundation?.metadata);
const mainSha = eventName === 'workflow_dispatch' ? git(['rev-parse', 'origin/main']) : currentSha;
const input = {
  eventName,
  ref,
  currentSha,
  mainSha,
  parentSha: gitFacts.parentSha,
  changeKind: gitFacts.changeKind,
  productionSnapshot,
  crs: validationOnly ? 'not-checked' : options.crsState,
  packages: packageFacts,
};
const state = classifyReleaseState(input);
const result = { state, currentVersion, ...input };

if (options.output) fs.writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\nversion=${currentVersion}\n`);
}
console.log(JSON.stringify(result, null, 2));

function parseOptions(argumentsList) {
  const result = { crsState: 'missing', eventName: null, ref: null, output: null, tarballDir: null };
  for (const argument of argumentsList) {
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`Invalid option ${argument}.`);
    const [, name, value] = match;
    if (name === 'crs-state') result.crsState = value;
    else if (name === 'event-name') result.eventName = value;
    else if (name === 'ref') result.ref = value;
    else if (name === 'output') result.output = path.resolve(value);
    else if (name === 'tarball-dir') result.tarballDir = path.resolve(value);
    else throw new Error(`Unknown option --${name}.`);
  }
  if (result.crsState !== 'missing' && result.crsState !== 'verified') {
    throw new Error('--crs-state must be missing or verified.');
  }
  return result;
}

function deriveGitFacts(eventNameValue, sha, version) {
  if (eventNameValue === 'workflow_dispatch') {
    return { parentSha: null, changeKind: 'unchanged-general' };
  }
  const parentSha = git(['rev-parse', `${sha}^1`]);
  let parentManifest;
  try {
    parentManifest = JSON.parse(git(['show', `${parentSha}:package.json`]));
  } catch (error) {
    throw new Error(`Cannot read the first-parent package.json: ${error.message}`);
  }
  if (parentManifest.version !== version) return { parentSha, changeKind: 'version-bump' };
  const changedPaths = git(['diff', '--name-only', parentSha, sha]).split('\n').filter(Boolean);
  return {
    parentSha,
    changeKind:
      changedPaths.length === 1 && changedPaths[0] === 'packages/backend/wasm/package-lock.json'
        ? 'snapshot-lock-only'
        : 'unchanged-general',
  };
}

function collectPackageFacts(version, tarballDirectory) {
  const facts = {};
  for (const name of RELEASE_PACKAGES) {
    const registryFact = queryExactPackage(name, version);
    if (registryFact.state === 'absent') {
      facts[name] = 'absent';
      continue;
    }
    if (!tarballDirectory || name === '@tokamak-zk-evm/snark-browser-compat') {
      facts[name] = 'exact';
      continue;
    }
    const tarball = findPackageTarball(tarballDirectory, name);
    facts[name] = inspectTarball(tarball, name, version, registryFact.metadata).state;
  }
  return facts;
}

function inspectProductionLock(version, registryMetadata) {
  if (!registryMetadata) return 'stale';
  const lock = readJson(path.join(repositoryRoot, 'packages/backend/wasm/package-lock.json'));
  const name = FOUNDATION_PACKAGE;
  const rootVersion = lock.packages?.['']?.dependencies?.[name];
  const resolved = lock.packages?.[`node_modules/${name}`];
  return rootVersion === version &&
    resolved?.version === version &&
    resolved?.resolved === registryMetadata.tarball &&
    resolved?.integrity === registryMetadata.integrity
    ? 'genuine'
    : 'stale';
}

function git(argumentsList) {
  return execFileSync('git', argumentsList, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
