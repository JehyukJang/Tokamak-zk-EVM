import { describe, expect, it } from 'vitest';

import {
  OPERATOR_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';
import {
  createPlacementCompositionMapping,
} from '../../../core/src/subcircuit/placementCompositionMapping.ts';

const mapping = createPlacementCompositionMapping({
  nEqualBatch: 2,
  nPoseidonBatch: 6,
});

describe('placement composition assembly', () => {
  it('contains every configured operator', () => {
    for (const operation of OPERATOR_LIST) {
      const definition = mapping[operation];
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
    expect(mapping.StorageAccess.numOperands).toBe(4);
    expect(mapping.Poseidon.numOperands).toBe('dynamic');
    expect(mapping.EXP.numSteps).toBe(258);
  });

  it('rejects a non-positive EqualBatch size', () => {
    expect(() => createPlacementCompositionMapping({
      nEqualBatch: 0,
      nPoseidonBatch: 6,
    })).toThrow('nEqualBatch must be a positive integer');
  });

  it('rejects a non-positive Poseidon batch size', () => {
    expect(() => createPlacementCompositionMapping({
      nEqualBatch: 2,
      nPoseidonBatch: 0,
    })).toThrow('nPoseidonBatch must be a positive integer');
  });

  it('freezes the mapping and every composition definition', () => {
    expect(Object.isFrozen(mapping)).toBe(true);
    for (const operation of OPERATOR_LIST) {
      expect(Object.isFrozen(mapping[operation])).toBe(true);
    }
  });

  it('does not retain usage metadata on composition steps', () => {
    for (const operation of OPERATOR_LIST) {
      for (const step of mapping[operation].steps) {
        expect(step).not.toHaveProperty('usage');
      }
    }
  });
});
