import { describe, expect, it } from 'vitest';

import {
  OPERATOR_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';
import {
  createPlacementCompositionMapping,
} from '../../../core/src/subcircuit/placementCompositionMapping.ts';

const mapping = createPlacementCompositionMapping({
  nPrivateMessageInputs: 29,
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
          : operation === 'MemoryView'
            ? 'memory-view'
            : 'generic',
      );
    }
  });

  it('uses the loaded structural constants in parameterized mappings', () => {
    expect(mapping.StorageAccess.numOperands).toBe(4);
    expect(mapping.Poseidon.numOperands).toBe('dynamic');
    expect(mapping.EXP.numSteps).toBe(258);
  });

  it('maps selector-free operations directly and declares only required input checks', () => {
    const directMappings = {
      ADD: { subcircuit: 'ADD', checked: [0, 1] },
      MUL: { subcircuit: 'MUL', checked: [] },
      SUB: { subcircuit: 'SUB', checked: [0, 1] },
      NOT: { subcircuit: 'NOT', checked: [] },
      EQ: { subcircuit: 'EQ', checked: [] },
      ISZERO: { subcircuit: 'ISZERO', checked: [] },
      LT: { subcircuit: 'LT', checked: [0, 1] },
      GT: { subcircuit: 'GT', checked: [0, 1] },
      SLT: { subcircuit: 'SLT', checked: [0, 1] },
      SGT: { subcircuit: 'SGT', checked: [0, 1] },
      AND: { subcircuit: 'AND', checked: [] },
      OR: { subcircuit: 'OR', checked: [] },
      XOR: { subcircuit: 'XOR', checked: [] },
      SHR: { subcircuit: 'SHR', checked: [0] },
    } as const;

    for (const [operation, expected] of Object.entries(directMappings)) {
      const composition = mapping[operation as keyof typeof directMappings];
      expect(composition.steps).toHaveLength(1);
      expect(composition.steps[0]!.subcircuit).toBe(expected.subcircuit);
      expect(composition.steps[0]!.selector).toBeNull();
      expect(composition.externalCheckRequiredOperandIndices).toEqual(expected.checked);
    }
  });

  it('rejects a non-positive Poseidon batch size', () => {
    expect(() => createPlacementCompositionMapping({
      nPrivateMessageInputs: 29,
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
