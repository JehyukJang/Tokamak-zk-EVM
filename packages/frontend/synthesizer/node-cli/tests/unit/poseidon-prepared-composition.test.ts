import { describe, expect, it, vi } from 'vitest';

import { createPoseidonCompositionMapping } from '../../../core/src/subcircuit/special-builders/poseidonComposition.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { PlacementManager } from '../../../core/src/synthesizer/handlers/placementManager.ts';
import {
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';

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

const createPlacementManager = (): PlacementManager => {
  let nextStaticWireIndex = 0
  return Object.assign(Object.create(PlacementManager.prototype), {
    _placements: Array.from({ length: 6 }, () => ({
      name: 'Poseidon',
      usage: 'test',
      subcircuitId: 0,
      inPts: [],
      outPts: [],
    })),
    _placementCompositionMapping: { Poseidon: poseidonComposition },
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
    subcircuitLibrary: {
      calculateSubcircuitOutputValues: vi.fn((_: string, values: bigint[]) => [
        values.reduce((sum, value) => sum + value, 0n),
      ]),
    },
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, 5, nextStaticWireIndex++, dataPtType)),
    getReservedVariableFromBuffer: vi.fn(() =>
      dataPt(0n, 5, nextStaticWireIndex++, UINT256_DATA_PT_TYPE)),
  }) as PlacementManager
}

describe('atomic Poseidon composition', () => {
  it('pads each dynamic batch and connects a prefix hash to the next batch', () => {
    const operands = Array.from(
      { length: 7 },
      (_, index) => dataPt(BigInt(index + 1), 0, index),
    )
    const placementManager = createPlacementManager()
    const resultPts = placementManager.placeComposition('Poseidon', operands)
    const steps = placementManager.placements.slice(6)

    expect(steps).toHaveLength(2)
    expect(steps[0]!.inPts.map(({ value }) => value)).toEqual([8n, 1n, 2n, 3n, 4n, 5n])
    expect(steps[1]!.inPts.map(({ value }) => value)).toEqual([2n, 23n, 6n, 7n, 0n, 0n])
    expect(steps[1]!.inPts[1]).toMatchObject({ source: 6, wireIndex: 0 })
    expect(steps[1]!.outPts[0]).toMatchObject({
      source: 7,
      wireIndex: 0,
      dataPtType: UINT256_DATA_PT_TYPE,
      value: 38n,
    })
    expect(resultPts).toEqual(steps[1]!.outPts)
  })

  it('pads an empty request to the primitive minimum of two inputs', () => {
    const placementManager = createPlacementManager()

    placementManager.placeComposition('Poseidon', [])
    const steps = placementManager.placements.slice(6)

    expect(steps).toHaveLength(1)
    expect(steps[0]!.inPts.map(({ value }) => value)).toEqual([1n, 0n, 0n, 0n, 0n, 0n])
  })

  it('rejects view-grouped operands without recording a placement', () => {
    const placementManager = createPlacementManager()

    expect(() => placementManager.placeComposition('Poseidon', [[dataPt(1n, 0, 0)]])).toThrow(
      'Poseidon requires flat operands',
    )
    expect(placementManager.placements).toHaveLength(6)
  })
})
