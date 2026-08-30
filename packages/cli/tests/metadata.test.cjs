const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');

test('README source and issues links match the package repository metadata', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  const repositoryUrl = manifest.repository?.url?.replace(/\.git$/u, '');
  const sourceUrl = /^- \[Source\]\(([^)]+)\)$/mu.exec(readme)?.[1];
  const issuesUrl = /^- \[Issues\]\(([^)]+)\)$/mu.exec(readme)?.[1];

  assert.equal(typeof repositoryUrl, 'string');
  assert.equal(sourceUrl, `${repositoryUrl}/tree/main/packages/cli`);
  assert.equal(issuesUrl, manifest.bugs?.url);
});
