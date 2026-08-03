import { describe, expect, it } from 'vitest';

import {
  ArithmeticSubcircuitComposition,
  CompositionStep,
  InputReference,
  OutputReference,
} from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { createArithmeticSubcircuitCompositions } from '../../../core/src/subcircuit/arithmeticSubcircuitCompositions.ts';
import {
  ARITHMETIC_OPERATOR_LIST,
  ArithmeticOperator,
  SubcircuitNames,
} from '../../../core/src/subcircuit/configuredTypes.ts';

type MutableStep = {
  -readonly [Key in keyof CompositionStep]: Key extends 'inputs'
    ? InputReference[]
    : Key extends 'outputs'
      ? OutputReference[]
      : CompositionStep[Key];
};

type MutableDefinition = {
  numOperands: number;
  numResults: number;
  steps: MutableStep[];
};

const validDivisionDefinition = (): MutableDefinition => ({
  numOperands: 2,
  numResults: 1,
  steps: [
    {
      subcircuit: 'ALU4A' as SubcircuitNames,
      usage: 'DIV' as ArithmeticOperator,
      selector: 1n << 4n,
      inputs: [
        { kind: 'selector' },
        { kind: 'operand', index: 0 },
        { kind: 'operand', index: 1 },
      ],
      outputs: [{ kind: 'step-output', index: 0 }],
    },
    {
      subcircuit: 'ALU4B' as SubcircuitNames,
      usage: 'DIV' as ArithmeticOperator,
      selector: null,
      inputs: [{ kind: 'step-output', index: 0 }],
      outputs: [{ kind: 'result', index: 0 }],
    },
  ],
});

describe('ArithmeticSubcircuitComposition', () => {
  it('stores an immutable valid composition', () => {
    const definition = validDivisionDefinition();
    const composition = new ArithmeticSubcircuitComposition(definition);

    expect(composition.numOperands).toBe(2);
    expect(composition.numResults).toBe(1);
    expect(composition.steps).toHaveLength(2);
    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.steps)).toBe(true);
    expect(Object.isFrozen(composition.steps[0])).toBe(true);
    expect(Object.isFrozen(composition.steps[0].inputs)).toBe(true);
    expect(Object.isFrozen(composition.steps[0].inputs[0])).toBe(true);

    definition.steps[0].inputs[1] = { kind: 'operand', index: 1 };
    expect(composition.steps[0].inputs[1]).toEqual({ kind: 'operand', index: 0 });
  });

  it.each([
    ['numOperands', -1],
    ['numOperands', 1.5],
    ['numResults', -1],
    ['numResults', Number.NaN],
  ] as const)('rejects invalid %s', (property, value) => {
    expect(() => new ArithmeticSubcircuitComposition({
      ...validDivisionDefinition(),
      [property]: value,
    })).toThrow(`${property} must be a non-negative integer`);
  });

  it('requires at least one step', () => {
    expect(() => new ArithmeticSubcircuitComposition({
      numOperands: 0,
      numResults: 0,
      steps: [],
    })).toThrow('at least one step is required');
  });

  it('rejects a selector definition without exactly one selector input', () => {
    const definition = validDivisionDefinition();
    definition.steps[0].inputs.splice(0, 1);

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('selector input does not match its selector definition');
  });

  it('rejects a selector input on a selector-free step', () => {
    const definition = validDivisionDefinition();
    definition.steps[1].inputs.unshift({ kind: 'selector' });

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('selector input does not match its selector definition');
  });

  it('rejects an out-of-range operand', () => {
    const definition = validDivisionDefinition();
    definition.steps[0].inputs[1] = { kind: 'operand', index: 2 };

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('operand index is out of range');
  });

  it('rejects a forward or same-step intermediate reference', () => {
    const definition = validDivisionDefinition();
    definition.steps[0].inputs.push({ kind: 'step-output', index: 0 });

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('references an intermediate before it is produced');
  });

  it('rejects duplicate intermediate producers', () => {
    const definition = validDivisionDefinition();
    definition.steps[1].outputs.unshift({ kind: 'step-output', index: 0 });

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('intermediate 0 has multiple producers');
  });

  it('rejects duplicate result producers', () => {
    const definition = validDivisionDefinition();
    definition.steps[0].outputs.push({ kind: 'result', index: 0 });

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('result 0 has multiple producers');
  });

  it('rejects a missing result', () => {
    const definition = validDivisionDefinition();
    definition.steps[1].outputs = [];

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('result 0 is not produced');
  });

  it('rejects an unconsumed intermediate', () => {
    const definition = validDivisionDefinition();
    definition.steps[1].inputs = [];

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('intermediate 0 is never consumed');
  });

  it('rejects a gap in intermediate indices', () => {
    const definition = validDivisionDefinition();
    definition.steps[0].outputs[0] = { kind: 'step-output', index: 1 };
    definition.steps[1].inputs[0] = { kind: 'step-output', index: 1 };

    expect(() => new ArithmeticSubcircuitComposition(definition))
      .toThrow('intermediate indices must be contiguous');
  });

  it('accepts an explicit discarded output', () => {
    const composition = new ArithmeticSubcircuitComposition({
      numOperands: 1,
      numResults: 0,
      steps: [{
        subcircuit: 'EqualBatch',
        usage: 'EqualBatch',
        selector: null,
        inputs: [{ kind: 'operand', index: 0 }],
        outputs: [{ kind: 'discard' }],
      }],
    });

    expect(composition.steps[0].outputs).toEqual([{ kind: 'discard' }]);
  });

  it('validates the ALU and non-ALU usage policy', () => {
    const valid = new ArithmeticSubcircuitComposition(validDivisionDefinition());
    expect(() => valid.assertUsage('DIV')).not.toThrow();

    const invalidAluUsage = validDivisionDefinition();
    invalidAluUsage.steps[0].usage = 'ALU4A';
    expect(() => new ArithmeticSubcircuitComposition(invalidAluUsage).assertUsage('DIV'))
      .toThrow('step 0 usage must be DIV');

    const invalidNonAluUsage = new ArithmeticSubcircuitComposition({
      numOperands: 2,
      numResults: 1,
      steps: [{
        subcircuit: 'AND',
        usage: 'OR',
        selector: 1n << 22n,
        inputs: [
          { kind: 'selector' },
          { kind: 'operand', index: 0 },
          { kind: 'operand', index: 1 },
        ],
        outputs: [{ kind: 'result', index: 0 }],
      }],
    });
    expect(() => invalidNonAluUsage.assertUsage('AND'))
      .toThrow('step 0 usage must be AND');
  });
});

describe('arithmetic subcircuit composition registration', () => {
  const config = {
    accumulatorInputLimit: 32,
    arithExpBatchSize: 8,
    jubjubExpBatchSize: 37,
    poseidonBatchSize: 4,
  } as const;

  it('registers every arithmetic operator as an immutable class instance', () => {
    const compositions = createArithmeticSubcircuitCompositions(config);

    expect(Object.keys(compositions).sort()).toEqual([...ARITHMETIC_OPERATOR_LIST].sort());
    expect(Object.isFrozen(compositions)).toBe(true);
    for (const composition of Object.values(compositions)) {
      expect(composition).toBeInstanceOf(ArithmeticSubcircuitComposition);
      expect('outputGenerator' in composition).toBe(false);
    }
  });

  it('preserves every configured operation subcircuit and selector', () => {
    const compositions = createArithmeticSubcircuitCompositions(config);
    const expected = {
      ADD: ['ALU1', 1n << 1n],
      MUL: ['ALU1', 1n << 2n],
      SUB: ['ALU1', 1n << 3n],
      DIV: ['ALU4A', 1n << 4n],
      SDIV: ['ALU4A', 1n << 5n],
      MOD: ['ALU4A', 1n << 6n],
      SMOD: ['ALU4A', 1n << 7n],
      ADDMOD: ['ADDMOD', 1n << 8n],
      MULMOD: ['MULMOD', 1n << 9n],
      EXP: ['ALU1', 1n << 10n],
      SIGNEXTEND: ['SIGNEXTEND', 1n << 11n],
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
      DecToBit: ['DecToBit', null],
      SubExpBatch: ['SubExpBatch', null],
      Accumulator: ['Accumulator', null],
      Poseidon: ['Poseidon', 'dynamic'],
      JubjubExpBatch: ['JubjubExpBatch', null],
      EdDsaVerify: ['EdDsaVerify', null],
      EqualBatch: ['EqualBatch', null],
    } as const;

    for (const operation of ARITHMETIC_OPERATOR_LIST) {
      const step = compositions[operation].steps.find(({ usage }) => usage === operation);
      expect(step, operation).toBeDefined();
      expect([step!.subcircuit, step!.selector], operation).toEqual(expected[operation]);
    }
  });

  it('registers the mandatory modular and division compositions', () => {
    const compositions = createArithmeticSubcircuitCompositions(config);

    expect(compositions.ADDMOD.steps.map(({ subcircuit, usage }) => ({ subcircuit, usage })))
      .toEqual([
        { subcircuit: 'CheckBus256', usage: 'CheckBus256' },
        { subcircuit: 'ADDMOD', usage: 'ADDMOD' },
      ]);
    expect(compositions.DIV.steps.map(({ subcircuit, usage }) => ({ subcircuit, usage })))
      .toEqual([
        { subcircuit: 'ALU4A', usage: 'DIV' },
        { subcircuit: 'ALU4B', usage: 'DIV' },
      ]);
    expect(compositions.DIV.steps[0].outputs).toHaveLength(10);
    expect(compositions.DIV.steps[1].inputs).toHaveLength(10);
  });

  it('derives parameterized primitive arities from library configuration', () => {
    const compositions = createArithmeticSubcircuitCompositions(config);

    expect(compositions.SubExpBatch.numOperands).toBe(10);
    expect(compositions.Accumulator.numOperands).toBe(32);
    expect(compositions.Poseidon.numOperands).toBe(5);
    expect(compositions.Poseidon.steps[0].selector).toBe('dynamic');
    expect(compositions.JubjubExpBatch.numOperands).toBe(41);
  });

  it.each([
    'accumulatorInputLimit',
    'arithExpBatchSize',
    'jubjubExpBatchSize',
    'poseidonBatchSize',
  ] as const)('rejects an invalid %s', (property) => {
    expect(() => createArithmeticSubcircuitCompositions({
      ...config,
      [property]: 0,
    })).toThrow(`${property} must be a positive integer`);
  });
});
