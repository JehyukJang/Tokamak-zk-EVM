#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/publish-tokamak-zk-evm.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

for (const legacyPath of ['scripts/classify-release.mjs', 'scripts/release-state.mjs', 'scripts/test-release-state.mjs']) {
  if (fs.existsSync(path.join(repositoryRoot, legacyPath))) {
    throw new Error(`Release controller must not retain legacy staged-release route ${legacyPath}.`);
  }
}

checkController(workflow);
expectFailure(workflow.replace('persist-credentials: false', 'persist-credentials: true'));
expectFailure(workflow.replaceAll('test "$GITHUB_ACTOR" = "JehyukJang"', 'true'));
expectFailure(workflow.replace('id-token: write', 'id-token: read'));
expectFailure(workflow.replace('npm publish --access public --ignore-scripts', 'npm publish --access public'));
expectFailure(workflow.replace('test "${{ steps.foundation.outputs.should_publish }}" = false', 'true'));
expectFailure(workflow.replace('group: tokamak-zk-evm-release-controller', 'group: another-controller'));
expectFailure(workflow.replaceAll('git/ref/heads/main', 'git/ref/heads/development'));
expectFailure(
  workflow.replace(
    `test "$changed" = "$(printf 'CHANGELOG.md\\npackages/backend/wasm/package-lock.json')"`,
    'true',
  ),
);

console.log('[release-controller-workflow] Authority and exact-identity boundaries passed.');

function checkController(value) {
  for (const required of [
    'name: Main release controller',
    'branches: [main]',
    'group: tokamak-zk-evm-release-controller',
    'options: [bootstrap-foundation, final-release]',
    'bootstrap_head_sha',
    'test "$GITHUB_ACTOR" = "JehyukJang"',
    'test "$GITHUB_REF" = "refs/heads/main"',
    'test "$GITHUB_SHA" = "$BASE_SHA"',
    'git/ref/heads/main',
    'repos/$GITHUB_REPOSITORY/git/ref/heads/dev',
    'repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER',
    'git merge-base --is-ancestor "$BOOTSTRAP_HEAD_SHA" "$EXPECTED_HEAD_SHA"',
    `test "$changed" = "$(printf 'CHANGELOG.md\\npackages/backend/wasm/package-lock.json')"`,
    'Build frozen candidate without mutation credentials',
    'Resolve public CRS with read-only Drive access',
    'TOKAMAK_MPC_DRIVE_SERVICE_ACCOUNT_JSON',
    'TOKAMAK_MPC_DRIVE_FOLDER_ID',
    'python scripts/download-release-crs.py',
    'npm run version:production-snapshot:check',
    'Publish approved bootstrap foundation tarball',
    'Publish final candidate package tarballs',
    'npm publish --access public --ignore-scripts',
    'Revalidate frozen release identity before npm publication',
    'test "${{ steps.foundation.outputs.should_publish }}" = false',
    'Permit only fixed controller maintenance or complete release verification',
  ]) {
    if (!value.includes(required)) throw new Error(`Release controller is missing ${required}.`);
  }

  if ((value.match(/id-token: write/gu) ?? []).length !== 2) {
    throw new Error('Only the two fixed publisher jobs may receive npm OIDC permission.');
  }
  if (value.includes('persist-credentials: true') || (value.match(/persist-credentials: false/gu) ?? []).length < 12) {
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
