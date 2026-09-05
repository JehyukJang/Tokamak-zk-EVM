import { requireBinaryArtifactSection } from "../artifacts/binary/binary-artifact-file.js";
import type { BinarySectionView } from "../artifacts/binary/binary-format.js";
import { BinaryArtifactFileKind } from "../artifacts/binary/binary-format.js";
import { admitRuntimeBinaryArtifact } from "../artifacts/binary/runtime-admission.js";
import {
  UNIVARIATE_PREPROCESS_CRS_V1_SPEC,
  UNIVARIATE_PROVER_CRS_V1_SPEC,
  UNIVARIATE_VERIFIER_CRS_V1_SPEC,
} from "../generated/browser-artifact-contracts.generated.js";

export interface TaggedQueryKey {
  readonly placementIndex: number;
  readonly subcircuitId: number;
  readonly localWireIndex: number;
}

export interface PublicQueryKey {
  readonly bufferSubcircuitId: number;
  readonly localPublicWireIndex: number;
}

/**
 * A zero-copy key table paired one-for-one with an affine G1 query section.
 * Runtime code resolves only the entries it needs and therefore never expands
 * a public or tagged query grid into JavaScript objects.
 */
export interface UnivariateQueryRange<Key> {
  readonly keys: BinarySectionView;
  readonly points: BinarySectionView;
  readonly keyAt: (index: number) => Key;
}

export interface UnivariatePreprocessCrsRuntime {
  readonly kzgPowers: BinarySectionView;
}

export interface UnivariateProverCrsRuntime {
  readonly kzgPowers: BinarySectionView;
  readonly interfaceQueries: UnivariateQueryRange<TaggedQueryKey>;
  readonly internalQueries: UnivariateQueryRange<TaggedQueryKey>;
  readonly arithmeticMasks: readonly [BinarySectionView, BinarySectionView, BinarySectionView];
  readonly connectionMask: BinarySectionView;
  readonly deltaG1: Uint8Array;
  readonly etaG1: Uint8Array;
}

export interface UnivariateVerifierCrsRuntime {
  readonly oneG1: Uint8Array;
  readonly publicQueries: UnivariateQueryRange<PublicQueryKey>;
  readonly oneG2: Uint8Array;
  readonly tauG2: Uint8Array;
  readonly alphaG2: readonly [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  readonly gammaG2: Uint8Array;
  readonly etaG2: Uint8Array;
  readonly deltaG2: Uint8Array;
}

/** Admits only the new preprocess CRS artifact kind. */
export function parseUnivariatePreprocessCrs(bytes: Uint8Array): UnivariatePreprocessCrsRuntime {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    BinaryArtifactFileKind.UnivariatePreprocessCrs,
    UNIVARIATE_PREPROCESS_CRS_V1_SPEC,
  );
  return { kzgPowers: requireSection(artifact, UNIVARIATE_PREPROCESS_CRS_V1_SPEC.sections[0]) };
}

/** Admits only the new prover CRS artifact kind and preserves query ranges zero-copy. */
export function parseUnivariateProverCrs(bytes: Uint8Array): UnivariateProverCrsRuntime {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    BinaryArtifactFileKind.UnivariateProverCrs,
    UNIVARIATE_PROVER_CRS_V1_SPEC,
  );
  const sections = UNIVARIATE_PROVER_CRS_V1_SPEC.sections;
  const interfaceQueries = taggedQueryRange(
    requireSection(artifact, sections[1]),
    requireSection(artifact, sections[2]),
  );
  const internalQueries = taggedQueryRange(
    requireSection(artifact, sections[3]),
    requireSection(artifact, sections[4]),
  );
  const bindingSources = requireSection(artifact, sections[9]);

  return {
    kzgPowers: requireSection(artifact, sections[0]),
    interfaceQueries,
    internalQueries,
    arithmeticMasks: [
      requireSection(artifact, sections[5]),
      requireSection(artifact, sections[6]),
      requireSection(artifact, sections[7]),
    ],
    connectionMask: requireSection(artifact, sections[8]),
    deltaG1: pointAt(bindingSources, 0),
    etaG1: pointAt(bindingSources, 1),
  };
}

/** Admits only the new verifier CRS artifact kind and preserves its public range zero-copy. */
export function parseUnivariateVerifierCrs(bytes: Uint8Array): UnivariateVerifierCrsRuntime {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    BinaryArtifactFileKind.UnivariateVerifierCrs,
    UNIVARIATE_VERIFIER_CRS_V1_SPEC,
  );
  const sections = UNIVARIATE_VERIFIER_CRS_V1_SPEC.sections;
  const g2 = requireSection(artifact, sections[3]);

  return {
    oneG1: pointAt(requireSection(artifact, sections[0]), 0),
    publicQueries: publicQueryRange(
      requireSection(artifact, sections[1]),
      requireSection(artifact, sections[2]),
    ),
    oneG2: pointAt(g2, 0),
    tauG2: pointAt(g2, 1),
    alphaG2: [pointAt(g2, 2), pointAt(g2, 3), pointAt(g2, 4), pointAt(g2, 5)],
    gammaG2: pointAt(g2, 6),
    etaG2: pointAt(g2, 7),
    deltaG2: pointAt(g2, 8),
  };
}

function taggedQueryRange(keys: BinarySectionView, points: BinarySectionView): UnivariateQueryRange<TaggedQueryKey> {
  assertPairedRange(keys, points, 12, "tagged query");
  return {
    keys,
    points,
    keyAt(index) {
      assertIndex(index, keys.elementCount, "tagged query key");
      const offset = index * 12;
      const view = new DataView(keys.data.buffer, keys.data.byteOffset, keys.data.byteLength);
      return {
        placementIndex: view.getUint32(offset, true),
        subcircuitId: view.getUint32(offset + 4, true),
        localWireIndex: view.getUint32(offset + 8, true),
      };
    },
  };
}

function publicQueryRange(keys: BinarySectionView, points: BinarySectionView): UnivariateQueryRange<PublicQueryKey> {
  assertPairedRange(keys, points, 8, "public query");
  return {
    keys,
    points,
    keyAt(index) {
      assertIndex(index, keys.elementCount, "public query key");
      const offset = index * 8;
      const view = new DataView(keys.data.buffer, keys.data.byteOffset, keys.data.byteLength);
      return {
        bufferSubcircuitId: view.getUint32(offset, true),
        localPublicWireIndex: view.getUint32(offset + 4, true),
      };
    },
  };
}

function assertPairedRange(
  keys: BinarySectionView,
  points: BinarySectionView,
  expectedKeyWidth: number,
  name: string,
): void {
  if (keys.elementByteLength !== expectedKeyWidth || keys.elementCount !== points.elementCount) {
    throw new Error(`${name} keys and points do not define the same canonical range.`);
  }
}

function requireSection(
  artifact: Parameters<typeof requireBinaryArtifactSection>[0],
  spec: Parameters<typeof requireBinaryArtifactSection>[1],
): BinarySectionView {
  return requireBinaryArtifactSection(artifact, spec);
}

function pointAt(section: BinarySectionView, index: number): Uint8Array {
  assertIndex(index, section.elementCount, section.label);
  const offset = index * section.elementByteLength;
  return section.data.subarray(offset, offset + section.elementByteLength);
}

function assertIndex(index: number, count: number, label: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`${label} index ${index} is outside the artifact range.`);
  }
}
