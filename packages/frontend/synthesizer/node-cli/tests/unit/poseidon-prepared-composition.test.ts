import { describe, expect, it, vi } from 'vitest';

import { createPoseidonCompositionMapping } from '../../../core/src/subcircuit/special-builders/poseidonComposition.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import { StateManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import {
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { PreparedComposition } from '../../../core/src/synthesizer/types/placements.ts';

const poseidonComposition = createPoseidonCompositionMapping({ nPoseidonBatch: 4 }).composition

const logicalInterface = {
  inputs: [
    { name: 'selector', logicalType: { kind: 'uint' as const, bits: 32 } },
    ...Array.from(
      { length: 5 },
      (_, index) => ({ name: `value${index}`, logicalType: { kind: 'uint' as const, bits: 256 } }),
    ),
  ],
  outputs: [{ name: 'result', logicalType: { kind: 'uint' as const, bits: 256 } }],
}

const dataPt = (
  value: bigint,
  source: number,
  wireIndex: number,
  dataPtType: DataPtType = UINT256_DATA_PT_TYPE,
): DataPt => DataPtFactory.create({ source, wireIndex, dataPtType }, value)

const prepare = (operands: DataPt[]): PreparedComposition => {
  let nextStaticWireIndex = 0
  const parent = {
    placements: [],
    subcircuitLibrary: {
      placementCompositionManager: { get: () => poseidonComposition },
      subcircuitInfoByName: new Map([['Poseidon', { logicalInterface }]]),
    },
    calculateSubcircuitOutputValues: vi.fn((_: string, values: bigint[]) => [
      values.reduce((sum, value) => sum + value, 0n),
    ]),
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, 5, nextStaticWireIndex++, dataPtType)),
  }
  const handler = new InstructionHandler(parent as never, {} as never, {} as never)
  return (handler as unknown as {
    _preparePoseidonComposition(
      input: DataPt[],
      basePlacementIndex: number,
    ): PreparedComposition;
  })._preparePoseidonComposition(operands, 0)
}

function createState(): StateManager {
  return Object.assign(Object.create(StateManager.prototype), {
    _placements: Array.from({ length: 6 }, () => ({
      name: 'Poseidon',
      usage: 'test',
      subcircuitId: 0,
      inPts: [],
      outPts: [],
    })),
    subcircuitInfoByName: new Map([['Poseidon', {
      id: 0,
      name: 'Poseidon',
      NWires: 13,
      NInWires: 11,
      NOutWires: 2,
      inWireIndex: 3,
      outWireIndex: 1,
      flattenMap: [],
      logicalInterface,
    }]]),
    _placementCompositionManager: { get: () => poseidonComposition },
  }) as StateManager
}

describe('prepared Poseidon composition', () => {
  it('pads each dynamic batch and connects a prefix hash to the next batch', () => {
    const operands = Array.from(
      { length: 7 },
      (_, index) => dataPt(BigInt(index + 1), 10 + index, 0),
    )
    const prepared = prepare(operands)

    expect(prepared.steps).toHaveLength(2)
    expect(prepared.steps[0]!.inPts.map(({ value }) => value)).toEqual([8n, 1n, 2n, 3n, 4n, 5n])
    expect(prepared.steps[1]!.inPts.map(({ value }) => value)).toEqual([2n, 23n, 6n, 7n, 0n, 0n])
    expect(prepared.steps[1]!.inPts[1]).toMatchObject({ source: 0, wireIndex: 0 })
    expect(prepared.steps[1]!.outPts[0]).toMatchObject({
      source: 1,
      wireIndex: 0,
      dataPtType: UINT256_DATA_PT_TYPE,
      value: 38n,
    })
    expect(prepared.resultPts).toEqual(prepared.steps[1]!.outPts)
  })

  it('pads an empty request to the primitive minimum of two inputs', () => {
    const prepared = prepare([])

    expect(prepared.steps).toHaveLength(1)
    expect(prepared.steps[0]!.inPts.map(({ value }) => value)).toEqual([1n, 0n, 0n, 0n, 0n, 0n])
  })

  it('rejects a prepared chain whose next batch does not consume the prior hash', () => {
    const operands = Array.from(
      { length: 6 },
      (_, index) => dataPt(BigInt(index + 1), index, 0),
    )
    const firstOutput = dataPt(15n, 6, 0)
    const result = dataPt(23n, 7, 0)
    const prepared: PreparedComposition = {
      operation: 'Poseidon',
      operands,
      resultPts: [result],
      steps: [
        {
          inPts: [
            dataPt(8n, 5, 0, UINT32_DATA_PT_TYPE),
            ...operands.slice(0, 5),
          ],
          outPts: [firstOutput],
        },
        {
          inPts: [
            dataPt(1n, 5, 1, UINT32_DATA_PT_TYPE),
            operands[5]!,
            dataPt(0n, 5, 2),
            dataPt(0n, 5, 2),
            dataPt(0n, 5, 2),
            dataPt(0n, 5, 2),
          ],
          outPts: [result],
        },
      ],
    }

    expect(() => createState().placeComposition(prepared)).toThrow(
      'Poseidon step 1 input 0 is not connected to its declared source',
    )
  })
})
