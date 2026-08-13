import { assertPositiveInteger, freezeComposition } from '../utils.ts'
import type {
  PlacementCompositionManagerConfig,
  PlacementCompositionMapping,
  InputReference
} from '../placementCompositionManager.ts'

export type PoseidonCompositionMappingConfig = Pick<PlacementCompositionManagerConfig, 'nPoseidonBatch'>

export const createPoseidonCompositionMapping = (
  config: PoseidonCompositionMappingConfig
): PlacementCompositionMapping => {
  assertPositiveInteger(config.nPoseidonBatch, 'nPoseidonBatch')

  return Object.freeze({
    operation: 'Poseidon',
    composition: freezeComposition({
      placementStrategy: 'poseidon',
      constants: [],
      numSteps: 'dynamic',
      numOperands: 'dynamic',
      numResults: 1,
      steps: [
        {
          subcircuit: 'Poseidon',
          selector: 'dynamic',
          inputs: [
            { kind: 'selector' },
            ...Array.from(
              { length: config.nPoseidonBatch + 1 },
              (_, index): InputReference => ({ kind: 'operand', index })
            )
          ],
          outputs: [{ kind: 'result', index: 0 }]
        }
      ]
    })
  })
}
