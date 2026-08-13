import { describe, expect, it, vi } from 'vitest';

import { createAddMulModCompositionMappings } from '../../../core/src/subcircuit/special-builders/addMulModComposition.ts';
import { createDivisionCompositionMappings } from '../../../core/src/subcircuit/special-builders/divModComposition.ts';
import { createExpCompositionMapping } from '../../../core/src/subcircuit/special-builders/expComposition.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { Synthesizer } from '../../../core/src/synthesizer/synthesizer.ts';
import {
  BIT_DATA_PT_TYPE,
  UINT128_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { PreparedComposition } from '../../../core/src/synthesizer/types/placements.ts';

type FixedMultiStepOperation =
  | 'DIV'
  | 'SDIV'
  | 'MOD'
  | 'SMOD'
  | 'ADDMOD'
  | 'MULMOD'
  | 'EXP'

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
  ['ALU4A', {
    logicalInterface: {
      inputs: [],
      outputs: [
        ...Array.from({ length: 3 }, (_, index) => ({ name: `word${index}`, logicalType: uint(256) })),
        ...Array.from({ length: 4 }, (_, index) => ({ name: `limb${index}`, logicalType: uint(64) })),
        ...Array.from({ length: 3 }, (_, index) => ({ name: `flag${index}`, logicalType: uint(1) })),
      ],
    },
  }],
  ['ALU4B', {
    logicalInterface: {
      inputs: [],
      outputs: [{ name: 'result', logicalType: uint(256) }],
    },
  }],
  ['DecToBit', {
    logicalInterface: {
      inputs: [],
      outputs: Array.from(
        { length: 256 },
        (_, index) => ({ name: `bit${index}`, logicalType: uint(1) }),
      ),
    },
  }],
  ['SubExp', {
    logicalInterface: {
      inputs: [],
      outputs: [
        { name: 'nextAccumulator', logicalType: uint(256) },
        { name: 'nextBasePower', logicalType: uint(256) },
      ],
    },
  }],
  ['CheckBus256', {
    logicalInterface: {
      inputs: [],
      outputs: [{ name: 'checkedWord', logicalType: uint(256) }],
    },
  }],
])

const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
  dataPtType: DataPtType = UINT256_DATA_PT_TYPE,
): DataPt => DataPtFactory.create({ source, wireIndex, dataPtType }, value)

const fixedMultiStepCompositions = new Map(
  [
    ...createAddMulModCompositionMappings(),
    ...createDivisionCompositionMappings(),
    createExpCompositionMapping(),
  ].map(({ operation, composition }) => [operation, composition]),
)

const submit = (
  operation: FixedMultiStepOperation,
): { preparedComposition: PreparedComposition; resultPts: DataPt[] } => {
  const calculateSubcircuitOutputValues = vi.fn((name: string): bigint[] => {
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
      case 'ALU4A':
        return [0n, 1n, 2n, 3n, 4n, 5n, 6n, 0n, 1n, 0n]
      case 'ALU4B':
        return [13n]
      case 'DecToBit':
        return Array.from({ length: 256 }, (_, index) => BigInt(index % 2))
      case 'SubExp':
        return [17n, 19n]
      case 'CheckBus256':
        return [23n]
      default:
        throw new Error(`Unexpected subcircuit ${name}`)
    }
  })
  let nextStaticWireIndex = 0
  const parent = {
    placements: [],
    subcircuitLibrary: {
      placementCompositionMapping: Object.fromEntries(fixedMultiStepCompositions),
      subcircuitInfoByName,
    },
    calculateSubcircuitOutputValues,
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, 5, nextStaticWireIndex++, dataPtType)),
  }
  const preparedComposition = Synthesizer.prototype.prepareFixedGenericComposition.call(parent,
    operation,
    operation === 'ADDMOD' || operation === 'MULMOD'
      ? [dataPt(3n, 10), dataPt(4n, 11), dataPt(5n, 12)]
      : [dataPt(3n, 10), dataPt(4n, 11)],
    0,
  )

  return {
    preparedComposition,
    resultPts: preparedComposition.resultPts,
  }
}

describe('fixed generic prepared compositions', () => {
  it('prepares every declared result of a fixed generic composition', () => {
    const composition = {
      placementStrategy: 'generic' as const,
      constants: [],
      numSteps: 1,
      numOperands: 1,
      numResults: 3,
      steps: [{
        subcircuit: 'ALU1' as const,
        selector: null,
        inputs: [{ kind: 'operand' as const, index: 0 }],
        outputs: [
          { kind: 'result' as const, index: 0 },
          { kind: 'result' as const, index: 1 },
          { kind: 'result' as const, index: 2 },
        ],
      }],
    }
    const parent = {
      placements: [],
      subcircuitLibrary: {
        placementCompositionMapping: { ADDMOD: composition },
        subcircuitInfoByName: new Map([['ALU1', {
          logicalInterface: {
            inputs: [],
            outputs: [uint(1), uint(32), uint(256)]
              .map((logicalType, index) => ({ name: `out${index}`, logicalType })),
          },
        }]]),
      },
      calculateSubcircuitOutputValues: () => [1n, 2n, 3n],
      loadArbitraryStatic: vi.fn(),
    }

    const prepared = Synthesizer.prototype.prepareFixedGenericComposition.call(
      parent as never,
      'ADDMOD',
      [dataPt(7n, 10)],
      4,
    )

    expect(prepared.resultPts).toMatchObject([
      { source: 4, wireIndex: 0, value: 1n, dataPtType: BIT_DATA_PT_TYPE },
      { source: 4, wireIndex: 1, value: 2n, dataPtType: UINT32_DATA_PT_TYPE },
      { source: 4, wireIndex: 2, value: 3n, dataPtType: UINT256_DATA_PT_TYPE },
    ])
  })

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

  it('prepares the division-family steps with a selector and typed flags', () => {
    const { preparedComposition, resultPts } = submit('DIV')

    expect(preparedComposition.steps.map((step) => [step.inPts.length, step.outPts.length]))
      .toEqual([[3, 10], [10, 1]])
    expect(preparedComposition.steps[0]!.inPts[0]).toMatchObject({
      source: 5,
      value: 1n << 4n,
      dataPtType: UINT32_DATA_PT_TYPE,
    })
    expect(preparedComposition.steps[0]!.outPts.map(({ dataPtType }) => dataPtType)).toEqual([
      UINT256_DATA_PT_TYPE,
      UINT256_DATA_PT_TYPE,
      UINT256_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      UINT128_DATA_PT_TYPE,
      BIT_DATA_PT_TYPE,
      BIT_DATA_PT_TYPE,
      BIT_DATA_PT_TYPE,
    ])
    expect(preparedComposition.steps[1]!.inPts.map(({ source }) => source))
      .toEqual(Array(10).fill(0))
    expect(resultPts).toMatchObject([{ source: 1, wireIndex: 0, value: 13n }])
  })

  it('prepares every declared EXP step and preserves the serial state connections', () => {
    const { preparedComposition, resultPts } = submit('EXP')

    expect(preparedComposition.steps).toHaveLength(258)
    expect(preparedComposition.steps[0]!.inPts).toHaveLength(1)
    expect(preparedComposition.steps[0]!.outPts).toHaveLength(256)
    expect(preparedComposition.steps[0]!.outPts.every(
      ({ dataPtType }) => dataPtType === BIT_DATA_PT_TYPE,
    )).toBe(true)
    expect(preparedComposition.steps[1]!.inPts.map(({ value }) => value)).toEqual([1n, 3n, 0n])
    expect(preparedComposition.steps[2]!.inPts.map(({ source, wireIndex }) => [source, wireIndex]))
      .toEqual([[1, 0], [1, 1], [0, 1]])
    expect(preparedComposition.steps.at(-1)).toMatchObject({
      inPts: [{ source: 256, wireIndex: 0, value: 17n }],
      outPts: [{ source: 257, wireIndex: 0, value: 23n, dataPtType: UINT256_DATA_PT_TYPE }],
    })
    expect(resultPts).toMatchObject([{ source: 257, wireIndex: 0, value: 23n }])
  })
})
