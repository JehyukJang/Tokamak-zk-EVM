import { freezeComposition } from '../utils.ts'
import type {
  InputReference,
  PlacementCompositionMapping,
} from '../placementCompositionManager.ts'

/**
 * Defines one logical memory view reconstruction. The memory-load placement
 * strategy receives its fragment inputs from MemoryManager at placement time.
 */
export const createMemoryLoadCompositionMapping = (): PlacementCompositionMapping =>
  Object.freeze({
    operation: 'MemoryLoad',
    composition: freezeComposition({
      placementStrategy: 'memory-load',
      constants: [],
      numSteps: 'dynamic',
      numOperands: 'dynamic',
      numResults: 1,
      steps: [
        {
          subcircuit: 'MemoryLoadStep',
          usage: 'MemoryLoadStep',
          selector: null,
          inputs: Array.from(
            { length: 8 },
            (_, index): InputReference => ({ kind: 'operand', index }),
          ),
          outputs: [
            { kind: 'result', index: 0 },
            { kind: 'discard' },
          ]
        }
      ]
    })
  })
