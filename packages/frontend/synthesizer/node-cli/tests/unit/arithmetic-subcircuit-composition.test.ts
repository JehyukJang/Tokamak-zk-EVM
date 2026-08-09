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
    expect(composition.get('Poseidon').numOperands).toBe(7);
    expect(composition.get('EXP').numSteps).toBe(258);
  });

  it('rejects dynamic numSteps for the generic placement strategy', () => {
    expect(() => new ArithmeticSubcircuitComposition(replaceComposition('ADD', {
      ...composition.get('ADD'),
      numSteps: 'dynamic',
    }))).toThrow('ADD cannot use generic placement with dynamic numSteps or selectors');
  });

  it('rejects a dynamic selector for the generic placement strategy', () => {
    const addComposition = composition.get('ADD');
    expect(() => new ArithmeticSubcircuitComposition(replaceComposition('ADD', {
      ...addComposition,
      steps: [{
        ...addComposition.steps[0],
        selector: 'dynamic',
      }],
    }))).toThrow('ADD cannot use generic placement with dynamic numSteps or selectors');
  });

  it('allows a special placement strategy without dynamic fields', () => {
    const poseidonComposition = composition.get('Poseidon');
    expect(() => new ArithmeticSubcircuitComposition(replaceComposition('Poseidon', {
      ...poseidonComposition,
      numSteps: 1,
      steps: [{
        ...poseidonComposition.steps[0],
        selector: 1n,
      }],
    }))).not.toThrow();
  });
});
