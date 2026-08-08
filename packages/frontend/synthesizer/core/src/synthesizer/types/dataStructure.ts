export type DataPtWireLayout = Readonly<{ kind: 'limbs-128'; count: 1 | 2 }> | Readonly<{ kind: 'native-fr' }>;

export type DataPtValueDomain =
  | Readonly<{ kind: 'uint'; bits: number }>
  | Readonly<{ kind: 'bls12-381-fr' }>
  | Readonly<{ kind: 'jubjub-scalar' }>;

export type DataPtType = Readonly<{
  valueDomain: DataPtValueDomain;
  wireLayout: DataPtWireLayout;
}>;

export const EVM_WORD_DATA_PT_TYPE: DataPtType = Object.freeze({
  valueDomain: Object.freeze({ kind: 'uint', bits: 256 }),
  wireLayout: Object.freeze({ kind: 'limbs-128', count: 2 }),
});

export const UINT64_LIMB_DATA_PT_TYPE: DataPtType = Object.freeze({
  valueDomain: Object.freeze({ kind: 'uint', bits: 64 }),
  wireLayout: Object.freeze({ kind: 'limbs-128', count: 1 }),
});

export const UINT85_LIMB_DATA_PT_TYPE: DataPtType = Object.freeze({
  valueDomain: Object.freeze({ kind: 'uint', bits: 85 }),
  wireLayout: Object.freeze({ kind: 'limbs-128', count: 1 }),
});

export const UINT86_LIMB_DATA_PT_TYPE: DataPtType = Object.freeze({
  valueDomain: Object.freeze({ kind: 'uint', bits: 86 }),
  wireLayout: Object.freeze({ kind: 'limbs-128', count: 1 }),
});

export const BIT_LIMB_DATA_PT_TYPE: DataPtType = Object.freeze({
  valueDomain: Object.freeze({ kind: 'uint', bits: 1 }),
  wireLayout: Object.freeze({ kind: 'limbs-128', count: 1 }),
});

export const BLS12_381_FR_NATIVE_DATA_PT_TYPE: DataPtType = Object.freeze({
  valueDomain: Object.freeze({ kind: 'bls12-381-fr' }),
  wireLayout: Object.freeze({ kind: 'native-fr' }),
});

export type DataPtDescription = {
  // if data comes from external
  extSource?: string;
  // if data is provided to external
  extDest?: string;
  // external data type
  // type?: string;
  // // key if the external data comes from or goes to a DB
  // key?: string;
  // offset if the external data comes from a memory
  // offset?: number;
  // // used for pairing the Keccak input and output (as input can be longer than 256 bit)
  // pairedInputWireIndices?: number[]

  // placement index at which the dataPt comes from
  source: number;
  // wire index at which the dataPt comes from
  wireIndex: number;

  readonly dataPtType: DataPtType;

  // identifier?: string
};
export type DataPt = DataPtDescription & { value: bigint; valueHex: string };

/**
 * Structure representing data alias information.
 * @property {DataPt} dataPt - Original data pointer
 * @property {number} shift - Number of bit shifts (positive for SHL, negative for SHR)
 * @property {string} masker - Hexadecimal string representing valid bytes (FF) or invalid bytes (00)
 */
export type DataAliasInfoEntry = { dataPt: DataPt; shift: number; masker: string };
export type DataAliasInfos = DataAliasInfoEntry[];

/**
 * Structure representing memory information.
 * @property {number} memOffset - Memory offset
 * @property {number} containerSize - Container size
 * @property {DataPt} dataPt - Data pointer
 */
export type MemoryPtEntry = { memByteOffset: number; containerByteSize: number; dataPt: DataPt };

/**
 * Array of memory information. Lower indices represent older memory information.
 */
export type MemoryPts = MemoryPtEntry[];
