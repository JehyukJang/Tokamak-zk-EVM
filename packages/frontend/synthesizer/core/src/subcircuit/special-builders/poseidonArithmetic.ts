import type { FrontendConfig } from '../libraryTypes.ts';
import {
  assertPositiveInteger,
  freezeComposition,
  type ArithmeticSubcircuitMapping,
  type InputReference,
} from '../arithmeticSubcircuitComposition.ts';

export type PoseidonArithmeticMappingConfig = Pick<
  FrontendConfig,
  'nPoseidonBatch'
>;

export const createPoseidonArithmeticMapping = (
  config: PoseidonArithmeticMappingConfig,
): ArithmeticSubcircuitMapping => {
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
