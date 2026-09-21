#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/publish-tokamak-zk-evm.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

checkController(workflow);
expectFailure(workflow.replace('persist-credentials: false', 'persist-credentials: true'));
expectFailure(workflow.replace('test "$GITHUB_ACTOR" = "JehyukJang"', 'true'));
expectFailure(workflow.replace('id-token: write', 'id-token: read'));
expectFailure(workflow.replace('npm publish --access public --ignore-scripts', 'npm publish --access public'));
expectFailure(workflow.replace('test "${{ steps.foundation.outputs.should_publish }}" = false', 'true'));

console.log('[release-controller-workflow] Authority and exact-identity boundaries passed.');

function checkController(value) {
  for (const required of [
    'name: Main release controller',
    'branches: [main]',
    'options: [bootstrap-foundation, final-release]',
    'test "$GITHUB_ACTOR" = "JehyukJang"',
    'test "$GITHUB_REF" = "refs/heads/main"',
    'test "$GITHUB_SHA" = "$BASE_SHA"',
    'repos/$GITHUB_REPOSITORY/git/ref/heads/dev',
    'repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER',
    'Build frozen candidate without mutation credentials',
    'Resolve public CRS with read-only Drive access',
    'TOKAMAK_MPC_DRIVE_SERVICE_ACCOUNT_JSON',
    'TOKAMAK_MPC_DRIVE_FOLDER_ID',
    'python scripts/download-release-crs.py',
    'npm run version:production-snapshot:check',
    'Publish approved bootstrap foundation tarball',
    'Publish final candidate package tarballs',
    'npm publish --access public --ignore-scripts',
    'test "${{ steps.foundation.outputs.should_publish }}" = false',
    'Reject release-relevant direct push',
  ]) {
    if (!value.includes(required)) throw new Error(`Release controller is missing ${required}.`);
  }

  if ((value.match(/id-token: write/gu) ?? []).length !== 2) {
    throw new Error('Only the two fixed publisher jobs may receive npm OIDC permission.');
  }
  if ((value.match(/persist-credentials: false/gu) ?? []).length !== 8) {
    throw new Error('Controller and candidate checkouts must not persist a GitHub token.');
  }
  if ((value.match(/npm publish --access public --ignore-scripts/gu) ?? []).length !== 5) {
    throw new Error('Every fixed publication command must disable package lifecycle scripts.');
  }
  for (const forbidden of [
    'contents: write',
    'pull-requests: write',
    'actions: write',
    'gh pr create',
    'git push',
    'stage2-snapshot',
    'production-snapshot pull request',
    'classify-release',
  ]) {
    if (value.includes(forbidden)) throw new Error(`Release controller must not contain legacy mutation route ${forbidden}.`);
  }
}

function expectFailure(mutatedWorkflow) {
  try {
    checkController(mutatedWorkflow);
  } catch {
    return;
  }
  throw new Error('A release-controller boundary mutation was not rejected.');
}
