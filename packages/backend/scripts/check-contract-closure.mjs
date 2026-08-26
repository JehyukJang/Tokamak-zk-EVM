import fs from 'node:fs/promises';
import path from 'node:path';

const backendRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(backendRoot, '..', '..');

const requiredBoundaries = [
  ['CRS provenance JSON authority', 'contracts/crs-provenance-contract.json'],
  ['CRS provenance Rust representation', 'libs/src/crs_provenance.rs'],
  ['CRS provenance final writer', 'setup/mpc-setup/src/flows/phase2_gen_files.rs'],
  ['CRS provenance algorithm ingress', 'libs/src/subcircuit_library.rs'],
  ['CRS provenance publisher ingress', 'setup/mpc-setup/src/drive_upload.rs'],
  ['CRS provenance TypeScript validator', 'contracts/typescript/crs-provenance-validator.ts'],
  ['CRS provenance closure inventory', 'contracts/CONTRACT_CLOSURE.md'],
  ['Build metadata JSON authority', 'contracts/backend-build-metadata-contract.json'],
  ['Build metadata Rust representation', 'contracts/rust/backend_build_metadata.rs'],
  ['Build metadata production writer', 'build-support/subcircuit_library/cargo_env.rs'],
  ['Build metadata TypeScript validator', 'contracts/typescript/backend-build-metadata-validator.ts'],
  ['Input-origin provenance authority', 'contracts/crs-provenance-contract.json'],
  ['Input-origin Rust representation', 'contracts/rust/input_origin.rs'],
  ['Input-origin build selection', 'build-support/subcircuit_library/source_selection.rs'],
  ['Input-origin serde ingress', 'libs/src/input_origin_serde.rs'],
];

const requiredConsumerBoundaries = [
  ['CLI CRS provenance consumer', 'packages/cli/src/runtime/setup.ts', 'parseFinalMpcCrsProvenance'],
  ['CLI build metadata consumer', 'packages/cli/src/runtime/setup.ts', 'parseBackendBuildMetadata'],
  [
    'backend-wasm CRS provenance consumer',
    'packages/backend-wasm/src/artifacts/binary/compatibility.ts',
    'parseFinalMpcCrsProvenance',
  ],
  [
    'CLI copied provenance validator',
    'packages/cli/src/generated/crs-provenance-validator.generated.ts',
    'parseFinalMpcCrsProvenance',
  ],
  [
    'backend-wasm copied provenance validator',
    'packages/backend-wasm/src/generated/crs-provenance-validator.generated.ts',
    'parseFinalMpcCrsProvenance',
  ],
  [
    'CLI copied build metadata validator',
    'packages/cli/src/generated/backend-build-metadata-validator.generated.ts',
    'parseBackendBuildMetadata',
  ],
];

for (const [label, relativePath] of requiredBoundaries) {
  await requireFile(label, path.join(backendRoot, relativePath));
}
for (const [label, relativePath, requiredSymbol] of requiredConsumerBoundaries) {
  const source = await requireFile(label, path.join(repositoryRoot, relativePath));
  if (!source.includes(requiredSymbol)) {
    throw new Error(`${label} no longer references ${requiredSymbol}. Update CONTRACT_CLOSURE.md and this check.`);
  }
}

console.log('Checked backend contract closure inventory and direct consumer boundaries');

async function requireFile(label, absolutePath) {
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (error) {
    throw new Error(`${label} is missing at ${absolutePath}: ${message(error)}`);
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
