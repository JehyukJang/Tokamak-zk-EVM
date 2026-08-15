import { freezeComposition } from '../utils.ts'
import {
  BIT_DATA_PT_TYPE,
  BLS12_381_FR_DATA_PT_TYPE,
} from '../../synthesizer/types/dataStructure.ts'
import type {
  CompositionStep,
  InputReference,
  OutputReference,
  PlacementCompositionEntry,
} from '../placementCompositionMapping.ts'

const NUM_CHAIN_POSEIDON_BATCHES = 8
const NUM_VARIABLE_BATCHES = 3
const NUM_RUNTIME_TABLE_COORDINATES = 8
const NUM_EXTENDED_COORDINATES = 4
const NUM_REMAINING_RESPONSE_BITS = 42
const NUM_REMAINING_CHALLENGE_BITS = 222
const NUM_VARIABLE_BATCH_BITS = 68

const challengeInput = (
  index: number,
  contractOperandIndex: number,
  selectorOperandIndex: number,
): InputReference => {
  if (index < 5) {
    return { kind: 'operand', index }
  }
  if (index === 5) {
    return { kind: 'operand', index: contractOperandIndex }
  }
  if (index === 6) {
    return { kind: 'operand', index: selectorOperandIndex }
  }
  return { kind: 'operand', index: index - 2 }
}

export const createTransactionSignatureVerifyCompositionMapping = (
  numberOfPrivateMessageInputs: number,
): PlacementCompositionEntry => {
  const contractOperandIndex = numberOfPrivateMessageInputs + 5
  const selectorOperandIndex = contractOperandIndex + 1
  const responseOperandIndex = selectorOperandIndex + 1
  const identityXOperandIndex = responseOperandIndex + 1
  const identityYOperandIndex = identityXOperandIndex + 1
  const numberOfOperands = identityYOperandIndex + 1
  const steps: CompositionStep[] = []
  let nextIntermediateIndex = 0
  const allocateIntermediate = (): number => nextIntermediateIndex++
  const allocateIntermediates = (length: number): number[] =>
    Array.from({ length }, () => allocateIntermediate())

  const chainModeConstantIndex = 0
  const zeroFieldConstantIndex = 1
  const independentModeConstantIndex = 2

  let previousChallengeHashIndex: number | undefined
  for (let batch = 0; batch < NUM_CHAIN_POSEIDON_BATCHES; batch++) {
    const finalHashIndex = allocateIntermediate()
    const challengeOffset = 4 * batch
    steps.push({
      subcircuit: 'TransactionSignaturePoseidonBatch4',
      selector: null,
      inputs: [
        { kind: 'constant', index: chainModeConstantIndex },
        previousChallengeHashIndex === undefined
          ? challengeInput(0, contractOperandIndex, selectorOperandIndex)
          : { kind: 'step-output', index: previousChallengeHashIndex },
        challengeInput(challengeOffset + 1, contractOperandIndex, selectorOperandIndex),
        { kind: 'constant', index: zeroFieldConstantIndex },
        challengeInput(challengeOffset + 2, contractOperandIndex, selectorOperandIndex),
        challengeInput(challengeOffset + 3, contractOperandIndex, selectorOperandIndex),
        challengeInput(challengeOffset + 4, contractOperandIndex, selectorOperandIndex),
      ],
      outputs: [
        { kind: 'discard' },
        { kind: 'step-output', index: finalHashIndex },
      ],
    })
    previousChallengeHashIndex = finalHashIndex
  }

  if (previousChallengeHashIndex === undefined) {
    throw new Error('TransactionSignatureVerify requires a challenge hash chain')
  }

  const publicKeyHashIndex = allocateIntermediate()
  const challengeHashIndex = allocateIntermediate()
  steps.push({
    subcircuit: 'TransactionSignaturePoseidonBatch4',
    selector: null,
    inputs: [
      { kind: 'constant', index: independentModeConstantIndex },
      challengeInput(2, contractOperandIndex, selectorOperandIndex),
      challengeInput(3, contractOperandIndex, selectorOperandIndex),
      { kind: 'step-output', index: previousChallengeHashIndex },
      challengeInput(33, contractOperandIndex, selectorOperandIndex),
      challengeInput(34, contractOperandIndex, selectorOperandIndex),
      challengeInput(35, contractOperandIndex, selectorOperandIndex),
    ],
    outputs: [
      { kind: 'step-output', index: publicKeyHashIndex },
      { kind: 'step-output', index: challengeHashIndex },
    ],
  })

  const runtimeTableIndices = allocateIntermediates(NUM_RUNTIME_TABLE_COORDINATES)
  const randomizerCofactorIndices = allocateIntermediates(NUM_EXTENDED_COORDINATES)
  steps.push({
    subcircuit: 'TransactionSignaturePointPolicy',
    selector: null,
    inputs: [
      challengeInput(0, contractOperandIndex, selectorOperandIndex),
      challengeInput(1, contractOperandIndex, selectorOperandIndex),
      challengeInput(2, contractOperandIndex, selectorOperandIndex),
      challengeInput(3, contractOperandIndex, selectorOperandIndex),
      { kind: 'operand', index: contractOperandIndex },
      { kind: 'operand', index: selectorOperandIndex },
      { kind: 'operand', index: identityXOperandIndex },
      { kind: 'operand', index: identityYOperandIndex },
    ],
    outputs: [
      { kind: 'result', index: 0 },
      { kind: 'result', index: 1 },
      { kind: 'result', index: 2 },
      ...runtimeTableIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
      ...randomizerCofactorIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
    ],
  })

  const remainingResponseBitIndices = allocateIntermediates(NUM_REMAINING_RESPONSE_BITS)
  const fixedAccumulatorIndices = allocateIntermediates(NUM_EXTENDED_COORDINATES)
  steps.push({
    subcircuit: 'TransactionSignatureFixedPrefix70',
    selector: null,
    inputs: [{ kind: 'operand', index: responseOperandIndex }],
    outputs: [
      ...remainingResponseBitIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
      ...fixedAccumulatorIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
    ],
  })

  const remainingChallengeBitIndices = allocateIntermediates(NUM_REMAINING_CHALLENGE_BITS)
  const initialVariableAccumulatorIndices = allocateIntermediates(NUM_EXTENDED_COORDINATES)
  steps.push({
    subcircuit: 'TransactionSignatureChallengeVariablePrefix',
    selector: null,
    inputs: [
      { kind: 'step-output', index: challengeHashIndex },
      ...runtimeTableIndices.map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
    ],
    outputs: [
      ...remainingChallengeBitIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
      ...initialVariableAccumulatorIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
    ],
  })

  const variableChallengeStarts = [154, 86, 18] as const
  let previousVariableAccumulatorIndices = initialVariableAccumulatorIndices
  for (const challengeStart of variableChallengeStarts) {
    const nextVariableAccumulatorIndices = allocateIntermediates(NUM_EXTENDED_COORDINATES)
    steps.push({
      subcircuit: 'TransactionSignatureVariableBatch',
      selector: null,
      inputs: [
        ...remainingChallengeBitIndices.slice(
          challengeStart,
          challengeStart + NUM_VARIABLE_BATCH_BITS,
        ).map((index): InputReference => ({ kind: 'step-output', index })),
        ...runtimeTableIndices.map((index): InputReference => ({
          kind: 'step-output',
          index,
        })),
        ...previousVariableAccumulatorIndices.map((index): InputReference => ({
          kind: 'step-output',
          index,
        })),
      ],
      outputs: nextVariableAccumulatorIndices.map((index): OutputReference => ({
        kind: 'step-output',
        index,
      })),
    })
    previousVariableAccumulatorIndices = nextVariableAccumulatorIndices
  }

  steps.push({
    subcircuit: 'TransactionSignatureFinal',
    selector: null,
    inputs: [
      ...remainingResponseBitIndices.map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
      ...fixedAccumulatorIndices.map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
      ...remainingChallengeBitIndices.slice(0, 18).map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
      ...previousVariableAccumulatorIndices.map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
      ...runtimeTableIndices.map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
      ...randomizerCofactorIndices.map((index): InputReference => ({
        kind: 'step-output',
        index,
      })),
      { kind: 'step-output', index: publicKeyHashIndex },
    ],
    outputs: [{ kind: 'result', index: 3 }],
  })

  return Object.freeze({
    operation: 'TransactionSignatureVerify',
    composition: freezeComposition({
      placementStrategy: 'generic',
      constants: [
        { value: 1n, dataPtType: BIT_DATA_PT_TYPE },
        { value: 0n, dataPtType: BLS12_381_FR_DATA_PT_TYPE },
        { value: 0n, dataPtType: BIT_DATA_PT_TYPE },
      ],
      numSteps: steps.length,
      numOperands: numberOfOperands,
      numResults: 4,
      steps,
    }),
  })
}
