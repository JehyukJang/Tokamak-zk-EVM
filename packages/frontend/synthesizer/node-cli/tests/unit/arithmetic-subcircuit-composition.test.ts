import { describe, expect, it } from 'vitest';

import {
  ARITHMETIC_OPERATOR_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';
import {
  ArithmeticSubcircuitComposition,
  createArithmeticSubcircuitComposition,
} from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';

const composition = createArithmeticSubcircuitComposition({
  nAccumulation: 4,
  nEqualBatch: 2,
  nJubjubExpBatch: 4,
  nPoseidonBatch: 6,
  nSubExpBatch: 8,
});

const replaceComposition = (
  operationToReplace: (typeof ARITHMETIC_OPERATOR_LIST)[number],
  replacement: ReturnType<typeof composition.get>,
) => ARITHMETIC_OPERATOR_LIST.map((operation) => ({
  operation,
  composition: operation === operationToReplace
    ? replacement
    : composition.get(operation),
}));

describe('arithmetic subcircuit composition assembly', () => {
  it('contains every arithmetic operation', () => {
    for (const operation of ARITHMETIC_OPERATOR_LIST) {
      const definition = composition.get(operation);
      expect(definition).toBeDefined();
      expect(definition.placementStrategy).toBe(
        operation === 'Poseidon' ? 'poseidon' : 'generic',
      );
    }
  });

  it('uses the loaded structural constants in parameterized mappings', () => {
    expect(composition.get('Accumulator').numOperands).toBe(4);
    expect(composition.get('EqualBatch').numOperands).toBe(4);
    expect(composition.get('JubjubExpBatch').numOperands).toBe(8);
    expect(composition.get('Poseidon').numOperands).toBe(7);
    expect(composition.get('SubExpBatch').numOperands).toBe(10);
    expect(composition.get('EXP').numSteps).toBe(33);
  });

  it('rejects dynamic numSteps for the generic placement strategy', () => {
    expect(() => new ArithmeticSubcircuitComposition(replaceComposition('ADD', {
      ...composition.get('ADD'),
      numSteps: 'dynamic',
    }))).toThrow('ADD must use numeric numSteps with generic placement');
  });

  it('rejects numeric numSteps for the Poseidon placement strategy', () => {
    expect(() => new ArithmeticSubcircuitComposition(replaceComposition('Poseidon', {
      ...composition.get('Poseidon'),
      numSteps: 1,
    }))).toThrow('Poseidon must use dynamic numSteps with Poseidon placement');
  });
});
