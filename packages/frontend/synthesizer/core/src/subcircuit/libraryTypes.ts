
// -----------------------------------------------------------------------------
// Types (internal): keep these un-exported as requested
// -----------------------------------------------------------------------------

import { SUBCIRCUIT_LIST, SubcircuitNames } from "./configuredTypes.ts";
import type { ArithmeticSubcircuitComposition } from './arithmeticSubcircuitComposition.ts';
import type {
  ReservedBuffer,
  SubcircuitInfoByName,
  SubcircuitInfoByNameEntry,
} from './configuredTypes.ts';

// Single source of truth for SetupParams keys
export const SETUP_PARAMS_KEYS = [
  'l_log_out', 'l_storage_store', 'l_storage_load', 'l_tx_in',
  'l_block_in', 'l_evm_in',
  'l_free', 'l_user_out', 'l_user', 'l',
  'l_D', 'm_D', 'n', 's_D', 's_max',
] as const;

// Shapes used by typed exports below
export type SetupParams = Record<typeof SETUP_PARAMS_KEYS[number], number>;
export type GlobalWireEntry = readonly [subcircuitId: number, localWireIndex: number];
export type GlobalWireList = GlobalWireEntry[];

// Primitive validators
export const isObjectRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null;
export const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const isSubcircuitName = (x: unknown): x is SubcircuitNames =>
  typeof x === 'string' && SUBCIRCUIT_LIST.some((name) => name === x);
export const isTupleNumber2 = (x: unknown): x is [number, number] =>
  Array.isArray(x) && x.length === 2 && isNumber(x[0]) && isNumber(x[1]);
export const isNumberArray = (x: unknown): x is number[] => Array.isArray(x) && x.every(isNumber);

// Validator map that also drives the SubcircuitInfo shape
export const SUBCIRCUIT_INFO_VALIDATORS = {
  id: isNumber,
  name: isSubcircuitName,
  Nwires: isNumber,
  Nconsts: isNumber,
  Out_idx: isTupleNumber2,
  In_idx: isTupleNumber2,
  flattenMap: isNumberArray,
};

export type ValidatorMap = typeof SUBCIRCUIT_INFO_VALIDATORS;
// Derive the item shape from the validator map (no duplication)
type SubcircuitInfoItem = { [K in keyof ValidatorMap]: ValidatorMap[K] extends (x: unknown) => x is infer T ? T : never };
// Array of items
export type SubcircuitInfo = SubcircuitInfoItem[];

// Required Circom constants (qap-compiler/subcircuits/circom/constants.circom).
// Every buffer n* constant is an input-wire capacity and requires no scaling.
export const REQUIRED_CIRCOM_KEYS = [
  'nTxIn',
  'nStorageLoad',
  'nLogOut',
  'nStorageStore',
  'nBlockIn',
  'nPrvIn',
  'nEVMIn',
  'nPoseidonInputs',
  'nPoseidonBatch',
  'nAccumulation',
  'nPrevBlockHashes',
  'nJubjubExpBatch',
  'nSubExpBatch',
  'nEqualBatch',
] as const;
export type CircomKey = typeof REQUIRED_CIRCOM_KEYS[number];

export type FrontendConfig = Record<CircomKey, number>;

export interface SubcircuitLibraryData {
  setupParams: SetupParams;
  globalWireList: GlobalWireList;
  frontendCfg: FrontendConfig;
  subcircuitInfo: SubcircuitInfo;
}

export interface SubcircuitLibraryProvider {
  getData(): Promise<SubcircuitLibraryData>;
  loadWasm(subcircuitId: number): Promise<ArrayBuffer>;
}

export interface ResolvedSubcircuitLibrary {
  data: SubcircuitLibraryData;
  arithmeticSubcircuitComposition: ArithmeticSubcircuitComposition;
  subcircuitInfoByName: SubcircuitInfoByName;
  subcircuitBufferMapping: Record<ReservedBuffer, SubcircuitInfoByNameEntry | undefined>;
  accumulatorInputLimit: number;
  numberOfPrevBlockHashes: number;
  poseidonBatchSize: number;
  jubjubExpBatchSize: number;
  arithExpBatchSize: number;
  firstArithmeticPlacementIndex: number;
}
