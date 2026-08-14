import { freezeComposition } from '../utils.ts'
import type {
  InputReference,
  PlacementCompositionEntry,
} from '../placementCompositionMapping.ts'

/**
 * Defines one logical memory view reconstruction. The memory-load placement
 * strategy receives its fragment inputs from InstructionHandler at placement time.
 */
const createMemoryCompositionMapping = (
  operation: 'MemoryLoad' | 'MemoryStream',
): PlacementCompositionEntry =>
  Object.freeze({
    operation,
    composition: freezeComposition({
      placementStrategy: operation === 'MemoryLoad' ? 'memory-load' : 'memory-stream',
      constants: [],
      numSteps: 'dynamic',
      numOperands: 'dynamic',
      numResults: operation === 'MemoryLoad' ? 1 : 'dynamic',
      steps: [
        {
          subcircuit: 'MemoryLoadStep',
          selector: null,
          inputs: Array.from(
            { length: 7 },
            (_, index): InputReference => ({ kind: 'operand', index }),
          ),
          outputs: [
            { kind: 'result', index: operation === 'MemoryLoad' ? 0 : 'dynamic' },
            { kind: 'discard' },
          ]
        }
      ]
    })
  })

export const createMemoryLoadCompositionMappings = (): readonly PlacementCompositionEntry[] =>
  Object.freeze([
    createMemoryCompositionMapping('MemoryLoad'),
    createMemoryCompositionMapping('MemoryStream'),
  ])
