import fs from 'node:fs/promises';
import path from 'node:path';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const vendoredBackendRoot = path.join(packageRoot, 'vendor', 'backend');

const directoryExclusions = new Set([
  'target',
  '.vscode',
  'external-lib',
  'output',
  'output-mpc',
  'output-mpc-general',
  'benches',
  'docs',
  'optimization',
  'tmp',
]);

const fileExclusions = [
  '.env',
  '.DS_Store',
  '.gitignore',
  'README.md',
  'README_mpc.md',
  'download-ICICLE-lib.sh',
  'Dockerfile',
  'google-drive-oauth-token.json',
  /^client_secret_.*\.json$/u,
  /^Dockerfile\..*/u,
  /^gen-lang-client-.*\.json$/u,
];

const cargoManifestSanitizers = [
  /\n\[\[bench\]\]\r?\nname = "outer_product_bench"\r?\nharness = false\r?\n?/gu,
  /\n\[\[bench\]\]\r?\nname = "matrix_matrix_mul_bench"\r?\nharness = false\r?\n?/gu,
  /\n\[\[test\]\]\r?\nname = "timing"\r?\npath = "optimization\/tests\/timing\.rs"\r?\n?/gu,
  /\ncriterion = "0\.3"\r?\n/gu,
];

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

function shouldCopyBackendRelativePath(relative) {
  if (!relative || relative.startsWith('..')) {
    return true;
  }

  const parts = relative.split(path.sep);
  for (const part of parts) {
    if (directoryExclusions.has(part)) {
      return false;
    }
  }
  const leaf = parts.at(-1) ?? '';
  for (const matcher of fileExclusions) {
    if (typeof matcher === 'string' ? leaf === matcher : matcher.test(leaf)) {
      return false;
    }
  }
  return true;
}

function shouldCopyBackendPath(sourcePath) {
  return shouldCopyBackendRelativePath(
    path.relative(path.join(repoRoot, 'packages', 'backend'), sourcePath),
  );
}

async function copyDirectory(from, to, filter) {
  await fs.cp(from, to, {
    recursive: true,
    filter: filter ?? (() => true),
  });
}

async function sanitizeCargoManifest(filePath) {
  let contents = await fs.readFile(filePath, 'utf8');
  for (const sanitizer of cargoManifestSanitizers) {
    contents = contents.replace(sanitizer, '\n');
  }
  await fs.writeFile(filePath, contents, 'utf8');
}

async function assertPreparedBackendTree(directory = vendoredBackendRoot) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(vendoredBackendRoot, entryPath);
    if (!shouldCopyBackendRelativePath(relative)) {
      throw new Error(`Excluded backend path entered package staging: ${relative}`);
    }
    if (entry.isDirectory()) {
      await assertPreparedBackendTree(entryPath);
    }
  }
}

async function main() {
  await fs.rm(path.join(packageRoot, 'vendor'), { recursive: true, force: true });
  await ensureDir(vendoredBackendRoot);
  await ensureDir(path.join(packageRoot, 'manifests'));
  await fs.copyFile(
    path.join(repoRoot, 'packages', 'backend', 'contracts', 'crs-provenance-contract.json'),
    path.join(packageRoot, 'manifests', 'crs-provenance-contract.json'),
  );
  await copyDirectory(
    path.join(repoRoot, 'packages', 'backend'),
    vendoredBackendRoot,
    shouldCopyBackendPath,
  );

  await sanitizeCargoManifest(path.join(vendoredBackendRoot, 'libs', 'Cargo.toml'));
  await sanitizeCargoManifest(path.join(vendoredBackendRoot, 'prove', 'Cargo.toml'));
  await assertPreparedBackendTree();
}

await main();
