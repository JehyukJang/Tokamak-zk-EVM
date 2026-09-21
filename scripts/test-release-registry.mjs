#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { interpretNpmViewResult } from './release-registry.mjs';

const integrity = `sha512-${createHash('sha512').update('fixture').digest('base64')}`;
const tarball = 'https://registry.npmjs.org/@scope/package/-/package-3.0.0.tgz';

assert.deepEqual(
  interpretNpmViewResult('@scope/package@3.0.0', { status: 1, stdout: '', stderr: 'npm error code E404' }),
  { state: 'absent' },
);
assert.throws(
  () =>
    interpretNpmViewResult('@scope/package@3.0.0', {
      status: 1,
      stdout: '',
      stderr: 'npm error code E401',
    }),
  /registry lookup failed/u,
);
assert.throws(
  () => interpretNpmViewResult('@scope/package@3.0.0', { status: 0, stdout: '{', stderr: '' }),
  /malformed metadata/u,
);
assert.deepEqual(
  interpretNpmViewResult('@scope/package@3.0.0', {
    status: 0,
    stdout: JSON.stringify({ integrity, tarball }),
    stderr: '',
  }),
  {
    state: 'exact',
    metadata: { integrity, tarball },
  },
);
assert.throws(
  () =>
    interpretNpmViewResult('@scope/package@3.0.0', {
      status: 0,
      stdout: JSON.stringify({ integrity, tarball: 'https://registry.example/package.tgz' }),
      stderr: '',
    }),
  /noncanonical tarball URL/u,
);

console.log('[release-registry-test] Exact-version npm response handling passed.');
