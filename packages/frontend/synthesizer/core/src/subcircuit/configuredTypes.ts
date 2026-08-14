import { FUNCTION_INPUT_LENGTH } from 'tokamak-l2js';
import type { LogicalInterface } from './libraryTypes.ts';

export const OPERATOR_LIST = [
  'ADD',
  'MUL',
  'SUB',
  'DIV',
  'SDIV',
  'MOD',
  'SMOD',
  'ADDMOD',
  'MULMOD',
  'EXP',
  'LT',
  'GT',
  'SLT',
  'SGT',
  'EQ',
  'ISZERO',
  'AND',
  'OR',
  'XOR',
  'NOT',
  'SHL',
  'SHR',
  'SAR',
  'BYTE',
  'SIGNEXTEND',
  // 'SubEXP',
  'Poseidon',
  // 'PrepareEdDsaScalars',
  'MemoryLoad',
  'MemoryStream',
  'StorageAccess',
  'TransactionSignatureVerify',
  'FrToLimbsPair',
] as const

export type Operator = (typeof OPERATOR_LIST)[number]

const TRANSACTION_INPUT_VARIABLES = [
  'TRANSACTION_INPUT0', 'TRANSACTION_INPUT1', 'TRANSACTION_INPUT2', 'TRANSACTION_INPUT3',
  'TRANSACTION_INPUT4', 'TRANSACTION_INPUT5', 'TRANSACTION_INPUT6', 'TRANSACTION_INPUT7',
  'TRANSACTION_INPUT8', 'TRANSACTION_INPUT9', 'TRANSACTION_INPUT10', 'TRANSACTION_INPUT11',
  'TRANSACTION_INPUT12', 'TRANSACTION_INPUT13', 'TRANSACTION_INPUT14', 'TRANSACTION_INPUT15',
  'TRANSACTION_INPUT16', 'TRANSACTION_INPUT17', 'TRANSACTION_INPUT18', 'TRANSACTION_INPUT19',
  'TRANSACTION_INPUT20', 'TRANSACTION_INPUT21', 'TRANSACTION_INPUT22', 'TRANSACTION_INPUT23',
  'TRANSACTION_INPUT24', 'TRANSACTION_INPUT25', 'TRANSACTION_INPUT26', 'TRANSACTION_INPUT27',
  'TRANSACTION_INPUT28',
] as const;

if (TRANSACTION_INPUT_VARIABLES.length !== FUNCTION_INPUT_LENGTH) {
  throw new Error('TRANSACTION_INPUT_VARIABLES length must match FUNCTION_INPUT_LENGTH');
}

export const BUFFER_LIST = [
    // Public output, private input
    'LOG_OUT',
    'STORAGE_STORE',
    'STORAGE_LOAD',
    // Private output, public input
    'TX_IN',
    'BLOCK_IN',         // Determined by channel opening
    'EVM_IN',        // Determined by contract and function selector
    // Private output, private input
    'PRIVATE_IN',
] as const

export const BUFFER_DESCRIPTION: Record<ReservedBuffer, string> = {
  LOG_OUT: '[Public output & Private input] Buffer to emit committed EVM logs',
  STORAGE_STORE: '[Public output & Private input] Buffer to emit final storage writes',
  STORAGE_LOAD: '[Public output & Private input] Buffer to emit initial storage reads',
  TX_IN: '[Private output & Public input] Buffer to load transaction input',
  BLOCK_IN: '[Private output & Public input] Buffer to load block input',
  EVM_IN: '[Private output & Public input] Buffer to load public static input such as ROM, environmental data, or ALU selectors',
  PRIVATE_IN: '[Private output & Private input] Buffer to load witness as private, such as initial storage and transaction data',
} as const

export type ReservedBuffer = (typeof BUFFER_LIST)[number]

export const COMPOSITION_SUBCIRCUIT_LIST = [
    'ALU1',
    'ALU2',
    'ALU3',
    'AND',
    'OR',
    'XOR',
    'ALU4A',
    'ALU4B',
    'SIGNEXTEND',
    'BYTE',
    'SHL',
    'ALU6',
    'ADDMODPrepare',
    'ADDMODVerify',
    'MULMODPrepare',
    'MULMODCandidate',
    'MULMODVerify',
    'DecToBit',
    'SubExp',
    'CheckBus256',
    'Poseidon',
    'MemoryLoadStep',
    'EqualBatch',
    'TransactionSignaturePoseidonBatch4',
    'TransactionSignaturePointPolicy',
    'TransactionSignatureFixedPrefix70',
    'TransactionSignatureChallengeVariablePrefix',
    'TransactionSignatureVariableBatch',
    'TransactionSignatureFinal',
    'FrToLimbsPair',
] as const

export type CompositionSubcircuit = (typeof COMPOSITION_SUBCIRCUIT_LIST)[number]

export const SUBCIRCUIT_LIST = [
    'bufferLogOut',
    'bufferStorageStore',
    'bufferStorageLoad',
    'bufferTxIn',
    'bufferBlockIn',
    'bufferEVMIn',
    'bufferPrvIn',
    ...COMPOSITION_SUBCIRCUIT_LIST,
] as const

export type SubcircuitNames = typeof SUBCIRCUIT_LIST[number]

export type SubcircuitInfoByNameEntry = {
  name: SubcircuitNames;
  id: number;
  NWires: number;
  inWireIndex: number;
  NInWires: number;
  outWireIndex: number;
  NOutWires: number;
  flattenMap: number[];
  logicalInterface?: LogicalInterface;
};

export type SubcircuitInfoByName = Map<
  SubcircuitNames,
  SubcircuitInfoByNameEntry
>;

export const TX_MESSAGE_TO_HASH = [
  'TRANSACTION_NONCE', 'CONTRACT_ADDRESS', 'FUNCTION_SELECTOR',
  ...TRANSACTION_INPUT_VARIABLES,
] as const;
