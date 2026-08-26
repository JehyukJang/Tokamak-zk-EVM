import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertBinaryArtifactCompatibility,
  type CrsProvenanceInput,
  validateCrsProvenanceCompatibility,
} from '../../../src/artifacts/binary/compatibility.js';
import { BinaryArtifactFileKind, type BinaryArtifactFileView } from '../../../src/artifacts/binary/binary-format.js';
import { SUBCIRCUIT_LIBRARY_PACKAGE_VERSION } from '../../../src/generated/setup.generated.js';

const PACKAGE_NAME = '@tokamak-zk-evm/subcircuit-library';
const CANONICAL_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const MALFORMED_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-malformed.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const LEGACY_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-legacy.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const LEADING_ZERO_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-leading-zero.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const DATE_ONLY_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-date-only.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const INVALID_DIGEST_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-invalid-digest.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const EMPTY_STRING_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-empty-string.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const NATIVE_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-native.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const NULL_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-null.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;
const INVALID_PHASE1_FINAL_MPC_PROVENANCE = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      'backend',
      'contracts',
      'fixtures',
      'final-mpc-crs-provenance-invalid-phase1.json',
    ),
    'utf8',
  ),
) as CrsProvenanceInput;

function compatibleVersion(packageVersion: string): string {
  const [major, minor] = packageVersion.split('.');
  return `${Number(major)}.${Number(minor)}`;
}

function provenance(version: string): CrsProvenanceInput {
  return {
    documentKind: 'finalMpcCrs',
    releaseEligible: false,
    generatedAtUtc: '2026-08-24T00:00:00Z',
    compatibleBackendVersion: compatibleVersion(version),
    subcircuitLibrary: {
      packageName: PACKAGE_NAME,
      packageVersion: version,
      origin: 'npmSnapshot',
    },
    phase1SourceProvenance: null,
    combinedSigmaSha256: '0'.repeat(64),
    sigmaPreprocessSha256: '1'.repeat(64),
    sigmaVerifySha256: '2'.repeat(64),
  };
}

function artifact(sourcePackageVersion: string): BinaryArtifactFileView {
  return {
    kind: BinaryArtifactFileKind.ProverCrs,
    formatVersion: 1,
    sourcePackageVersion,
    byteLength: 0,
    selfDigest: new Uint8Array(32),
    sections: [],
  };
}

function expectFailure(action: () => void, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

function main(): void {
  const expected = provenance(SUBCIRCUIT_LIBRARY_PACKAGE_VERSION);
  validateCrsProvenanceCompatibility(expected);
  validateCrsProvenanceCompatibility(CANONICAL_FINAL_MPC_PROVENANCE);
  validateCrsProvenanceCompatibility(NATIVE_FINAL_MPC_PROVENANCE);
  validateCrsProvenanceCompatibility(NULL_FINAL_MPC_PROVENANCE);
  assertBinaryArtifactCompatibility(artifact(SUBCIRCUIT_LIBRARY_PACKAGE_VERSION));

  expectFailure(
    () => validateCrsProvenanceCompatibility(LEADING_ZERO_FINAL_MPC_PROVENANCE),
    'Leading-zero CRS compatibility versions must be rejected by the root version policy.',
  );
  const leadingZeroPackageVersion = structuredClone(expected);
  leadingZeroPackageVersion.subcircuitLibrary.packageVersion = '02.01.5';
  expectFailure(
    () => validateCrsProvenanceCompatibility(leadingZeroPackageVersion),
    'Leading-zero subcircuit-library versions must be rejected by the root version policy.',
  );

  expectFailure(
    () => validateCrsProvenanceCompatibility(provenance('9.9.0')),
    'CRS provenance from a distinct compatibility class must be rejected.',
  );
  expectFailure(
    () => validateCrsProvenanceCompatibility(MALFORMED_FINAL_MPC_PROVENANCE),
    'Malformed provenance must be rejected.',
  );
  expectFailure(
    () => validateCrsProvenanceCompatibility(LEGACY_FINAL_MPC_PROVENANCE),
    'Legacy snake_case Dusk provenance must be rejected.',
  );
  expectFailure(
    () => validateCrsProvenanceCompatibility(DATE_ONLY_FINAL_MPC_PROVENANCE),
    'Date-only provenance timestamps must be rejected.',
  );
  expectFailure(
    () => validateCrsProvenanceCompatibility(INVALID_DIGEST_FINAL_MPC_PROVENANCE),
    'Non-SHA-256 provenance digests must be rejected.',
  );
  expectFailure(
    () => validateCrsProvenanceCompatibility(EMPTY_STRING_FINAL_MPC_PROVENANCE),
    'Empty required provenance strings must be rejected.',
  );
  expectFailure(
    () => validateCrsProvenanceCompatibility(INVALID_PHASE1_FINAL_MPC_PROVENANCE),
    'Unsupported phase-1 provenance variants must be rejected.',
  );
  expectFailure(
    () => assertBinaryArtifactCompatibility(artifact('9.9.0')),
    'Binary CRS from a distinct compatibility class must be rejected.',
  );
  console.log('Checked CRS and binary artifact compatibility-class rejection');
}

main();
