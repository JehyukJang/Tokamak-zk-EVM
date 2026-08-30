#!/usr/bin/env node

import assert from 'node:assert/strict';
import { validateReleaseCandidate } from './release-candidate-policy.mjs';

const convention =
  'Release-entry dates are the dates on which version-bump pull requests are prepared offline and may differ from the GitHub pull-request creation, merge, and npm publication dates.';
assert.deepEqual(
  validateReleaseCandidate({ currentVersion: '2.1.5', baseVersion: '2.1.5', changelog: '## Unreleased\n' }),
  { changed: false, version: '2.1.5' },
);
assert.deepEqual(
  validateReleaseCandidate({
    currentVersion: '3.0.0',
    baseVersion: '2.1.5',
    changelog: `# Changelog\n\n${convention}\n\n## [3.0.0] - 2026-08-31\n`,
  }),
  { changed: true, version: '3.0.0', date: '2026-08-31' },
);
assert.throws(
  () =>
    validateReleaseCandidate({
      currentVersion: '3.0.0',
      baseVersion: '2.1.5',
      changelog: `${convention}\n\n## Unreleased\n\n## [3.0.0] - 2026-08-31\n`,
    }),
  /must not retain an Unreleased/u,
);
assert.throws(
  () =>
    validateReleaseCandidate({
      currentVersion: '3.0.0',
      baseVersion: '2.1.5',
      changelog: `${convention}\n\n## [3.0.0] - 2026-02-30\n`,
    }),
  /valid calendar date/u,
);
assert.throws(
  () =>
    validateReleaseCandidate({
      currentVersion: '3.0.0',
      baseVersion: '2.1.5',
      changelog: '## [3.0.0] - 2026-08-31\n',
    }),
  /must explain/u,
);

console.log('[release-candidate-policy-test] Offline preparation-date boundary passed.');
