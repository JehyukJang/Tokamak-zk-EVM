import fs from 'node:fs/promises';
import path from 'node:path';

const backendRoot = path.resolve(import.meta.dirname, '..', '..');
const repositoryRoot = path.resolve(backendRoot, '..', '..');

const requiredBoundaries = [
  ['CRS provenance JSON authority', 'common/contracts/crs-provenance-contract.json'],
  ['CRS provenance Rust representation', 'rust/libs/src/crs_provenance.rs'],
  ['CRS provenance final writer', 'rust/setup/mpc-setup/src/flows/phase2_gen_files.rs'],
  ['CRS provenance algorithm ingress', 'rust/libs/src/subcircuit_library.rs'],
  ['CRS provenance publisher ingress', 'rust/setup/mpc-setup/src/drive_upload.rs'],
  ['CRS provenance TypeScript validator', 'common/contracts/typescript/crs-provenance-validator.ts'],
  ['CRS provenance closure inventory', 'common/contracts/CONTRACT_CLOSURE.md'],
  ['Build metadata JSON authority', 'common/contracts/backend-build-metadata-contract.json'],
  ['Build metadata Rust representation', 'common/contracts/rust/backend_build_metadata.rs'],
  ['Build metadata production writer', 'rust/build-support/subcircuit_library/cargo_env.rs'],
  ['Build metadata TypeScript validator', 'common/contracts/typescript/backend-build-metadata-validator.ts'],
  ['Input-origin provenance authority', 'common/contracts/crs-provenance-contract.json'],
  ['Input-origin Rust representation', 'common/contracts/rust/input_origin.rs'],
  ['Input-origin build selection', 'rust/build-support/subcircuit_library/source_selection.rs'],
  ['Input-origin serde ingress', 'rust/libs/src/input_origin_serde.rs'],
];

const requiredConsumerBoundaries = [
  ['CLI CRS provenance consumer', 'packages/cli/src/runtime/setup.ts', 'parseFinalMpcCrsProvenance'],
  ['CLI build metadata consumer', 'packages/cli/src/runtime/setup.ts', 'parseBackendBuildMetadata'],
  [
    'backend-wasm CRS provenance consumer',
    'packages/backend/wasm/src/artifacts/binary/compatibility.ts',
    'parseFinalMpcCrsProvenance',
  ],
  [
    'CLI copied provenance validator',
    'packages/cli/src/generated/crs-provenance-validator.generated.ts',
    'parseFinalMpcCrsProvenance',
  ],
  [
    'backend-wasm copied provenance validator',
    'packages/backend/wasm/src/generated/crs-provenance-validator.generated.ts',
    'parseFinalMpcCrsProvenance',
  ],
  [
    'CLI copied build metadata validator',
    'packages/cli/src/generated/backend-build-metadata-validator.generated.ts',
    'parseBackendBuildMetadata',
  ],
  [
    'backend-wasm qap contract adapter',
    'packages/backend/wasm/scripts/generate/subcircuit-library-input.ts',
    'SUBCIRCUIT_LIBRARY_CONTRACT',
  ],
  [
    'backend-wasm synthesizer contract adapter',
    'packages/backend/wasm/src/converter/conversion/instance-converter.ts',
    'SYNTHESIZER_BROWSER_ARTIFACT_CONTRACT',
  ],
  [
    'backend-wasm backend contract adapter',
    'packages/backend/wasm/src/converter/conversion/rkyv-to-binary.ts',
    'BACKEND_BROWSER_ARTIFACT_CONTRACT',
  ],
  [
    'backend-wasm runtime artifact contract admission',
    'packages/backend/wasm/src/artifacts/binary/runtime-admission.ts',
    'RuntimeArtifactFormatSpec',
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
