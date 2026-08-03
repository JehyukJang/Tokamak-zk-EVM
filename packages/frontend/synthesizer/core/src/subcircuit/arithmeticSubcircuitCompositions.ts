import {
  ArithmeticOperator,
  SubcircuitNames,
} from './configuredTypes.ts';
import {
  ArithmeticSubcircuitComposition,
  CompositionStep,
  InputReference,
  OutputReference,
  SelectorDefinition,
} from './arithmeticSubcircuitComposition.ts';

export type ArithmeticSubcircuitCompositionConfig = Readonly<{
  accumulatorInputLimit: number;
  arithExpBatchSize: number;
  jubjubExpBatchSize: number;
  poseidonBatchSize: number;
}>;

export type ArithmeticSubcircuitCompositions = Readonly<
  Record<ArithmeticOperator, ArithmeticSubcircuitComposition>
>;

const selectorInput = (): InputReference => ({ kind: 'selector' });
const operandInput = (index: number): InputReference => ({ kind: 'operand', index });
const intermediateInput = (index: number): InputReference => ({ kind: 'step-output', index });
const intermediateOutput = (index: number): OutputReference => ({ kind: 'step-output', index });
const resultOutput = (index: number): OutputReference => ({ kind: 'result', index });

const range = <T>(length: number, create: (index: number) => T): T[] =>
  Array.from({ length }, (_, index) => create(index));

const usageFor = (
  operation: ArithmeticOperator,
  subcircuit: SubcircuitNames,
): ArithmeticOperator | SubcircuitNames => (
  subcircuit.startsWith('ALU') ? operation : subcircuit
);

const operationStep = (
  operation: ArithmeticOperator,
  subcircuit: SubcircuitNames,
  selector: SelectorDefinition,
  numOperands: number,
  numResults: number,
): CompositionStep => ({
  subcircuit,
  usage: usageFor(operation, subcircuit),
  selector,
  inputs: [
    ...(selector === null ? [] : [selectorInput()]),
    ...range(numOperands, operandInput),
  ],
  outputs: range(numResults, resultOutput),
});

const singleOperation = (
  operation: ArithmeticOperator,
  subcircuit: SubcircuitNames,
  selector: SelectorDefinition,
  numOperands: number,
  numResults: number,
): ArithmeticSubcircuitComposition => new ArithmeticSubcircuitComposition({
  numOperands,
  numResults,
  steps: [operationStep(operation, subcircuit, selector, numOperands, numResults)],
});

const checkedOperation = (
  operation: 'ADDMOD' | 'MULMOD',
  selector: bigint,
): ArithmeticSubcircuitComposition => new ArithmeticSubcircuitComposition({
  numOperands: 3,
  numResults: 1,
  steps: [
    {
      subcircuit: 'CheckBus256',
      usage: 'CheckBus256',
      selector: null,
      inputs: [operandInput(0)],
      outputs: [],
    },
    operationStep(operation, operation, selector, 3, 1),
  ],
});

const divisionOperation = (
  operation: 'DIV' | 'SDIV' | 'MOD' | 'SMOD',
  selector: bigint,
): ArithmeticSubcircuitComposition => new ArithmeticSubcircuitComposition({
  numOperands: 2,
  numResults: 1,
  steps: [
    {
      subcircuit: 'ALU4A',
      usage: operation,
      selector,
      inputs: [selectorInput(), operandInput(0), operandInput(1)],
      outputs: range(10, intermediateOutput),
    },
    {
      subcircuit: 'ALU4B',
      usage: operation,
      selector: null,
      inputs: range(10, intermediateInput),
      outputs: [resultOutput(0)],
    },
  ],
});

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`ArithmeticSubcircuitCompositions: ${name} must be a positive integer`);
  }
};

export const createArithmeticSubcircuitCompositions = (
  config: ArithmeticSubcircuitCompositionConfig,
): ArithmeticSubcircuitCompositions => {
  assertPositiveInteger(config.accumulatorInputLimit, 'accumulatorInputLimit');
  assertPositiveInteger(config.arithExpBatchSize, 'arithExpBatchSize');
  assertPositiveInteger(config.jubjubExpBatchSize, 'jubjubExpBatchSize');
  assertPositiveInteger(config.poseidonBatchSize, 'poseidonBatchSize');

  const compositions = {
    ADD: singleOperation('ADD', 'ALU1', 1n << 1n, 2, 1),
    MUL: singleOperation('MUL', 'ALU1', 1n << 2n, 2, 1),
    SUB: singleOperation('SUB', 'ALU1', 1n << 3n, 2, 1),
    DIV: divisionOperation('DIV', 1n << 4n),
    SDIV: divisionOperation('SDIV', 1n << 5n),
    MOD: divisionOperation('MOD', 1n << 6n),
    SMOD: divisionOperation('SMOD', 1n << 7n),
    ADDMOD: checkedOperation('ADDMOD', 1n << 8n),
    MULMOD: checkedOperation('MULMOD', 1n << 9n),
    EXP: singleOperation('EXP', 'ALU1', 1n << 10n, 2, 1),
    SIGNEXTEND: singleOperation('SIGNEXTEND', 'SIGNEXTEND', 1n << 11n, 2, 1),
    LT: singleOperation('LT', 'ALU2', 1n << 16n, 2, 1),
    GT: singleOperation('GT', 'ALU2', 1n << 17n, 2, 1),
    SLT: singleOperation('SLT', 'ALU3', 1n << 18n, 2, 1),
    SGT: singleOperation('SGT', 'ALU3', 1n << 19n, 2, 1),
    EQ: singleOperation('EQ', 'ALU1', 1n << 20n, 2, 1),
    ISZERO: singleOperation('ISZERO', 'ALU1', 1n << 21n, 1, 1),
    AND: singleOperation('AND', 'AND', 1n << 22n, 2, 1),
    OR: singleOperation('OR', 'OR', 1n << 23n, 2, 1),
    XOR: singleOperation('XOR', 'XOR', 1n << 24n, 2, 1),
    NOT: singleOperation('NOT', 'ALU1', 1n << 25n, 1, 1),
    BYTE: singleOperation('BYTE', 'BYTE', 1n << 26n, 2, 1),
    SHL: singleOperation('SHL', 'SHL', 1n << 27n, 2, 1),
    SHR: singleOperation('SHR', 'ALU6', 1n << 28n, 2, 1),
    SAR: singleOperation('SAR', 'ALU6', 1n << 29n, 2, 1),
    DecToBit: singleOperation('DecToBit', 'DecToBit', null, 1, 256),
    SubExpBatch: singleOperation(
      'SubExpBatch',
      'SubExpBatch',
      null,
      2 + config.arithExpBatchSize,
      2,
    ),
    Accumulator: singleOperation(
      'Accumulator',
      'Accumulator',
      null,
      config.accumulatorInputLimit,
      1,
    ),
    Poseidon: singleOperation(
      'Poseidon',
      'Poseidon',
      'dynamic',
      config.poseidonBatchSize + 1,
      1,
    ),
    JubjubExpBatch: singleOperation(
      'JubjubExpBatch',
      'JubjubExpBatch',
      null,
      4 + config.jubjubExpBatchSize,
      4,
    ),
    EdDsaVerify: singleOperation('EdDsaVerify', 'EdDsaVerify', null, 6, 0),
    EqualBatch: singleOperation('EqualBatch', 'EqualBatch', null, 4, 0),
  } as const satisfies Record<ArithmeticOperator, ArithmeticSubcircuitComposition>;

  for (const [operation, composition] of Object.entries(compositions)) {
    composition.assertUsage(operation as ArithmeticOperator);
  }

  return Object.freeze(compositions);
};
