import {
  assertPositiveInteger,
  freezeComposition,
} from '../utils.ts';
import type {
  PlacementCompositionManagerConfig,
  PlacementCompositionMapping,
  InputReference,
} from '../placementCompositionManager.ts';

export type PoseidonArithmeticMappingConfig = Pick<
  PlacementCompositionManagerConfig,
  'nPoseidonBatch'
>;

export const createPoseidonArithmeticMapping = (
  config: PoseidonArithmeticMappingConfig,
): PlacementCompositionMapping => {
  assertPositiveInteger(config.nPoseidonBatch, 'nPoseidonBatch');

  return Object.freeze({
    operation: 'Poseidon',
    composition: freezeComposition({
      placementStrategy: 'poseidon',
      constants: [],
      numSteps: 'dynamic',
      numOperands: config.nPoseidonBatch + 1,
      numResults: 1,
      steps: [{
        subcircuit: 'Poseidon',
        usage: 'Poseidon',
        selector: 'dynamic',
        inputs: [
          { kind: 'selector' },
          ...Array.from(
            { length: config.nPoseidonBatch + 1 },
            (_, index): InputReference => ({ kind: 'operand', index }),
          ),
        ],
        outputs: [{ kind: 'result', index: 0 }],
      }],
    }),
  });
};
