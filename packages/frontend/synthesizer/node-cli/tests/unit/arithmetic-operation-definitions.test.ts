import { describe, expect, it } from 'vitest';

import {
  ARITHMETIC_OPERATION_DEFINITIONS,
  ARITHMETIC_OPERATOR_LIST,
  ArithmeticOperator,
  SUBCIRCUIT_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';

const SINGLE_OPERATIONS = {
  ADD: ['ALU1', 5, 2],
  MUL: ['ALU1', 5, 2],
  SUB: ['ALU1', 5, 2],
  EXP: ['ALU1', 5, 2],
  LT: ['ALU2', 5, 2],
  GT: ['ALU2', 5, 2],
  SLT: ['ALU3', 5, 2],
  SGT: ['ALU3', 5, 2],
  EQ: ['ALU1', 5, 2],
  ISZERO: ['ALU1', 5, 2],
  AND: ['AND', 5, 2],
  OR: ['OR', 5, 2],
  XOR: ['XOR', 5, 2],
  NOT: ['ALU1', 5, 2],
  SHL: ['SHL', 5, 2],
  SHR: ['ALU6', 5, 2],
  SAR: ['ALU6', 5, 2],
  BYTE: ['BYTE', 5, 2],
  SIGNEXTEND: ['SIGNEXTEND', 5, 2],
  DecToBit: ['DecToBit', 2, 256],
  SubExpBatch: ['SubExpBatch', 12, 4],
  Accumulator: ['Accumulator', 64, 2],
  Poseidon: ['Poseidon', 5, 2],
  JubjubExpBatch: ['JubjubExpBatch', 45, 8],
  EdDsaVerify: ['EdDsaVerify', 12, 0],
  EqualBatch: ['EqualBatch', 8, 0],
} as const;

const SELECTOR_BITS: Partial<Record<ArithmeticOperator, number>> = {
  ADD: 1,
  MUL: 2,
  SUB: 3,
  DIV: 4,
  SDIV: 5,
  MOD: 6,
  SMOD: 7,
  ADDMOD: 8,
  MULMOD: 9,
  EXP: 10,
  SIGNEXTEND: 11,
  LT: 16,
  GT: 17,
  SLT: 18,
  SGT: 19,
  EQ: 20,
  ISZERO: 21,
  AND: 22,
  OR: 23,
  XOR: 24,
  NOT: 25,
  BYTE: 26,
  SHL: 27,
  SHR: 28,
  SAR: 29,
};

describe('arithmetic operation definitions', () => {
  it('defines every configured arithmetic operation and only configured operations', () => {
    expect(Object.keys(ARITHMETIC_OPERATION_DEFINITIONS).sort())
      .toEqual([...ARITHMETIC_OPERATOR_LIST].sort());
  });

  it('preserves every selector value', () => {
    for (const operation of ARITHMETIC_OPERATOR_LIST) {
      const selectorBit = SELECTOR_BITS[operation];
      const expected = selectorBit === undefined ? undefined : 1n << BigInt(selectorBit);
      expect(ARITHMETIC_OPERATION_DEFINITIONS[operation].selector).toBe(expected);
    }
  });

  it('describes every one-placement operation and its current physical interface', () => {
    for (const [operation, [subcircuit, inputWires, outputWires]] of Object.entries(SINGLE_OPERATIONS)) {
      const definition = ARITHMETIC_OPERATION_DEFINITIONS[operation as keyof typeof SINGLE_OPERATIONS];
      expect(definition.kind).toBe('single');
      expect(definition.selectorPlacement).toBe(0);
      expect(definition.placements).toEqual([{ subcircuit, inputWires, outputWires }]);
      expect(definition.result).toEqual({ kind: 'all-outputs', placement: 0 });
    }
  });

  it.each([
    ['ADDMOD', 8],
    ['MULMOD', 9],
  ] as const)('describes the mandatory CheckBus256 pair for %s', (operation, selectorBit) => {
    expect(ARITHMETIC_OPERATION_DEFINITIONS[operation]).toEqual({
      kind: 'checked-operation',
      selector: 1n << BigInt(selectorBit),
      selectorPlacement: 1,
      placements: [
        { subcircuit: 'CheckBus256', inputWires: 2, outputWires: 0 },
        { subcircuit: operation, inputWires: 7, outputWires: 2 },
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
  });

  it.each([
    ['DIV', 4],
    ['SDIV', 5],
    ['MOD', 6],
    ['SMOD', 7],
  ] as const)('describes the exact ALU4A-to-ALU4B contract for %s', (operation, selectorBit) => {
    const definition = ARITHMETIC_OPERATION_DEFINITIONS[operation];
    expect(definition.kind).toBe('division-family');
    expect(definition.selector).toBe(1n << BigInt(selectorBit));
    expect(definition.selectorPlacement).toBe(0);
    expect(definition.placements).toEqual([
      { subcircuit: 'ALU4A', inputWires: 5, outputWires: 13 },
      { subcircuit: 'ALU4B', inputWires: 13, outputWires: 2 },
    ]);
    expect(definition.operands).toEqual([
      { operand: 0, placement: 0, input: 1, bitSize: 256 },
      { operand: 1, placement: 0, input: 2, bitSize: 256 },
    ]);
    expect(definition.bridge).toEqual([
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
    ].map(([name, bitSize], index) => ({
      name,
      producer: { placement: 0, output: index },
      consumer: { placement: 1, input: index },
      bitSize,
    })));
    expect(definition.bridge.reduce(
      (wireCount, edge) => wireCount + (edge.bitSize > 128 ? 2 : 1),
      0,
    )).toBe(13);
    expect(definition.result).toEqual({
      kind: 'output',
      placement: 1,
      output: 0,
      bitSize: 256,
    });
  });

  it('references only configured subcircuits', () => {
    const configured = new Set<string>(SUBCIRCUIT_LIST);
    for (const definition of Object.values(ARITHMETIC_OPERATION_DEFINITIONS)) {
      for (const placement of definition.placements) {
        expect(configured.has(placement.subcircuit)).toBe(true);
      }
    }
  });
});
