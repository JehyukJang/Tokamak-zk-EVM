import { describe, expect, it, vi } from 'vitest';

import { createMemoryLoadCompositionMapping } from '../../../core/src/subcircuit/special-builders/memoryLoadComposition.ts';
import { BUFFER_LIST } from '../../../core/src/subcircuit/configuredTypes.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { MemoryPt } from '../../../core/src/synthesizer/dataStructure/memoryPt.ts';
import { ContextManager } from '../../../core/src/synthesizer/handlers/contextManager.ts';
import { PlacementManager } from '../../../core/src/synthesizer/handlers/placementManager.ts';
import { calculateSubcircuitOutputValues } from '../../../core/src/subcircuit/subcircuitOutputOperations.ts';
import {
  BIT_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { PreparedComposition } from '../../../core/src/synthesizer/types/placements.ts';

const memoryLoadComposition = createMemoryLoadCompositionMapping().composition
const evmInSource = BUFFER_LIST.indexOf('EVM_IN')

const dataPt = (
  value: bigint,
  source: number,
  wireIndex: number,
  dataPtType: DataPtType = UINT256_DATA_PT_TYPE,
): DataPt => DataPtFactory.create({ source, wireIndex, dataPtType }, value)

const memoryLoadInfo = {
  id: 0,
  name: 'MemoryLoadStep' as const,
  NWires: 14,
  NInWires: 10,
  NOutWires: 3,
  inWireIndex: 4,
  outWireIndex: 1,
  flattenMap: [],
  logicalInterface: {
    inputs: [
      { name: 'sourceWord', logicalType: { kind: 'uint' as const, bits: 256 } },
      { name: 'shift', logicalType: { kind: 'uint' as const, bits: 32 } },
      { name: 'direction', logicalType: { kind: 'uint' as const, bits: 1 } },
      { name: 'ownership', logicalType: { kind: 'uint' as const, bits: 32 } },
      { name: 'previousWord', logicalType: { kind: 'uint' as const, bits: 256 } },
      { name: 'previousOwnership', logicalType: { kind: 'uint' as const, bits: 32 } },
      { name: 'expectedOwnership', logicalType: { kind: 'uint' as const, bits: 32 } },
      { name: 'finalMode', logicalType: { kind: 'uint' as const, bits: 1 } },
    ],
    outputs: [
      { name: 'nextWord', logicalType: { kind: 'uint' as const, bits: 256 } },
      { name: 'nextOwnership', logicalType: { kind: 'uint' as const, bits: 32 } },
    ],
  },
}

const initialPlacements = Array.from({ length: 6 }, () => ({
  name: 'MemoryLoadStep' as const,
  usage: 'test',
  subcircuitId: 0,
  inPts: [],
  outPts: [],
}))

const createHarness = () => {
  let staticWireIndex = 0
  const parent = {
    _placements: initialPlacements.map((placement) => ({ ...placement })),
    _placementCompositionMapping: { MemoryLoad: memoryLoadComposition },
    subcircuitInfoByName: new Map([['MemoryLoadStep', memoryLoadInfo]]),
    subcircuitLibrary: {
      calculateSubcircuitOutputValues,
    },
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, evmInSource, staticWireIndex++, dataPtType)),
  }
  const placementManager = Object.assign(Object.create(PlacementManager.prototype), parent) as PlacementManager
  const contextManager = new ContextManager(placementManager)

  return { parent, placementManager, contextManager }
}

const prepareView = (
  placementManager: PlacementManager,
  memoryPt: MemoryPt,
  offset: number,
  length: number,
  basePlacementIndex = 6,
): PreparedComposition => placementManager.prepareComposition({
  operation: 'MemoryLoad',
  dataAliasGeometries: memoryPt.getDataAlias(offset, length),
  viewByteLength: length,
}, basePlacementIndex)

const prepareRead = (
  contextManager: ContextManager,
  memoryPt: MemoryPt,
  offset: bigint,
  length: bigint,
  basePlacementIndex = 6,
) => contextManager.prepareMemoryRead(memoryPt, offset, length, basePlacementIndex)

const prepareCopy = (
  contextManager: ContextManager,
  memoryPt: MemoryPt,
  sourceOffset: bigint,
  length: bigint,
  destinationOffset: bigint,
  basePlacementIndex = 6,
) => contextManager.prepareMemoryCopy(
  memoryPt,
  sourceOffset,
  length,
  destinationOffset,
  basePlacementIndex,
)

const wordPt = (value: bigint, source: number): DataPt =>
  dataPt(value, source, 0, UINT256_DATA_PT_TYPE)

describe('prepared MemoryLoad compositions', () => {
  it('prepares a serial fragment chain without recording a placement', () => {
    const { placementManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 2, wordPt(0x1122n, 1))
    memoryPt.write(2, 2, wordPt(0x3344n, 2))

    const prepared = prepareView(placementManager, memoryPt, 0, 4)

    expect(placementManager.placements).toHaveLength(6)
    expect(prepared.steps).toHaveLength(2)
    expect(prepared.steps[0]!.inPts.slice(4, 6).map(({ value }) => value)).toEqual([0n, 0n])
    expect(prepared.steps[1]!.inPts.slice(4, 6).map(({ source, wireIndex }) => [source, wireIndex]))
      .toEqual([[6, 0], [6, 1]])
    expect(prepared.resultPts).toEqual(prepared.steps[1]!.outPts.slice(0, 1))

    placementManager.placeComposition(prepared)
    expect(placementManager.placements).toHaveLength(8)
  })

  it('rejects a fragment chain with a substituted prior output before recording anything', () => {
    const { placementManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 2, wordPt(0x1122n, 1))
    memoryPt.write(2, 2, wordPt(0x3344n, 2))
    const prepared = prepareView(placementManager, memoryPt, 0, 4)
    const mutated: PreparedComposition = {
      ...prepared,
      steps: [
        prepared.steps[0]!,
        {
          ...prepared.steps[1]!,
          inPts: [
            ...prepared.steps[1]!.inPts.slice(0, 4),
            dataPt(0n, evmInSource, 99),
            prepared.steps[1]!.inPts[5]!,
            ...prepared.steps[1]!.inPts.slice(6),
          ],
        },
      ],
    }

    expect(() => placementManager.placeComposition(mutated)).toThrow(
      'MemoryLoad step 1 is not connected to the previous step',
    )
    expect(placementManager.placements).toHaveLength(6)
  })

  it('keeps all-zero views placement-free and retains their EVM_IN zero word', () => {
    const { contextManager, placementManager } = createHarness()

    const preparedRead = prepareRead(contextManager, new MemoryPt(), 0n, 32n)

    expect(preparedRead.compositions).toEqual([])
    expect(preparedRead.viewDataPts).toMatchObject([
      { source: evmInSource, dataPtType: UINT256_DATA_PT_TYPE, value: 0n },
    ])
    expect(preparedRead.recoveredValue).toBe(0n)
    expect(placementManager.placements).toHaveLength(6)
  })

  it('keeps consecutive views in source order with monotonically advancing outputs', () => {
    const { contextManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 32, wordPt(1n, 1))
    memoryPt.write(32, 32, wordPt(2n, 2))

    const preparedRead = prepareRead(contextManager, memoryPt, 0n, 64n)

    expect(preparedRead.compositions).toHaveLength(2)
    expect(preparedRead.compositions.map(({ steps }) => steps[0]!.inPts[0]!.source))
      .toEqual([1, 2])
    expect(preparedRead.viewDataPts.map(({ source, wireIndex }) => [source, wireIndex]))
      .toEqual([[6, 0], [7, 0]])
  })

  it('freezes copy source inputs before later writes and creates compact destination views', () => {
    const { contextManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 32, wordPt(1n, 1))
    memoryPt.write(32, 8, wordPt(2n, 2))

    const preparedCopy = prepareCopy(contextManager, memoryPt, 0n, 40n, 96n)
    memoryPt.write(0, 32, wordPt(3n, 3))

    expect(preparedCopy.compositions).toHaveLength(2)
    expect(preparedCopy.compositions.map(({ steps }) => steps[0]!.inPts[0]!.source))
      .toEqual([1, 2])
    expect(preparedCopy.destinationEntries).toMatchObject([
      { memByteOffset: 96, containerByteSize: 32, dataPt: { source: 6, wireIndex: 0 } },
      { memByteOffset: 128, containerByteSize: 8, dataPt: { source: 7, wireIndex: 0 } },
    ])
  })
})
