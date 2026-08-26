const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');

test('Docker package context includes the root-owned version-policy source', () => {
  const dockerIgnore = fs.readFileSync(path.join(packageRoot, '.dockerignore'), 'utf8');
  assert.match(dockerIgnore, /^!versioning\/$/mu);
  assert.match(dockerIgnore, /^!versioning\/\*\*$/mu);

  const dockerfile = fs.readFileSync(path.join(packageRoot, 'docker', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY versioning \.\/versioning$/mu);
  assert.match(dockerfile, /test -f versioning\/compatibility\.rs/u);
});
