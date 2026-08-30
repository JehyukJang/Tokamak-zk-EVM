#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

const VALIDATION_WORKFLOW = 'build-release.yml';
const REQUIRED_CHECK = 'Source build';

export async function dispatchPullRequestValidation(options, dependencies = {}) {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const intervalMilliseconds = dependencies.intervalMilliseconds ?? 10_000;
  const dispatchNonce = dependencies.dispatchNonce ?? randomUUID();
  const deadline = Date.now() + options.timeoutSeconds * 1_000;
  const request = createRequester(options, fetchImplementation);

  const pullRequest = await request(`/pulls/${options.pullRequestNumber}`);
  if (pullRequest.base?.ref !== 'main' || pullRequest.base?.sha !== options.baseSha) {
    throw new Error('Pull-request validation dispatch requires the exact protected main base.');
  }
  if (pullRequest.head?.sha !== options.headSha) {
    throw new Error('Pull-request head changed before validation dispatch.');
  }
  if (!pullRequest.head?.ref) throw new Error('Pull-request head branch is missing.');

  const dispatchedAt = Date.now();
  await request(`/actions/workflows/${VALIDATION_WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      ref: pullRequest.head.ref,
      inputs: {
        pull_request_number: String(options.pullRequestNumber),
        expected_head_sha: options.headSha,
        base_sha: options.baseSha,
        dispatch_nonce: dispatchNonce,
      },
    }),
    expectedStatus: 204,
  });

  let workflowRun;
  while (Date.now() < deadline) {
    const runs = await request(
      `/actions/workflows/${VALIDATION_WORKFLOW}/runs?event=workflow_dispatch&branch=${encodeURIComponent(pullRequest.head.ref)}&per_page=20`,
    );
    workflowRun = runs.workflow_runs?.find(
      run =>
        run.head_sha === options.headSha &&
        run.display_title === `PR validation ${options.pullRequestNumber} (${dispatchNonce})` &&
        Date.parse(run.created_at) >= dispatchedAt - 60_000,
    );
    if (workflowRun) break;
    await wait(intervalMilliseconds);
  }
  if (!workflowRun) throw new Error('Timed out waiting for the dispatched validation workflow run.');

  while (workflowRun.status !== 'completed' && Date.now() < deadline) {
    await wait(intervalMilliseconds);
    workflowRun = await request(`/actions/runs/${workflowRun.id}`);
  }
  if (workflowRun.status !== 'completed') throw new Error('Timed out waiting for pull-request validation.');
  if (workflowRun.conclusion !== 'success') {
    throw new Error(`Pull-request validation workflow concluded ${workflowRun.conclusion}.`);
  }

  const checks = await request(`/commits/${options.headSha}/check-runs`);
  const requiredCheck = checks.check_runs?.find(
    check =>
      check.name === REQUIRED_CHECK &&
      check.head_sha === options.headSha &&
      check.conclusion === 'success' &&
      String(check.details_url).includes(`/actions/runs/${workflowRun.id}/`),
  );
  if (!requiredCheck) {
    throw new Error(`The successful ${REQUIRED_CHECK} check is not attached to the exact pull-request head.`);
  }
  return { workflowRunId: workflowRun.id, checkRunId: requiredCheck.id };
}

function createRequester(options, fetchImplementation) {
  return async (apiPath, requestOptions = {}) => {
    const response = await fetchImplementation(`https://api.github.com/repos/${options.repository}${apiPath}`, {
      ...requestOptions,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...requestOptions.headers,
      },
    });
    const expectedStatus = requestOptions.expectedStatus ?? 200;
    if (response.status !== expectedStatus) {
      throw new Error(`GitHub API ${apiPath} returned HTTP ${response.status}: ${await response.text()}`);
    }
    return expectedStatus === 204 ? null : response.json();
  };
}

function parseOptions(argumentsList) {
  const options = {};
  for (const argument of argumentsList) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match) throw new Error(`Invalid option ${argument}.`);
    options[match[1]] = match[2];
  }
  const pullRequestNumber = Number(options['pull-request']);
  const timeoutSeconds = Number(options['timeout-seconds'] ?? '3600');
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error('--pull-request must be a positive integer.');
  }
  for (const name of ['head-sha', 'base-sha']) {
    if (!/^[0-9a-f]{40}$/u.test(options[name] ?? '')) throw new Error(`--${name} must be a full commit SHA.`);
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('--timeout-seconds must be positive.');
  }
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required.');
  return {
    repository,
    token,
    pullRequestNumber,
    headSha: options['head-sha'],
    baseSha: options['base-sha'],
    timeoutSeconds,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await dispatchPullRequestValidation(parseOptions(process.argv.slice(2)));
  console.log(JSON.stringify(result));
}
