import { FUNCTION_INPUT_LENGTH } from 'tokamak-l2js';

export const ARITHMETIC_OPERATOR_LIST = [
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
  'CheckBus256',
  'DecToBit',
  // 'SubEXP',
  'SubExpBatch',
  'Accumulator',
  'Poseidon',
  // 'PrepareEdDsaScalars',
  'JubjubExpBatch',
  'EdDsaVerify',
  'EqualBatch',
] as const

export type ArithmeticOperator = (typeof ARITHMETIC_OPERATOR_LIST)[number]

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

export const SUBCIRCUIT_LIST = [
    'bufferLogOut',
    'bufferStorageStore',
    'bufferStorageLoad',
    'bufferTxIn',
    'bufferBlockIn',
    'bufferEVMIn',
    'bufferPrvIn',
    'ALU1',
    'ALU2',
    'ALU3',
    'AND',
    'OR',
    'XOR',
    'ALU4',
    'ALU5',
    'SIGNEXTEND',
    'BYTE',
    'SHL',
    'ALU6',
    'CheckBus256',
    'ADDMOD',
    'MULMOD',
    'DecToBit',
    'SubExpBatch',
    'Accumulator',
    'Poseidon',
    // 'PrepareEdDsaScalars',
    'JubjubExpBatch',
    'EdDsaVerify',
    'EqualBatch',
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
};

export type SubcircuitInfoByName = Map<
  SubcircuitNames,
  SubcircuitInfoByNameEntry
>;

export const SUBCIRCUIT_ALU_MAPPING: Record<ArithmeticOperator, [SubcircuitNames, bigint | undefined]> = {
  ADD: ['ALU1', 1n << 1n],
  MUL: ['ALU1', 1n << 2n],
  SUB: ['ALU1', 1n << 3n],
  DIV: ['ALU4', 1n << 4n],
  SDIV: ['ALU5', 1n << 5n],
  MOD: ['ALU4', 1n << 6n],
  SMOD: ['ALU5', 1n << 7n],
  ADDMOD: ['ADDMOD', 1n << 8n],
  MULMOD: ['MULMOD', 1n << 9n],
  // SubEXP: ['ALU1', 1n << 10n],
  SubExpBatch: ['SubExpBatch', undefined],
  SIGNEXTEND: ['SIGNEXTEND', 1n << 11n],
  CheckBus256: ['CheckBus256', undefined],
  LT: ['ALU2', 1n << 16n],
  GT: ['ALU2', 1n << 17n],
  SLT: ['ALU3', 1n << 18n],
  SGT: ['ALU3', 1n << 19n],
  EQ: ['ALU1', 1n << 20n],
  ISZERO: ['ALU1', 1n << 21n],
  AND: ['AND', 1n << 22n],
  OR: ['OR', 1n << 23n],
  XOR: ['XOR', 1n << 24n],
  NOT: ['ALU1', 1n << 25n],
  BYTE: ['BYTE', 1n << 26n],
  SHL: ['SHL', 1n << 27n],
  SHR: ['ALU6', 1n << 28n],
  SAR: ['ALU6', 1n << 29n],
  DecToBit: ['DecToBit', undefined],
  Accumulator: ['Accumulator', undefined],
  EXP: ['ALU1', 1n << 10n], // Not directly used. SubEXP is used instead.
  Poseidon: ['Poseidon', undefined],
  // PrepareEdDsaScalars: ['PrepareEdDsaScalars', undefined],
  EdDsaVerify: ['EdDsaVerify', undefined],
  JubjubExpBatch: ['JubjubExpBatch', undefined],
  EqualBatch: ['EqualBatch', undefined],
} as const;

export const TX_MESSAGE_TO_HASH = [
  'TRANSACTION_NONCE', 'CONTRACT_ADDRESS', 'FUNCTION_SELECTOR',
  ...TRANSACTION_INPUT_VARIABLES,
] as const;
