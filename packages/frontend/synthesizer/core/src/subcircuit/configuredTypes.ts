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
    'ALU4A',
    'ALU4B',
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

export type SubcircuitPlacementDefinition = Readonly<{
  subcircuit: SubcircuitNames;
  inputWires: number;
  outputWires: number;
}>;

export type SingleOperationDefinition = Readonly<{
  kind: 'single';
  selector: bigint | undefined;
  selectorPlacement: 0;
  placements: readonly [SubcircuitPlacementDefinition];
  result: Readonly<{
    kind: 'all-outputs';
    placement: 0;
  }>;
}>;

export type CheckedOperationDefinition = Readonly<{
  kind: 'checked-operation';
  selector: bigint;
  selectorPlacement: 1;
  placements: readonly [SubcircuitPlacementDefinition, SubcircuitPlacementDefinition];
  sharedInputs: readonly [Readonly<{
    operand: 0;
    bitSize: 256;
    consumers: readonly [
      Readonly<{ placement: 0; input: 0 }>,
      Readonly<{ placement: 1; input: 1 }>,
    ];
  }>];
  result: Readonly<{
    kind: 'output';
    placement: 1;
    output: 0;
    bitSize: 256;
  }>;
}>;

export type DivisionBridgeName =
  | 'absDividend'
  | 'absQuotient'
  | 'absRemainder'
  | 'absDivisorWord0'
  | 'absDivisorWord1'
  | 'absDivisorWord2'
  | 'absDivisorWord3'
  | 'divisorIsZero'
  | 'resultIsNegative'
  | 'useMod';

export type DivisionFamilyOperationDefinition = Readonly<{
  kind: 'division-family';
  selector: bigint;
  selectorPlacement: 0;
  placements: readonly [SubcircuitPlacementDefinition, SubcircuitPlacementDefinition];
  operands: readonly [
    Readonly<{ operand: 0; placement: 0; input: 1; bitSize: 256 }>,
    Readonly<{ operand: 1; placement: 0; input: 2; bitSize: 256 }>,
  ];
  bridge: readonly Readonly<{
    name: DivisionBridgeName;
    producer: Readonly<{ placement: 0; output: number }>;
    consumer: Readonly<{ placement: 1; input: number }>;
    bitSize: 1 | 64 | 256;
  }>[];
  result: Readonly<{
    kind: 'output';
    placement: 1;
    output: 0;
    bitSize: 256;
  }>;
}>;

export type ArithmeticOperationDefinition =
  | SingleOperationDefinition
  | CheckedOperationDefinition
  | DivisionFamilyOperationDefinition;

const singleOperation = (
  subcircuit: SubcircuitNames,
  selector: bigint | undefined,
  inputWires: number,
  outputWires: number,
): SingleOperationDefinition => ({
  kind: 'single',
  selector,
  selectorPlacement: 0,
  placements: [{ subcircuit, inputWires, outputWires }],
  result: { kind: 'all-outputs', placement: 0 },
});

const checkedOperation = (
  subcircuit: 'ADDMOD' | 'MULMOD',
  selector: bigint,
): CheckedOperationDefinition => ({
  kind: 'checked-operation',
  selector,
  selectorPlacement: 1,
  placements: [
    { subcircuit: 'CheckBus256', inputWires: 2, outputWires: 0 },
    { subcircuit, inputWires: 7, outputWires: 2 },
  ],
  sharedInputs: [{
    operand: 0,
    bitSize: 256,
    consumers: [
      { placement: 0, input: 0 },
      { placement: 1, input: 1 },
    ],
  }],
  result: { kind: 'output', placement: 1, output: 0, bitSize: 256 },
});

const DIVISION_BRIDGE = [
  ['absDividend', 256],
  ['absQuotient', 256],
  ['absRemainder', 256],
  ['absDivisorWord0', 64],
  ['absDivisorWord1', 64],
  ['absDivisorWord2', 64],
  ['absDivisorWord3', 64],
  ['divisorIsZero', 1],
  ['resultIsNegative', 1],
  ['useMod', 1],
] as const satisfies readonly (readonly [DivisionBridgeName, 1 | 64 | 256])[];

const divisionFamilyOperation = (
  selector: bigint,
): DivisionFamilyOperationDefinition => ({
  kind: 'division-family',
  selector,
  selectorPlacement: 0,
  placements: [
    { subcircuit: 'ALU4A', inputWires: 5, outputWires: 13 },
    { subcircuit: 'ALU4B', inputWires: 13, outputWires: 2 },
  ],
  operands: [
    { operand: 0, placement: 0, input: 1, bitSize: 256 },
    { operand: 1, placement: 0, input: 2, bitSize: 256 },
  ],
  bridge: DIVISION_BRIDGE.map(([name, bitSize], index) => ({
    name,
    producer: { placement: 0, output: index },
    consumer: { placement: 1, input: index },
    bitSize,
  })),
  result: { kind: 'output', placement: 1, output: 0, bitSize: 256 },
});

export const ARITHMETIC_OPERATION_DEFINITIONS = {
  ADD: singleOperation('ALU1', 1n << 1n, 5, 2),
  MUL: singleOperation('ALU1', 1n << 2n, 5, 2),
  SUB: singleOperation('ALU1', 1n << 3n, 5, 2),
  DIV: divisionFamilyOperation(1n << 4n),
  SDIV: divisionFamilyOperation(1n << 5n),
  MOD: divisionFamilyOperation(1n << 6n),
  SMOD: divisionFamilyOperation(1n << 7n),
  ADDMOD: checkedOperation('ADDMOD', 1n << 8n),
  MULMOD: checkedOperation('MULMOD', 1n << 9n),
  EXP: singleOperation('ALU1', 1n << 10n, 5, 2), // Not directly used. SubExpBatch is used instead.
  SIGNEXTEND: singleOperation('SIGNEXTEND', 1n << 11n, 5, 2),
  LT: singleOperation('ALU2', 1n << 16n, 5, 2),
  GT: singleOperation('ALU2', 1n << 17n, 5, 2),
  SLT: singleOperation('ALU3', 1n << 18n, 5, 2),
  SGT: singleOperation('ALU3', 1n << 19n, 5, 2),
  EQ: singleOperation('ALU1', 1n << 20n, 5, 2),
  ISZERO: singleOperation('ALU1', 1n << 21n, 5, 2),
  AND: singleOperation('AND', 1n << 22n, 5, 2),
  OR: singleOperation('OR', 1n << 23n, 5, 2),
  XOR: singleOperation('XOR', 1n << 24n, 5, 2),
  NOT: singleOperation('ALU1', 1n << 25n, 5, 2),
  BYTE: singleOperation('BYTE', 1n << 26n, 5, 2),
  SHL: singleOperation('SHL', 1n << 27n, 5, 2),
  SHR: singleOperation('ALU6', 1n << 28n, 5, 2),
  SAR: singleOperation('ALU6', 1n << 29n, 5, 2),
  DecToBit: singleOperation('DecToBit', undefined, 2, 256),
  SubExpBatch: singleOperation('SubExpBatch', undefined, 12, 4),
  Accumulator: singleOperation('Accumulator', undefined, 64, 2),
  Poseidon: singleOperation('Poseidon', undefined, 5, 2),
  JubjubExpBatch: singleOperation('JubjubExpBatch', undefined, 45, 8),
  EdDsaVerify: singleOperation('EdDsaVerify', undefined, 12, 0),
  EqualBatch: singleOperation('EqualBatch', undefined, 8, 0),
} as const satisfies Record<ArithmeticOperator, ArithmeticOperationDefinition>;

export const TX_MESSAGE_TO_HASH = [
  'TRANSACTION_NONCE', 'CONTRACT_ADDRESS', 'FUNCTION_SELECTOR',
  ...TRANSACTION_INPUT_VARIABLES,
] as const;
