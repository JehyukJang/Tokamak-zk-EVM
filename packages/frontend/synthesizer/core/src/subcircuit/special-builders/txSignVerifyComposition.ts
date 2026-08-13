import { FUNCTION_INPUT_LENGTH } from 'tokamak-l2js'

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

const NUM_CHALLENGE_INPUTS = FUNCTION_INPUT_LENGTH + 7
const NUM_CHAIN_POSEIDON_BATCHES = 8
const NUM_VARIABLE_BATCHES = 3
const NUM_RUNTIME_TABLE_COORDINATES = 8
const NUM_EXTENDED_COORDINATES = 4
const NUM_REMAINING_RESPONSE_BITS = 42
const NUM_REMAINING_CHALLENGE_BITS = 222
const NUM_VARIABLE_BATCH_BITS = 68

const CONTRACT_OPERAND_INDEX = FUNCTION_INPUT_LENGTH + 5
const SELECTOR_OPERAND_INDEX = CONTRACT_OPERAND_INDEX + 1
const RESPONSE_OPERAND_INDEX = SELECTOR_OPERAND_INDEX + 1
const IDENTITY_X_OPERAND_INDEX = RESPONSE_OPERAND_INDEX + 1
const IDENTITY_Y_OPERAND_INDEX = IDENTITY_X_OPERAND_INDEX + 1
const NUM_OPERANDS = IDENTITY_Y_OPERAND_INDEX + 1

const challengeInput = (index: number): InputReference => {
  if (index < 5) {
    return { kind: 'operand', index }
  }
  if (index === 5) {
    return { kind: 'operand', index: CONTRACT_OPERAND_INDEX }
  }
  if (index === 6) {
    return { kind: 'operand', index: SELECTOR_OPERAND_INDEX }
  }
  return { kind: 'operand', index: index - 2 }
}

export const createTransactionSignatureVerifyCompositionMapping = (): PlacementCompositionEntry => {
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
          ? challengeInput(0)
          : { kind: 'step-output', index: previousChallengeHashIndex },
        challengeInput(challengeOffset + 1),
        { kind: 'constant', index: zeroFieldConstantIndex },
        challengeInput(challengeOffset + 2),
        challengeInput(challengeOffset + 3),
        challengeInput(challengeOffset + 4),
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
      challengeInput(2),
      challengeInput(3),
      { kind: 'step-output', index: previousChallengeHashIndex },
      challengeInput(33),
      challengeInput(34),
      challengeInput(35),
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
      challengeInput(0),
      challengeInput(1),
      challengeInput(2),
      challengeInput(3),
      { kind: 'operand', index: CONTRACT_OPERAND_INDEX },
      { kind: 'operand', index: SELECTOR_OPERAND_INDEX },
      { kind: 'operand', index: IDENTITY_X_OPERAND_INDEX },
      { kind: 'operand', index: IDENTITY_Y_OPERAND_INDEX },
    ],
    outputs: [
      { kind: 'result', index: 0 },
      { kind: 'result', index: 1 },
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
    inputs: [{ kind: 'operand', index: RESPONSE_OPERAND_INDEX }],
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
    outputs: [{ kind: 'result', index: 2 }],
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
      numOperands: NUM_OPERANDS,
      numResults: 3,
      steps,
    }),
  })
}
