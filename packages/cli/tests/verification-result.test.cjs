const assert = require('node:assert/strict');
const test = require('node:test');

const { parseBackendVerificationResult } = require('../dist/runtime/verification-result.js');

test('accepts the versioned backend verification result', () => {
  assert.deepEqual(
    parseBackendVerificationResult('{"contractVersion":1,"verified":true}'),
    { contractVersion: 1, verified: true },
  );
});

test('rejects stdout diagnostics and malformed verification results', () => {
  for (const value of [
    'Verifier initialization...\n{"contractVersion":1,"verified":true}',
    '{"contractVersion":2,"verified":true}',
    '{"contractVersion":1,"verified":"true"}',
    '{"contractVersion":1,"verified":true,"detail":"unexpected"}',
  ]) {
    assert.throws(() => parseBackendVerificationResult(value));
  }
});
