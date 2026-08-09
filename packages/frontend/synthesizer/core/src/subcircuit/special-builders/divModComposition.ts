import { freezeComposition } from '../utils.ts'
import type { PlacementCompositionMapping, InputReference, OutputReference } from '../placementCompositionManager.ts'

const createDivisionCompositionMapping = (
  operation: 'DIV' | 'SDIV' | 'MOD' | 'SMOD',
  selector: bigint
): PlacementCompositionMapping =>
  Object.freeze({
    operation,
    composition: freezeComposition({
      placementStrategy: 'generic',
      constants: [],
      numSteps: 2,
      numOperands: 2,
      numResults: 1,
      steps: [
        {
          subcircuit: 'ALU4A',
          usage: operation,
          selector,
          inputs: [{ kind: 'selector' }, { kind: 'operand', index: 0 }, { kind: 'operand', index: 1 }],
          outputs: Array.from({ length: 10 }, (_, index): OutputReference => ({ kind: 'step-output', index }))
        },
        {
          subcircuit: 'ALU4B',
          usage: operation,
          selector: null,
          inputs: Array.from({ length: 10 }, (_, index): InputReference => ({ kind: 'step-output', index })),
          outputs: [{ kind: 'result', index: 0 }]
        }
      ]
    })
  })

export const createDivisionCompositionMappings = (): readonly PlacementCompositionMapping[] =>
  Object.freeze([
    createDivisionCompositionMapping('DIV', 1n << 4n),
    createDivisionCompositionMapping('SDIV', 1n << 5n),
    createDivisionCompositionMapping('MOD', 1n << 6n),
    createDivisionCompositionMapping('SMOD', 1n << 7n)
  ])
