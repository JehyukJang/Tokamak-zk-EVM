import { freezeComposition } from '../utils.ts'
import type {
  PlacementCompositionMapping,
  CompositionStep,
  ConstantDefinition,
  InputReference,
  OutputReference
} from '../placementCompositionManager.ts'

const NUM_EXPONENT_BITS = 256

export const createExpCompositionMapping = (): PlacementCompositionMapping => {
  const constants: readonly ConstantDefinition[] = [
    {
      value: 1n,
      dataPtType: {
        valueDomain: { kind: 'uint', bits: 256 },
        wireLayout: { kind: 'limbs-128', count: 2 }
      }
    }
  ]
  const steps: CompositionStep[] = [
    {
      subcircuit: 'DecToBit',
      usage: 'DecToBit',
      selector: null,
      inputs: [{ kind: 'operand', index: 1 }],
      outputs: Array.from(
        { length: NUM_EXPONENT_BITS },
        (_, index): OutputReference => ({ kind: 'step-output', index })
      )
    }
  ]

  for (let bitIndex = 0; bitIndex < NUM_EXPONENT_BITS; bitIndex++) {
    const isFirstStep = bitIndex === 0
    const isFinalStep = bitIndex === NUM_EXPONENT_BITS - 1
    const stateInputs: InputReference[] = isFirstStep
      ? [
          { kind: 'constant', index: 0 },
          { kind: 'operand', index: 0 }
        ]
      : [
          { kind: 'step-output', index: NUM_EXPONENT_BITS + 2 * (bitIndex - 1) },
          { kind: 'step-output', index: NUM_EXPONENT_BITS + 2 * (bitIndex - 1) + 1 }
        ]
    const outputs: OutputReference[] = isFinalStep
      ? [{ kind: 'step-output', index: NUM_EXPONENT_BITS + 2 * bitIndex }, { kind: 'discard' }]
      : [
          { kind: 'step-output', index: NUM_EXPONENT_BITS + 2 * bitIndex },
          { kind: 'step-output', index: NUM_EXPONENT_BITS + 2 * bitIndex + 1 }
        ]

    steps.push({
      subcircuit: 'SubExp',
      usage: 'SubExp',
      selector: null,
      inputs: [...stateInputs, { kind: 'step-output', index: bitIndex }],
      outputs
    })
  }

  steps.push({
    subcircuit: 'CheckBus256',
    usage: 'CheckBus256',
    selector: null,
    inputs: [
      {
        kind: 'step-output',
        index: NUM_EXPONENT_BITS + 2 * (NUM_EXPONENT_BITS - 1)
      }
    ],
    outputs: [{ kind: 'result', index: 0 }]
  })

  return Object.freeze({
    operation: 'EXP',
    composition: freezeComposition({
      placementStrategy: 'generic',
      constants,
      numSteps: steps.length,
      numOperands: 2,
      numResults: 1,
      steps
    })
  })
}
