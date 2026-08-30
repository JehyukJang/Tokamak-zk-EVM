#!/usr/bin/env node

import assert from 'node:assert/strict';
import { DEPENDENT_PACKAGES, FOUNDATION_PACKAGE, RELEASE_PACKAGES, classifyReleaseState } from './release-state.mjs';

const sha = character => character.repeat(40);
const packages = state => Object.fromEntries(RELEASE_PACKAGES.map(name => [name, state]));
const base = overrides => ({
  eventName: 'push',
  ref: 'refs/heads/main',
  currentSha: sha('a'),
  mainSha: sha('a'),
  parentSha: sha('b'),
  changeKind: 'unchanged-general',
  productionSnapshot: 'genuine',
  crs: 'verified',
  packages: packages('exact'),
  ...overrides,
});

assert.equal(
  classifyReleaseState(
    base({ packages: packages('not-checked'), productionSnapshot: 'not-checked', crs: 'not-checked' }),
  ),
  'validation-only',
);
assert.equal(
  classifyReleaseState(
    base({ changeKind: 'version-bump', productionSnapshot: 'stale', crs: 'missing', packages: packages('absent') }),
  ),
  'foundation-publication',
);

const foundationOnly = packages('absent');
foundationOnly[FOUNDATION_PACKAGE] = 'exact';
assert.equal(
  classifyReleaseState(
    base({ changeKind: 'version-bump', productionSnapshot: 'stale', crs: 'missing', packages: foundationOnly }),
  ),
  'waiting-for-crs-snapshot',
);
assert.equal(
  classifyReleaseState(
    base({
      eventName: 'workflow_dispatch',
      parentSha: null,
      changeKind: 'unchanged-general',
      productionSnapshot: 'stale',
      crs: 'verified',
      packages: foundationOnly,
    }),
  ),
  'production-snapshot',
);

const partial = { ...packages('absent'), [FOUNDATION_PACKAGE]: 'exact', [DEPENDENT_PACKAGES[0]]: 'exact' };
assert.equal(
  classifyReleaseState(base({ changeKind: 'snapshot-lock-only', packages: partial })),
  'dependent-publication',
);
assert.equal(
  classifyReleaseState(base({ changeKind: 'snapshot-lock-only' })),
  'complete',
);

for (const [name, input, expected] of [
  ['missing first parent', base({ parentSha: null }), /first-parent/u],
  [
    'stale dispatch ref',
    base({ eventName: 'workflow_dispatch', parentSha: null, ref: 'refs/heads/dev' }),
    /refs\/heads\/main/u,
  ],
  [
    'non-main dispatch commit',
    base({ eventName: 'workflow_dispatch', parentSha: null, mainSha: sha('c') }),
    /current protected main/u,
  ],
  [
    'registry error',
    base({ changeKind: 'snapshot-lock-only', packages: { ...packages('exact'), [FOUNDATION_PACKAGE]: 'error' } }),
    /registry error/u,
  ],
  [
    'published mismatch',
    base({ changeKind: 'snapshot-lock-only', packages: { ...packages('exact'), [FOUNDATION_PACKAGE]: 'mismatch' } }),
    /does not match/u,
  ],
  [
    'missing CRS after snapshot merge',
    base({ changeKind: 'snapshot-lock-only', crs: 'missing' }),
    /publication gates/u,
  ],
  [
    'stale lock after snapshot merge',
    base({ changeKind: 'snapshot-lock-only', productionSnapshot: 'stale' }),
    /publication gates/u,
  ],
  [
    'impossible partial foundation stage',
    base({ changeKind: 'version-bump', productionSnapshot: 'stale', packages: partial }),
    /valid foundation stage/u,
  ],
]) {
  assert.throws(() => classifyReleaseState(input), expected, name);
}

console.log('[release-state-test] Staged release states and failure boundaries passed.');
