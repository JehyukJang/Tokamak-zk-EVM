#!/usr/bin/env node

import assert from 'node:assert/strict';
import { dispatchPullRequestValidation } from './dispatch-pr-validation.mjs';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const calls = [];
const responses = [
  jsonResponse({ base: { ref: 'main', sha: baseSha }, head: { ref: 'release/snapshot', sha: headSha } }),
  emptyResponse(204),
  jsonResponse({
    workflow_runs: [{ id: 17, head_sha: headSha, display_title: 'PR validation 7 (test-nonce)', created_at: new Date().toISOString(), status: 'completed', conclusion: 'success' }],
  }),
  jsonResponse({
    check_runs: [{ id: 23, name: 'Source build', head_sha: headSha, conclusion: 'success', details_url: 'https://github.com/example/repo/actions/runs/17/job/2' }],
  }),
];
const result = await dispatchPullRequestValidation(
  {
    repository: 'example/repo',
    token: 'test-token',
    pullRequestNumber: 7,
    headSha,
    baseSha,
    timeoutSeconds: 1,
  },
  {
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    wait: async () => {},
    intervalMilliseconds: 0,
    dispatchNonce: 'test-nonce',
  },
);
assert.deepEqual(result, { workflowRunId: 17, checkRunId: 23 });
assert.match(calls[1].url, /actions\/workflows\/build-release\.yml\/dispatches/u);
assert.doesNotMatch(calls[1].url, /publish-tokamak-zk-evm/u);
assert.deepEqual(JSON.parse(calls[1].options.body), {
  ref: 'release/snapshot',
  inputs: { pull_request_number: '7', expected_head_sha: headSha, base_sha: baseSha, dispatch_nonce: 'test-nonce' },
});

await assert.rejects(
  dispatchPullRequestValidation(
    {
      repository: 'example/repo',
      token: 'test-token',
      pullRequestNumber: 7,
      headSha,
      baseSha,
      timeoutSeconds: 1,
    },
    {
      fetchImplementation: async () =>
        jsonResponse({ base: { ref: 'dev', sha: baseSha }, head: { ref: 'release/snapshot', sha: headSha } }),
    },
  ),
  /protected main base/u,
);

console.log('[dispatch-pr-validation-test] Exact-head workflow dispatch contract passed.');

function jsonResponse(value) {
  return { status: 200, json: async () => value, text: async () => JSON.stringify(value) };
}

function emptyResponse(status) {
  return { status, json: async () => null, text: async () => '' };
}
