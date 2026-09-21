import fs from 'node:fs/promises';
import path from 'node:path';

const commonRoot = path.resolve(import.meta.dirname, '..');
const backendRoot = path.resolve(commonRoot, '..');
const repositoryRoot = path.resolve(backendRoot, '..', '..');

const requiredBoundaries = [
  ['Canonical artifact JSON authority', 'common/contracts/univariate-artifact-contract.json'],
  ['Canonical Rust artifact codec', 'common/interface/src/artifact_bytes.rs'],
  ['Canonical TypeScript artifact codec', 'common/interface/typescript/artifact-bytes.ts'],
  ['Canonical artifact generator', 'common/scripts/generate-artifact-codecs.mjs'],
  ['CRS provenance JSON authority', 'common/contracts/crs-provenance-contract.json'],
  ['CRS provenance Rust representation', 'rust/libs/src/crs_provenance.rs'],
  ['CRS provenance common writer', 'rust/libs/src/crs_provenance.rs'],
  ['CRS provenance MPC producer', 'rust/setup/mpc-setup/src/phase2_cli.rs'],
  ['CRS provenance trusted-setup producer', 'rust/setup/trusted-setup/src/univariate.rs'],
  ['CRS provenance algorithm ingress', 'rust/libs/src/subcircuit_library.rs'],
  ['CRS provenance publication admission', 'rust/libs/src/crs_publication_admission.rs'],
  ['CRS provenance workflow admission command', 'rust/libs/src/bin/check_crs_publication.rs'],
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
  ['Subcircuit source-digest Rust authority', 'common/contracts/rust/subcircuit_source_digest.rs'],
  ['Subcircuit source-digest TypeScript authority', 'common/contracts/typescript/subcircuit-source-digest.ts'],
  ['Subcircuit source-digest fixed vectors', 'common/contracts/fixtures/subcircuit-source-digest-vectors.json'],
  ['Subcircuit source-digest build producer', 'rust/build-support/subcircuit_library/integrity.rs'],
  ['Univariate domain JSON authority', 'common/contracts/univariate-domain-contract.v1.json'],
  ['Univariate domain fixed vectors', 'common/contracts/fixtures/univariate-domain-shape.v1.json'],
  ['Univariate domain Rust implementation', 'rust/libs/src/univariate_crs.rs'],
  ['Univariate domain WASM implementation', 'wasm/src/univariate/domain.ts'],
  ['Univariate CRS chunk authority', 'common/contracts/univariate-crs-chunk-contract.json'],
  ['Univariate transcript authority', 'common/contracts/univariate-transcript-contract.json'],
  ['Univariate transcript fixed vectors', 'common/contracts/fixtures/univariate-fiat-shamir.json'],
  ['Univariate independent transcript tests', 'common/contracts/tests/univariate-transcript.test.mjs'],
  ['Univariate CRS 64-bit RKYV interface', 'common/interface/univariate-crs/src/lib.rs'],
  ['Univariate CRS RKYV chunk reader', 'wasm/tools/univariate-crs-chunker/src/main.rs'],
  ['Univariate CRS browser chunk runtime', 'wasm/src/univariate/chunked-crs.ts'],
];

const requiredConsumerBoundaries = [
  ['CLI CRS provenance consumer', 'packages/cli/src/runtime/setup.ts', 'parseCrsProvenance'],
  ['CLI build metadata consumer', 'packages/cli/src/runtime/setup.ts', 'parseBackendBuildMetadata'],
  ['CLI source-digest comparison', 'packages/cli/src/runtime/setup.ts', 'backendSubcircuitSourceDigest'],
  [
    'backend-wasm CRS provenance consumer',
    'packages/backend/wasm/src/artifacts/binary/compatibility.ts',
    'parseCrsProvenance',
  ],
  [
    'CLI copied provenance validator',
    'packages/cli/src/generated/crs-provenance-validator.generated.ts',
    'parseCrsProvenance',
  ],
  [
    'backend-wasm copied provenance validator',
    'packages/backend/wasm/src/generated/crs-provenance-validator.generated.ts',
    'parseCrsProvenance',
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
    'backend-wasm univariate CRS adapter',
    'packages/backend/wasm/scripts/converter/convert-univariate-crs.ts',
    'UNIVARIATE_CRS_CHUNK_CONTRACT',
  ],
  [
    'backend-wasm runtime artifact contract admission',
    'packages/backend/wasm/src/artifacts/binary/runtime-admission.ts',
    'RuntimeArtifactFormatSpec',
  ],
  [
    'backend-wasm generated univariate domain contract',
    'packages/backend/wasm/src/generated/univariate-domain-contract.generated.ts',
    'UNIVARIATE_DOMAIN_CONTRACT',
  ],
  [
    'backend-wasm generated univariate CRS chunk contract',
    'packages/backend/wasm/src/generated/univariate-crs-chunk-contract.generated.ts',
    'UNIVARIATE_CRS_CHUNK_CONTRACT',
  ],
  [
    'backend-wasm generated univariate transcript contract',
    'packages/backend/wasm/src/generated/univariate-transcript-contract.generated.ts',
    'UNIVARIATE_TRANSCRIPT_CONTRACT',
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
