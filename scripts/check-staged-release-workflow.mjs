#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishPath = path.join(repositoryRoot, '.github/workflows/publish-tokamak-zk-evm.yml');
const validationPath = path.join(repositoryRoot, '.github/workflows/build-release.yml');
const helperPath = path.join(repositoryRoot, 'scripts/dispatch-pr-validation.mjs');
const publishWorkflow = fs.readFileSync(publishPath, 'utf8');
const validationWorkflow = fs.readFileSync(validationPath, 'utf8');
const dispatchHelper = fs.readFileSync(helperPath, 'utf8');

checkWorkflow(publishWorkflow, validationWorkflow, dispatchHelper);
expectFailure(publishWorkflow.replace("state == 'foundation-publication'", "state != 'validation-only'"));
expectFailure(publishWorkflow.replaceAll("state == 'dependent-publication'", "state != 'validation-only'"));
expectFailure(publishWorkflow.replace('      id-token: write\n', ''));
expectHelperFailure(dispatchHelper.replace('build-release.yml', 'publish-tokamak-zk-evm.yml'));

console.log('[staged-release-workflow] Release stages and authority boundaries passed.');

function checkWorkflow(publish, validation, helper) {
  for (const required of [
    '- stage2-snapshot',
    '- validate-pr',
    "inputs.operation == 'validate-pr'",
    "inputs.operation == 'stage2-snapshot'",
    "state == 'foundation-publication'",
    "state == 'production-snapshot'",
    "state == 'dependent-publication'",
    'actions: write',
    'checks: read',
    'contents: write',
    'pull-requests: write',
    'test "$(git diff --name-only)" = "packages/backend/wasm/package-lock.json"',
    'node scripts/dispatch-pr-validation.mjs',
    '${{ vars.TOKAMAK_MPC_DRIVE_FOLDER_ID }}',
    'google-api-python-client==2.198.0 google-auth==2.50.0',
  ]) {
    if (!publish.includes(required)) throw new Error(`Publish workflow is missing staged boundary ${required}.`);
  }
  if (publish.includes('${{ secrets.TOKAMAK_MPC_DRIVE_FOLDER_ID }}')) {
    throw new Error('Drive folder ID is configuration and must not occupy a secret slot.');
  }
  if (publish.includes('npm view') || publish.includes('compareSemver')) {
    throw new Error('Inline npm version heuristics must not bypass exact-version registry policy.');
  }
  if ((publish.match(/id-token: write/gu) ?? []).length !== 4) {
    throw new Error('Exactly the four npm publication jobs must receive OIDC id-token permission.');
  }
  if (
    !validation.includes('workflow_dispatch:') ||
    !validation.includes('expected_head_sha:') ||
    !validation.includes('paths-ignore:\n      - packages/backend/wasm/package-lock.json')
  ) {
    throw new Error('The PR workflow must expose exact-head workflow_dispatch validation.');
  }
  if (!helper.includes("const VALIDATION_WORKFLOW = 'build-release.yml'")) {
    throw new Error('The dispatch helper must have one fixed PR-validation workflow target.');
  }
  if (helper.includes("VALIDATION_WORKFLOW = 'publish-tokamak-zk-evm.yml'")) {
    throw new Error('The publish workflow cannot be selected as the PR-validation target.');
  }
}

function expectFailure(mutatedPublishWorkflow) {
  try {
    checkWorkflow(mutatedPublishWorkflow, validationWorkflow, dispatchHelper);
  } catch {
    return;
  }
  throw new Error('A staged-release workflow policy mutation was not rejected.');
}

function expectHelperFailure(mutatedHelper) {
  try {
    checkWorkflow(publishWorkflow, validationWorkflow, mutatedHelper);
  } catch {
    return;
  }
  throw new Error('A PR-validation dispatch target mutation was not rejected.');
}
