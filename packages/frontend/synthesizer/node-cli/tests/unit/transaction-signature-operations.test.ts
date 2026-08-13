import { jubjub } from '@noble/curves/misc.js'
import { FUNCTION_INPUT_LENGTH, poseidonChainCompress } from 'tokamak-l2js'
import { describe, expect, it, vi } from 'vitest'

import type { CompositionSubcircuit } from '../../../core/src/subcircuit/configuredTypes.ts'
import { createTransactionSignatureVerifyCompositionMapping } from '../../../core/src/subcircuit/special-builders/txSignVerifyComposition.ts'
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts'
import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts'
import { SubcircuitOutputCalculator } from '../../../core/src/synthesizer/handlers/subcircuitOutputCalculator.ts'
import {
  UINT160_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
} from '../../../core/src/synthesizer/types/dataStructure.ts'
import type { PreparedComposition } from '../../../core/src/synthesizer/types/placements.ts'

const TSV_OPERAND_VARIABLES = [
  'EDDSA_RANDOMIZER_X',
  'EDDSA_RANDOMIZER_Y',
  'EDDSA_PUBLIC_KEY_X',
  'EDDSA_PUBLIC_KEY_Y',
  'TRANSACTION_NONCE',
  ...Array.from({ length: FUNCTION_INPUT_LENGTH }, (_, index) => `TRANSACTION_INPUT${index}`),
  'CONTRACT_ADDRESS',
  'FUNCTION_SELECTOR',
  'EDDSA_SIGNATURE',
  'JUBJUB_POI_X',
  'JUBJUB_POI_Y',
] as const

describe('transaction-signature composition preparation and host output calculations', () => {
  it('places TSV and retains its exact result wires', () => {
    const operandPts = TSV_OPERAND_VARIABLES.map((_, index) => DataPtFactory.create({
      source: index,
      wireIndex: 0,
      dataPtType: UINT256_DATA_PT_TYPE,
    }, BigInt(index)))
    const operandPtByVariable = new Map(
      TSV_OPERAND_VARIABLES.map((variable, index) => [variable, operandPts[index]!]),
    )
    const getReservedVariableFromBuffer = vi.fn((variable: string): DataPt => {
      const operandPt = operandPtByVariable.get(variable)
      if (operandPt === undefined) throw new Error(`Unexpected TSV operand ${variable}`)
      return operandPt
    })
    const resultPts = [
      DataPtFactory.create({ source: 91, wireIndex: 0, dataPtType: UINT160_DATA_PT_TYPE }, 1n),
      DataPtFactory.create({ source: 91, wireIndex: 1, dataPtType: UINT32_DATA_PT_TYPE }, 2n),
      DataPtFactory.create({ source: 97, wireIndex: 0, dataPtType: UINT160_DATA_PT_TYPE }, 3n),
    ]
    const expectedPreparedComposition = {
      operation: 'TransactionSignatureVerify',
      operands: [],
      resultPts,
      steps: [],
    } satisfies PreparedComposition
    const state = {
      cachedContractAddress: undefined as DataPt | undefined,
      cachedFunctionSelector: undefined as DataPt | undefined,
      cachedOrigin: undefined as DataPt | undefined,
      contextByDepth: [],
      beginFrame: vi.fn(),
      recordMessageCodeAddress: vi.fn(),
    }
    const placeComposition = vi.fn()
    const handler = new InstructionHandler({
      placements: [],
      getReservedVariableFromBuffer,
      placeComposition,
    } as never, state as never, {} as never)
    const prepareFixedGenericComposition = vi.spyOn(
      handler as unknown as {
        _prepareFixedGenericComposition: (
          operation: string,
          operands: DataPt[],
          basePlacementIndex: number,
        ) => PreparedComposition;
      },
      '_prepareFixedGenericComposition',
    ).mockReturnValue(expectedPreparedComposition)

    handler.initializeTransactionSignatureVerification()

    expect(prepareFixedGenericComposition).toHaveBeenCalledWith(
      'TransactionSignatureVerify',
      operandPts,
      0,
    )
    expect(getReservedVariableFromBuffer.mock.calls.map(([variable]) => variable))
      .toEqual(TSV_OPERAND_VARIABLES)
    expect(placeComposition).toHaveBeenCalledWith(expectedPreparedComposition)
    expect(state.cachedContractAddress).toBe(resultPts[0])
    expect(state.cachedFunctionSelector).toBe(resultPts[1])
    expect(state.cachedOrigin).toBe(resultPts[2])

    handler.initializeMessageContext({
      depth: 0,
      codeAddress: {},
      data: new Uint8Array(4 + 32 * FUNCTION_INPUT_LENGTH),
      isCreate: false,
      isCompiled: false,
    } as never)
    const rootContext = state.contextByDepth[0] as {
      callerPt: DataPt
      codeAddressPt: DataPt
      storageAddressPt: DataPt
      callDataMemoryPts: readonly { dataPt: DataPt }[]
    }
    expect(rootContext.callerPt).toMatchObject({ source: resultPts[2]!.source, wireIndex: resultPts[2]!.wireIndex })
    expect(rootContext.codeAddressPt).toMatchObject({ source: resultPts[0]!.source, wireIndex: resultPts[0]!.wireIndex })
    expect(rootContext.storageAddressPt).toMatchObject({ source: resultPts[0]!.source, wireIndex: resultPts[0]!.wireIndex })
    expect(rootContext.callDataMemoryPts[0]!.dataPt).toMatchObject({
      source: resultPts[1]!.source,
      wireIndex: resultPts[1]!.wireIndex,
    })
  })

  it('reproduces the complete production TSV witness flow', () => {
    const outputCalculator = new SubcircuitOutputCalculator()
    const privateKey = 37n
    const randomizerScalar = 61n
    const publicKey = jubjub.Point.BASE.multiply(privateKey).toAffine()
    const randomizer = jubjub.Point.BASE.multiply(randomizerScalar).toAffine()
    const nonce = 19n
    const contractAddress = 0x1234567890abcdef1234567890abcdef12345678n
    const functionSelector = 0xdeadbeefn
    const transactionInputs = Array.from({ length: 29 }, (_, index) => BigInt(index + 1))
    const challengeInputs = [
      randomizer.x,
      randomizer.y,
      publicKey.x,
      publicKey.y,
      nonce,
      contractAddress,
      functionSelector,
      ...transactionInputs,
    ]
    const challenge = poseidonChainCompress(challengeInputs)
    const response = (randomizerScalar + challenge * privateKey) % jubjub.Point.Fn.ORDER
    const modulus = jubjub.Point.Fp.ORDER
    const inverse = (value: bigint): bigint => {
      let base = value % modulus
      let exponent = modulus - 2n
      let result = 1n
      while (exponent > 0n) {
        if ((exponent & 1n) === 1n) result = result * base % modulus
        base = base * base % modulus
        exponent >>= 1n
      }
      return result
    }
    const toAffine = (extended: readonly bigint[]) => ({
      x: extended[0]! * inverse(extended[2]!) % modulus,
      y: extended[1]! * inverse(extended[2]!) % modulus,
    })
    expect(toAffine(outputCalculator
      .calculateSubcircuitOutputValues('TransactionSignatureFixedPrefix70', [1n])
      .slice(42))).toEqual(
      jubjub.Point.BASE.multiply(8n).toAffine(),
    )
    const prefix = outputCalculator
      .calculateSubcircuitOutputValues('TransactionSignatureFixedPrefix70', [response])
    const policy = outputCalculator.calculateSubcircuitOutputValues('TransactionSignaturePointPolicy', [
      randomizer.x,
      randomizer.y,
      publicKey.x,
      publicKey.y,
      contractAddress,
      functionSelector,
      0n,
      1n,
    ])
    expect([policy[4], policy[5]]).toEqual(Object.values(jubjub.Point.BASE.multiply(8n * privateKey).toAffine()))
    expect(toAffine(prefix.slice(42))).toEqual(
      jubjub.Point.BASE.multiply(8n * (response & ((1n << 210n) - 1n))).toAffine(),
    )
    const operands = [
      randomizer.x,
      randomizer.y,
      publicKey.x,
      publicKey.y,
      nonce,
      ...transactionInputs,
      contractAddress,
      functionSelector,
      response,
      0n,
      1n,
    ]

    const { composition } = createTransactionSignatureVerifyCompositionMapping()
    const intermediates = new Map<number, bigint>()
    const results = new Map<number, bigint>()
    for (const step of composition.steps) {
      const values = step.inputs.map((input) => {
        switch (input.kind) {
          case 'operand':
            return operands[input.index]!
          case 'constant':
            return composition.constants[input.index]!.value
          case 'step-output':
            return intermediates.get(input.index)!
          case 'selector':
            throw new Error('TSV does not use selector inputs')
        }
      })
      const calculated = outputCalculator.calculateSubcircuitOutputValues(
        step.subcircuit as CompositionSubcircuit,
        values,
      )
      step.outputs.forEach((output, index) => {
        if (output.kind === 'step-output') intermediates.set(output.index, calculated[index]!)
        if (output.kind === 'result') results.set(output.index, calculated[index]!)
      })
    }

    expect(results.get(0)).toBe(contractAddress)
    expect(results.get(1)).toBe(functionSelector)
    expect(results.get(2)).toBe(poseidonChainCompress([publicKey.x, publicKey.y]) & ((1n << 160n) - 1n))
  })

  it('rejects a non-canonical challenge hash before producing variable scalar bits', () => {
    const modulus = jubjub.Point.Fp.ORDER
    const outputCalculator = new SubcircuitOutputCalculator()
    expect(() => outputCalculator.calculateSubcircuitOutputValues('TransactionSignatureChallengeVariablePrefix', [
      modulus,
      0n,
      1n,
      0n,
      1n,
      0n,
      1n,
      0n,
      1n,
    ])).toThrow('challenge hash is not a canonical BLS12-381 Fr value')
  })
})
