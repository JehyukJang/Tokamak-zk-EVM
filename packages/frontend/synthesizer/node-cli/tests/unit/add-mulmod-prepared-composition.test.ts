import { describe, expect, it, vi } from 'vitest';

import { createAddMulModCompositionMappings } from '../../../core/src/subcircuit/special-builders/addMulModComposition.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import {
  UINT128_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
  type DataPt,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { PreparedComposition } from '../../../core/src/synthesizer/types/placements.ts';

const uint = (bits: number) => ({ kind: 'uint' as const, bits })

const subcircuitInfoByName = new Map([
  ['ADDMODPrepare', {
    logicalInterface: {
      inputs: [],
      outputs: [uint(86), uint(86), uint(85), uint(86), uint(86), uint(85), uint(256)]
        .map((logicalType, index) => ({ name: `out${index}`, logicalType })),
    },
  }],
  ['ADDMODVerify', {
    logicalInterface: {
      inputs: [],
      outputs: [{ name: 'result', logicalType: uint(256) }],
    },
  }],
  ['MULMODPrepare', {
    logicalInterface: {
      inputs: [],
      outputs: [
        ...Array.from({ length: 12 }, (_, index) => ({ name: `word${index}`, logicalType: uint(64) })),
        { name: 'quotientLow', logicalType: uint(256) },
        { name: 'quotientHigh', logicalType: uint(256) },
        { name: 'remainder', logicalType: uint(256) },
      ],
    },
  }],
  ['MULMODCandidate', {
    logicalInterface: {
      inputs: [],
      outputs: Array.from(
        { length: 12 },
        (_, index) => ({ name: `word${index}`, logicalType: uint(64) }),
      ),
    },
  }],
  ['MULMODVerify', {
    logicalInterface: {
      inputs: [],
      outputs: [{ name: 'result', logicalType: uint(256) }],
    },
  }],
])

const dataPt = (value: bigint, source: number, wireIndex = 0): DataPt =>
  DataPtFactory.create({ source, wireIndex, dataPtType: UINT256_DATA_PT_TYPE }, value)

const addMulModCompositions = new Map(
  createAddMulModCompositionMappings().map(({ operation, composition }) => [
    operation,
    composition,
  ]),
)

const submit = (
  operation: 'ADDMOD' | 'MULMOD',
): { preparedComposition: PreparedComposition; resultPts: DataPt[] } => {
  const placeComposition = vi.fn()
  const calculateArithSubcircuitOutputValues = vi.fn((name: string): bigint[] => {
    switch (name) {
      case 'ADDMODPrepare':
        return Array.from({ length: 7 }, (_, index) => BigInt(index))
      case 'ADDMODVerify':
        return [7n]
      case 'MULMODPrepare':
        return Array.from({ length: 15 }, (_, index) => BigInt(index))
      case 'MULMODCandidate':
        return Array.from({ length: 12 }, (_, index) => BigInt(index))
      case 'MULMODVerify':
        return [11n]
      default:
        throw new Error(`Unexpected subcircuit ${name}`)
    }
  })
  const parent = {
    cachedOpts: {},
    placements: [],
    state: {},
    subcircuitLibrary: {
      placementCompositionManager: {
        get: (name: 'ADDMOD' | 'MULMOD') => addMulModCompositions.get(name)!,
      },
      subcircuitInfoByName,
    },
    calculateArithSubcircuitOutputValues,
    loadArbitraryStatic: vi.fn(),
    placeComposition,
  }
  const handler = new InstructionHandler(parent as never)
  const resultPts = (handler as unknown as {
    _submitAddMulModComposition(
      operation: 'ADDMOD' | 'MULMOD',
      operands: DataPt[],
    ): DataPt[];
  })._submitAddMulModComposition(operation, [
    dataPt(3n, 10),
    dataPt(4n, 11),
    dataPt(5n, 12),
  ])

  expect(placeComposition).toHaveBeenCalledOnce()
  return {
    preparedComposition: placeComposition.mock.calls[0]![0],
    resultPts,
  }
}

describe('ADDMOD and MULMOD prepared compositions', () => {
  it('prepares the two ADDMOD steps with typed intermediate outputs', () => {
    const { preparedComposition, resultPts } = submit('ADDMOD')

    expect(preparedComposition.steps.map((step) => [step.inPts.length, step.outPts.length]))
      .toEqual([[3, 7], [8, 1]])
    expect(preparedComposition.steps[0]!.outPts.map(({ dataPtType }) => dataPtType)).toEqual([
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT256_DATA_PT_TYPE,
    ])
    expect(preparedComposition.steps[1]!.inPts[0]).toMatchObject({ source: 0, wireIndex: 0 })
    expect(preparedComposition.steps[1]!.inPts[3]).toMatchObject({ source: 12, wireIndex: 0 })
    expect(resultPts).toMatchObject([{ source: 1, wireIndex: 0, value: 7n }])
  })

  it('prepares the three MULMOD steps with every intermediate connected by wire', () => {
    const { preparedComposition, resultPts } = submit('MULMOD')

    expect(preparedComposition.steps.map((step) => [step.inPts.length, step.outPts.length]))
      .toEqual([[3, 15], [3, 12], [24, 1]])
    expect(preparedComposition.steps[1]!.inPts.map(({ source, wireIndex }) => [source, wireIndex]))
      .toEqual([[0, 12], [0, 13], [0, 14]])
    expect(preparedComposition.steps[2]!.inPts.slice(0, 12).map(({ source }) => source))
      .toEqual(Array(12).fill(0))
    expect(preparedComposition.steps[2]!.inPts.slice(12).map(({ source }) => source))
      .toEqual(Array(12).fill(1))
    expect(resultPts).toMatchObject([{ source: 2, wireIndex: 0, value: 11n }])
  })
})
