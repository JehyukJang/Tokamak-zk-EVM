import {
  admitUnivariateCrsChunks,
  type UnivariateCrsChunkInput,
  type UnivariateCrsChunkSection,
} from "./chunked-crs.js";

export interface TaggedQueryKey {
  readonly placementIndex: number;
  readonly subcircuitId: number;
  readonly localWireIndex: number;
}

export interface PublicQueryKey {
  readonly bufferSubcircuitId: number;
  readonly localPublicWireIndex: number;
}

export interface UnivariateQueryRange<Key> {
  readonly keys: UnivariateCrsChunkSection;
  readonly points: UnivariateCrsChunkSection;
  readonly keyAt: (index: number) => Promise<Key>;
}

export interface UnivariatePreprocessCrsRuntime {
  readonly s0: UnivariateCrsChunkSection;
}

export interface UnivariateProverCrsRuntime {
  readonly declaredCapacity: readonly [bigint, bigint, bigint];
  readonly k: bigint;
  readonly s0: UnivariateCrsChunkSection;
  readonly sxi: UnivariateCrsChunkSection;
  readonly spsi: UnivariateCrsChunkSection;
  readonly interfaceQueries: UnivariateQueryRange<TaggedQueryKey>;
  readonly internalQueries: UnivariateQueryRange<TaggedQueryKey>;
  readonly masks: readonly [UnivariateCrsChunkSection, UnivariateCrsChunkSection, UnivariateCrsChunkSection, UnivariateCrsChunkSection];
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

export async function parseUnivariatePreprocessCrs(
  input: UnivariateCrsChunkInput,
): Promise<UnivariatePreprocessCrsRuntime> {
  const crs = admitUnivariateCrsChunks(input, "preprocess");
  return { s0: crs.requireSection("crs.s0") };
}

export async function parseUnivariateProverCrs(
  input: UnivariateCrsChunkInput,
): Promise<UnivariateProverCrsRuntime> {
  const crs = admitUnivariateCrsChunks(input, "prover");
  const bindingSources = crs.requireSection("crs.binding-sources");
  return {
    declaredCapacity: crs.declaredCapacity,
    k: crs.k,
    s0: crs.requireSection("crs.s0"),
    sxi: crs.requireSection("crs.sxi"),
    spsi: crs.requireSection("crs.spsi"),
    interfaceQueries: taggedQueryRange(
      crs.requireSection("crs.interface-query-keys"),
      crs.requireSection("crs.interface-queries"),
    ),
    internalQueries: taggedQueryRange(
      crs.requireSection("crs.internal-query-keys"),
      crs.requireSection("crs.internal-queries"),
    ),
    masks: [
      crs.requireSection("crs.mask-u"),
      crs.requireSection("crs.mask-v"),
      crs.requireSection("crs.mask-w"),
      crs.requireSection("crs.mask-b"),
    ],
    deltaG1: await bindingSources.readElement(0),
    etaG1: await bindingSources.readElement(1),
  };
}

export async function parseUnivariateVerifierCrs(
  input: UnivariateCrsChunkInput,
): Promise<UnivariateVerifierCrsRuntime> {
  const crs = admitUnivariateCrsChunks(input, "verifier");
  const g1 = crs.requireSection("crs.g1-handles");
  const g2 = crs.requireSection("crs.g2");
  const [oneG1, xiG1, psiG1, oneG2, tauG2, tauKG2, gammaG2, etaG2, deltaG2] = await Promise.all([
    g1.readElement(0),
    g1.readElement(1),
    g1.readElement(2),
    g2.readElement(0),
    g2.readElement(1),
    g2.readElement(2),
    g2.readElement(3),
    g2.readElement(4),
    g2.readElement(5),
  ]);
  return {
    declaredCapacity: crs.declaredCapacity,
    k: crs.k,
    oneG1,
    xiG1,
    psiG1,
    publicQueries: publicQueryRange(
      crs.requireSection("crs.public-query-keys"),
      crs.requireSection("crs.public-queries"),
    ),
    oneG2,
    tauG2,
    tauKG2,
    gammaG2,
    etaG2,
    deltaG2,
  };
}

function taggedQueryRange(
  keys: UnivariateCrsChunkSection,
  points: UnivariateCrsChunkSection,
): UnivariateQueryRange<TaggedQueryKey> {
  assertPairedRange(keys, points, 12, "tagged query");
  return {
    keys,
    points,
    async keyAt(index) {
      const bytes = await keys.readElement(index);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        placementIndex: view.getUint32(0, true),
        subcircuitId: view.getUint32(4, true),
        localWireIndex: view.getUint32(8, true),
      };
    },
  };
}

function publicQueryRange(
  keys: UnivariateCrsChunkSection,
  points: UnivariateCrsChunkSection,
): UnivariateQueryRange<PublicQueryKey> {
  assertPairedRange(keys, points, 8, "public query");
  return {
    keys,
    points,
    async keyAt(index) {
      const bytes = await keys.readElement(index);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return {
        bufferSubcircuitId: view.getUint32(0, true),
        localPublicWireIndex: view.getUint32(4, true),
      };
    },
  };
}

function assertPairedRange(
  keys: UnivariateCrsChunkSection,
  points: UnivariateCrsChunkSection,
  expectedKeyWidth: number,
  name: string,
): void {
  if (keys.elementByteLength !== expectedKeyWidth || keys.elementCount !== points.elementCount) {
    throw new Error(`${name} keys and points do not define the same canonical range.`);
  }
}

export type { UnivariateCrsChunkInput } from "./chunked-crs.js";
