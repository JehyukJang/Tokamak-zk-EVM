import { requireBinaryArtifactSection } from "../artifacts/binary/binary-artifact-file.js";
import type { BinarySectionView } from "../artifacts/binary/binary-format.js";
import { BinaryArtifactFileKind } from "../artifacts/binary/binary-format.js";
import { admitRuntimeBinaryArtifact } from "../artifacts/binary/runtime-admission.js";
import {
  UNIVARIATE_V2_PREPROCESS_CRS_V1_SPEC,
  UNIVARIATE_V2_PROVER_CRS_V1_SPEC,
  UNIVARIATE_V2_VERIFIER_CRS_V1_SPEC,
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
  readonly s0: BinarySectionView;
}

export interface UnivariateProverCrsRuntime {
  readonly declaredCapacity: readonly [bigint, bigint, bigint];
  readonly k: bigint;
  readonly s0: BinarySectionView;
  readonly sxi: BinarySectionView;
  readonly spsi: BinarySectionView;
  readonly interfaceQueries: UnivariateQueryRange<TaggedQueryKey>;
  readonly internalQueries: UnivariateQueryRange<TaggedQueryKey>;
  readonly masks: readonly [BinarySectionView, BinarySectionView, BinarySectionView, BinarySectionView];
  readonly deltaG1: Uint8Array;
  readonly etaG1: Uint8Array;
}

export interface UnivariateVerifierCrsRuntime {
  readonly declaredCapacity: readonly [bigint, bigint, bigint];
  readonly k: bigint;
  readonly oneG1: Uint8Array;
  readonly xiG1: Uint8Array;
  readonly psiG1: Uint8Array;
  readonly publicQueries: UnivariateQueryRange<PublicQueryKey>;
  readonly oneG2: Uint8Array;
  readonly tauG2: Uint8Array;
  readonly tauKG2: Uint8Array;
  readonly gammaG2: Uint8Array;
  readonly etaG2: Uint8Array;
  readonly deltaG2: Uint8Array;
}

/** Admits only the new preprocess CRS artifact kind. */
export function parseUnivariatePreprocessCrs(bytes: Uint8Array): UnivariatePreprocessCrsRuntime {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    BinaryArtifactFileKind.UnivariateV2PreprocessCrs,
    UNIVARIATE_V2_PREPROCESS_CRS_V1_SPEC,
  );
  return { s0: requireSection(artifact, UNIVARIATE_V2_PREPROCESS_CRS_V1_SPEC.sections[0]) };
}

/** Admits only the new prover CRS artifact kind and preserves query ranges zero-copy. */
export function parseUnivariateProverCrs(bytes: Uint8Array): UnivariateProverCrsRuntime {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    BinaryArtifactFileKind.UnivariateV2ProverCrs,
    UNIVARIATE_V2_PROVER_CRS_V1_SPEC,
  );
  const sections = UNIVARIATE_V2_PROVER_CRS_V1_SPEC.sections;
  const interfaceQueries = taggedQueryRange(
    requireSection(artifact, sections[4]),
    requireSection(artifact, sections[5]),
  );
  const internalQueries = taggedQueryRange(
    requireSection(artifact, sections[6]),
    requireSection(artifact, sections[7]),
  );
  const bindingSources = requireSection(artifact, sections[12]);
  const capacity = parseCapacity(requireSection(artifact, sections[0]));

  return {
    declaredCapacity: capacity.declaredCapacity,
    k: capacity.k,
    s0: requireSection(artifact, sections[1]),
    sxi: requireSection(artifact, sections[2]),
    spsi: requireSection(artifact, sections[3]),
    interfaceQueries,
    internalQueries,
    masks: [
      requireSection(artifact, sections[8]),
      requireSection(artifact, sections[9]),
      requireSection(artifact, sections[10]),
      requireSection(artifact, sections[11]),
    ],
    deltaG1: pointAt(bindingSources, 0),
    etaG1: pointAt(bindingSources, 1),
  };
}

/** Admits only the new verifier CRS artifact kind and preserves its public range zero-copy. */
export function parseUnivariateVerifierCrs(bytes: Uint8Array): UnivariateVerifierCrsRuntime {
  const artifact = admitRuntimeBinaryArtifact(
    bytes,
    BinaryArtifactFileKind.UnivariateV2VerifierCrs,
    UNIVARIATE_V2_VERIFIER_CRS_V1_SPEC,
  );
  const sections = UNIVARIATE_V2_VERIFIER_CRS_V1_SPEC.sections;
  const g1 = requireSection(artifact, sections[1]);
  const g2 = requireSection(artifact, sections[4]);
  const capacity = parseCapacity(requireSection(artifact, sections[0]));

  return {
    declaredCapacity: capacity.declaredCapacity,
    k: capacity.k,
    oneG1: pointAt(g1, 0),
    xiG1: pointAt(g1, 1),
    psiG1: pointAt(g1, 2),
    publicQueries: publicQueryRange(
      requireSection(artifact, sections[2]),
      requireSection(artifact, sections[3]),
    ),
    oneG2: pointAt(g2, 0),
    tauG2: pointAt(g2, 1),
    tauKG2: pointAt(g2, 2),
    gammaG2: pointAt(g2, 3),
    etaG2: pointAt(g2, 4),
    deltaG2: pointAt(g2, 5),
  };
}

function parseCapacity(section: BinarySectionView): {
  readonly declaredCapacity: readonly [bigint, bigint, bigint];
  readonly k: bigint;
} {
  if (section.elementCount !== 4 || section.elementByteLength !== 8 || section.byteLength !== 32) {
    throw new Error("univariate CRS capacity metadata has an invalid layout.");
  }
  const view = new DataView(section.data.buffer, section.data.byteOffset, section.data.byteLength);
  const declaredCapacity = [view.getBigUint64(0, true), view.getBigUint64(8, true), view.getBigUint64(16, true)] as const;
  return { declaredCapacity, k: view.getBigUint64(24, true) };
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
