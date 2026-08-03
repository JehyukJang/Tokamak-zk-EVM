import { describe, expect, it } from 'vitest';

import {
  ARITHMETIC_OPERATOR_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';
import {
  createArithmeticSubcircuitComposition,
} from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';

const composition = createArithmeticSubcircuitComposition({
  nAccumulation: 4,
  nEqualBatch: 2,
  nJubjubExpBatch: 4,
  nPoseidonBatch: 6,
  nSubExpBatch: 8,
});

describe('arithmetic subcircuit composition assembly', () => {
  it('contains every arithmetic operation', () => {
    for (const operation of ARITHMETIC_OPERATOR_LIST) {
      expect(composition.get(operation)).toBeDefined();
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
});
