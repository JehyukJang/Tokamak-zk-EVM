#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

function absolutePath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function fileExists(relativePath) {
  return fs.existsSync(absolutePath(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(absolutePath(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function requireFile(relativePath) {
  if (!fileExists(relativePath)) {
    fail(`${relativePath} is missing.`);
    return false;
  }
  return true;
}

function requireIncludes(relativePath, needle, description = needle) {
  if (!requireFile(relativePath)) {
    return;
  }
  const text = readText(relativePath);
  if (!text.includes(needle)) {
    fail(`${relativePath} must include ${description}.`);
  }
}

function requirePattern(relativePath, pattern, description) {
  if (!requireFile(relativePath)) {
    return;
  }
  const text = readText(relativePath);
  if (!pattern.test(text)) {
    fail(`${relativePath} must include ${description}.`);
  }
}

function parseMarkdownLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map(match => match[1]);
}

function stripAnchor(linkTarget) {
  return linkTarget.split('#')[0];
}

function isExternalLink(linkTarget) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(linkTarget);
}

function checkMarkdownStructure(relativePath) {
  if (!requireFile(relativePath)) {
    return;
  }

  const source = readText(relativePath).replace(/^```[\s\S]*?^```$/gmu, '');
  const headings = [...source.matchAll(/^(#{1,6})\s+(.+)$/gmu)].map(match => ({
    depth: match[1].length,
    label: match[2].trim(),
  }));

  if (headings.length === 0 || headings[0].depth !== 1) {
    fail(`${relativePath} must begin its heading hierarchy with one H1.`);
    return;
  }
  if (headings.filter(({ depth }) => depth === 1).length !== 1) {
    fail(`${relativePath} must contain exactly one H1.`);
  }

  const anchors = new Set();
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (index > 0 && heading.depth > headings[index - 1].depth + 1) {
      fail(`${relativePath} skips a heading level before "${heading.label}".`);
    }

    const anchor = heading.label
      .toLowerCase()
      .replace(/<[^>]+>/gu, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/gu, '-');
    if (anchors.has(anchor)) {
      fail(`${relativePath} contains the duplicate heading anchor #${anchor}.`);
    }
    anchors.add(anchor);
  }
}

function checkLocalMarkdownLinks(relativePath) {
  if (!requireFile(relativePath)) {
    return;
  }

  const documentDirectory = path.dirname(relativePath);
  for (const linkTarget of parseMarkdownLinks(readText(relativePath))) {
    if (isExternalLink(linkTarget)) {
      continue;
    }
    const localTarget = decodeURIComponent(stripAnchor(linkTarget));
    if (!localTarget) {
      continue;
    }
    const resolvedTarget = path.normalize(path.join(documentDirectory, localTarget));
    if (!fileExists(resolvedTarget)) {
      fail(`${relativePath} links to missing local target ${linkTarget}.`);
    }
  }
}

function checkLlmsTxt() {
  const relativePath = 'llms.txt';
  if (!requireFile(relativePath)) {
    return;
  }

  const text = readText(relativePath);
  for (const packageName of [
    '@tokamak-zk-evm/cli',
    '@tokamak-zk-evm/subcircuit-library',
    '@tokamak-zk-evm/synthesizer-node',
    '@tokamak-zk-evm/synthesizer-web',
    '@tokamak-zk-evm/snark-browser-compat',
  ]) {
    if (!text.includes(packageName)) {
      fail(`${relativePath} must include ${packageName}.`);
    }
  }

  for (const linkTarget of parseMarkdownLinks(text)) {
    if (isExternalLink(linkTarget)) {
      continue;
    }
    const localTarget = stripAnchor(linkTarget);
    if (!localTarget) {
      continue;
    }
    if (!fileExists(localTarget)) {
      fail(`${relativePath} links to missing local target ${linkTarget}.`);
    }
  }

  if (/@tokamak-zk-evm\/verify-wasm|verify-wasm/iu.test(text)) {
    fail(`${relativePath} must not list deprecated WASM verifier packages as supported public packages.`);
  }
}

function checkRootReadme() {
  const relativePath = 'README.md';

  for (const required of [
    '## How the repository fits together',
    '## Choose a package',
    '@tokamak-zk-evm/cli',
    '@tokamak-zk-evm/subcircuit-library',
    '@tokamak-zk-evm/synthesizer-node',
    '@tokamak-zk-evm/synthesizer-web',
    '@tokamak-zk-evm/snark-browser-compat',
    '## Releases and npm publication',
    '## Repository map',
    '## Scope and compatibility',
    '## Learn more',
    '## License',
    'https://github.com/tokamak-network/TokamakL2JS',
    'An Efficient SNARK for Field-Programmable and RAM Circuits',
    'https://eprint.iacr.org/2024/507',
    'bridge/src/verifiers/TokamakVerifier.sol',
    'TPAC-Contract-Addresses.json',
    'MIT',
    'Apache-2.0',
    'CHANGELOG.md',
  ]) {
    requireIncludes(relativePath, required);
  }
  requirePattern(
    relativePath,
    /a manifest version is not a published release\s+until it appears\s+on npm/iu,
    'the distinction between source and published versions',
  );
  requirePattern(relativePath, /tokamak-?l2js/iu, 'the TokamakL2JS input-format owner');

  if (
    /@tokamak-zk-evm\/verify-wasm|verify-wasm-web|verify-wasm-nodejs|verify-wasm-bundler/u.test(readText(relativePath))
  ) {
    fail(`${relativePath} must not list deprecated WASM verifier packages as supported package choices.`);
  }

  for (const forbidden of [
    '# Getting started',
    '## Native npm installation',
    '## How to run (for all platforms)',
    '## Disclaimer',
    '## Contributing',
    '## Security and operational responsibilities',
    '## Security and application responsibilities',
    '### Preprocess',
    '### Prove',
    '### Verify',
    '<CLI> --',
    '0x0C17B6F51A9A0CAEb8111313877214f5c26AbfC0',
    '0x0C467a5082323Cc6F4b7077A9dFb0bbdaf6eC626',
  ]) {
    if (readText(relativePath).includes(forbidden)) {
      fail(`${relativePath} must leave detailed usage and disclaimers to package READMEs; found ${forbidden}.`);
    }
  }
}

function checkPackageReadmes() {
  const packageReadmes = [
    ['packages/cli/README.md', '@tokamak-zk-evm/cli'],
    ['packages/frontend/qap-compiler/README.md', '@tokamak-zk-evm/subcircuit-library'],
    ['packages/frontend/synthesizer/node-cli/README.md', '@tokamak-zk-evm/synthesizer-node'],
    ['packages/frontend/synthesizer/web-app/README.md', '@tokamak-zk-evm/synthesizer-web'],
    ['packages/backend-wasm/README.md', '@tokamak-zk-evm/snark-browser-compat'],
  ];

  for (const [relativePath, packageName] of packageReadmes) {
    requireIncludes(relativePath, packageName);
    requireIncludes(relativePath, '## npm publication');
    requireIncludes(relativePath, 'https://www.npmjs.com/package/');
    requireIncludes(relativePath, 'CHANGELOG.md', 'a root changelog link');
  }

  const packageInputRequirements = [
    [
      'packages/cli/README.md',
      [
        'StateSnapshot',
        'captureStateSnapshot()',
        'TxSnapshot',
        'captureTxSnapshot()',
        'sigma_preprocess.rkyv',
        'combined_sigma.rkyv',
        'sigma_verify.json',
        '## Security and operational responsibilities',
      ],
    ],
    [
      'packages/frontend/synthesizer/node-cli/README.md',
      [
        'StateSnapshot',
        'captureStateSnapshot()',
        'TxSnapshot',
        'captureTxSnapshot()',
        'contract_codes.json',
        '## Security and application responsibilities',
      ],
    ],
    [
      'packages/frontend/synthesizer/web-app/README.md',
      [
        'StateSnapshot',
        'captureStateSnapshot()',
        'TxSnapshot',
        'captureTxSnapshot()',
        'loadSynthesisInputFromFiles',
        'loadSynthesisInputFromUrls',
        '## Security and application responsibilities',
      ],
    ],
    [
      'packages/backend-wasm/README.md',
      [
        '## Runtime artifact guide and acquisition',
        'TZBWASM1',
        'combined_sigma.rkyv',
        '## Security and application responsibilities',
      ],
    ],
    [
      'packages/frontend/qap-compiler/README.md',
      [
        '## Published artifacts',
        'setupParams.json',
        'subcircuitInfo.json',
        '## Security and application responsibilities',
      ],
    ],
  ];

  for (const [relativePath, requirements] of packageInputRequirements) {
    for (const requirement of requirements) {
      requireIncludes(relativePath, requirement);
    }
  }

  for (const requirement of [
    '## Distribution',
    '## Preprocess, prove, and verify',
    'combined_sigma.rkyv',
    'sigma_preprocess.rkyv',
    'sigma_verify.json',
    '## Security and operator responsibilities',
  ]) {
    requireIncludes('packages/backend/README.md', requirement);
  }
  requirePattern(
    'packages/backend/README.md',
    /not published as a standalone npm(?: or crates\.io)? package/u,
    'the native backend publication status',
  );
}

function checkReadmeResponsibilities() {
  const readmes = [
    'README.md',
    'packages/backend/README.md',
    'packages/backend/setup/mpc-setup/README.md',
    'packages/backend-wasm/README.md',
    'packages/backend-wasm/docs/optimization/README.md',
    'packages/backend-wasm/examples/browser/README.md',
    'packages/backend-wasm/fixtures/README.md',
    'packages/backend-wasm/tools/rkyv-decoder-wasm/README.md',
    'packages/cli/README.md',
    'packages/frontend/qap-compiler/README.md',
    'packages/frontend/qap-compiler/docs/README.md',
    'packages/frontend/synthesizer/README.md',
    'packages/frontend/synthesizer/docs/README.md',
    'packages/frontend/synthesizer/node-cli/README.md',
    'packages/frontend/synthesizer/web-app/README.md',
  ];

  for (const relativePath of readmes) {
    checkMarkdownStructure(relativePath);
    checkLocalMarkdownLinks(relativePath);
    const repositoryVersion = readJson('package.json').version;
    if (readText(relativePath).includes(repositoryVersion)) {
      fail(`${relativePath} must not hard-code the synchronized repository version.`);
    }
  }

  for (const relativePath of [
    'README.md',
    'packages/backend/README.md',
    'packages/backend/setup/mpc-setup/README.md',
    'packages/backend-wasm/README.md',
    'packages/backend-wasm/examples/browser/README.md',
    'packages/backend-wasm/tools/rkyv-decoder-wasm/README.md',
    'packages/cli/README.md',
    'packages/frontend/qap-compiler/README.md',
    'packages/frontend/synthesizer/README.md',
    'packages/frontend/synthesizer/node-cli/README.md',
    'packages/frontend/synthesizer/web-app/README.md',
  ]) {
    requirePattern(relativePath, /npm/iu, 'npm publication status');
    requirePattern(relativePath, /MIT OR Apache-2\.0|MIT.*Apache-2\.0/su, 'the repository dual-license policy');
  }
}

function checkLicensing() {
  if (fileExists('LICENSE')) {
    fail('The obsolete root LICENSE file must not override the dual-license declaration.');
  }

  for (const relativePath of ['LICENSE-MIT', 'LICENSE-APACHE']) {
    requireFile(relativePath);
  }

  const rootApacheLicense = readText('LICENSE-APACHE');
  for (const relativePath of [
    'packages/backend-wasm/LICENSE-APACHE',
    'packages/cli/LICENSE-APACHE',
    'packages/frontend/qap-compiler/LICENSE-APACHE',
    'packages/frontend/synthesizer/LICENSE-APACHE',
    'packages/frontend/synthesizer/node-cli/LICENSE-APACHE',
    'packages/frontend/synthesizer/web-app/LICENSE-APACHE',
  ]) {
    if (requireFile(relativePath) && readText(relativePath) !== rootApacheLicense) {
      fail(`${relativePath} must contain the complete repository Apache-2.0 license text.`);
    }
  }

  requirePattern(
    'CONTRIBUTING.md',
    /\[MIT\].* or \[Apache-2\.0\].*at the\s+recipient's option/su,
    'the repository dual-license contribution policy',
  );
  if (/Mozilla Public License|MPL-2\.0/u.test(readText('CONTRIBUTING.md'))) {
    fail('CONTRIBUTING.md must not retain the obsolete MPL-2.0 policy.');
  }
}

function checkPackageMetadata() {
  const publicationRepositoryPattern = /^(?:git\+)?https:\/\/github\.com\/JehyukJang\/Tokamak-zk-EVM(?:\.git)?$/u;
  const manifests = [
    'packages/cli/package.json',
    'packages/frontend/qap-compiler/package.json',
    'packages/frontend/synthesizer/node-cli/package.json',
    'packages/frontend/synthesizer/web-app/package.json',
    'packages/backend-wasm/package.json',
  ];

  for (const relativePath of manifests) {
    if (!requireFile(relativePath)) {
      continue;
    }
    const manifest = readJson(relativePath);
    for (const field of ['description', 'keywords', 'homepage', 'repository', 'bugs', 'license', 'author']) {
      if (manifest[field] === undefined || manifest[field] === '') {
        fail(`${relativePath} must define ${field}.`);
      }
    }
    if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
      fail(`${relativePath} must define non-empty keywords.`);
    }
    if (!manifest.repository?.url || !manifest.repository?.directory) {
      fail(`${relativePath} must define repository.url and repository.directory.`);
    }
    if (!publicationRepositoryPattern.test(manifest.repository?.url ?? '')) {
      fail(`${relativePath} repository.url must identify the GitHub repository that publishes npm provenance.`);
    }
    if (!manifest.bugs?.url) {
      fail(`${relativePath} must define bugs.url.`);
    }
  }
}

function checkSynthesizerFaq() {
  const relativePath = 'packages/frontend/synthesizer/README.md';
  for (const required of [
    '<a id="transaction-support-faq"></a>',
    '## Transaction support',
    'It supports contract calls when execution stays within the opcode',
    'It should not be described as supporting every arbitrary Ethereum transaction.',
  ]) {
    requireIncludes(relativePath, required);
  }
}

checkLlmsTxt();
checkRootReadme();
checkPackageReadmes();
checkReadmeResponsibilities();
checkLicensing();
checkPackageMetadata();
checkSynthesizerFaq();

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[doc-readiness] ${failure}`);
  }
  process.exit(1);
}

console.log('[doc-readiness] Documentation exposure checks passed.');
