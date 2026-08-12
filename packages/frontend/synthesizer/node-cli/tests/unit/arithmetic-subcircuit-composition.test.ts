import { describe, expect, it } from 'vitest';

import {
  OPERATOR_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';
import {
  PlacementCompositionManager,
  createPlacementCompositionManager,
} from '../../../core/src/subcircuit/placementCompositionManager.ts';

const composition = createPlacementCompositionManager({
  nEqualBatch: 2,
  nPoseidonBatch: 6,
});

const replaceComposition = (
  operationToReplace: (typeof OPERATOR_LIST)[number],
  replacement: ReturnType<typeof composition.get>,
) => OPERATOR_LIST.map((operation) => ({
  operation,
  composition: operation === operationToReplace
    ? replacement
    : composition.get(operation),
}));

describe('placement composition assembly', () => {
  it('contains every configured operator', () => {
    for (const operation of OPERATOR_LIST) {
      const definition = composition.get(operation);
      expect(definition).toBeDefined();
      expect(definition.placementStrategy).toBe(
        operation === 'Poseidon'
          ? 'poseidon'
          : operation === 'MemoryLoad'
            ? 'memory-load'
            : 'generic',
      );
    }
  });

  it('uses the loaded structural constants in parameterized mappings', () => {
    expect(composition.get('StorageAccess').numOperands).toBe(4);
    expect(composition.get('Poseidon').numOperands).toBe('dynamic');
    expect(composition.get('EXP').numSteps).toBe(258);
  });

  it('rejects dynamic numSteps for the generic placement strategy', () => {
    expect(() => new PlacementCompositionManager(replaceComposition('ADD', {
      ...composition.get('ADD'),
      numSteps: 'dynamic',
    }))).toThrow('ADD cannot use generic placement with dynamic numSteps or selectors');
  });

  it('rejects a dynamic selector for the generic placement strategy', () => {
    const addComposition = composition.get('ADD');
    expect(() => new PlacementCompositionManager(replaceComposition('ADD', {
      ...addComposition,
      steps: [{
        ...addComposition.steps[0],
        selector: 'dynamic',
      }],
    }))).toThrow('ADD cannot use generic placement with dynamic numSteps or selectors');
  });

  it('allows a special placement strategy with fixed declared steps', () => {
    const poseidonComposition = composition.get('Poseidon');
    expect(() => new PlacementCompositionManager(replaceComposition('Poseidon', {
      ...poseidonComposition,
      numSteps: 1,
      steps: [{
        ...poseidonComposition.steps[0],
        selector: 1n,
      }],
    }))).not.toThrow();
  });
});
