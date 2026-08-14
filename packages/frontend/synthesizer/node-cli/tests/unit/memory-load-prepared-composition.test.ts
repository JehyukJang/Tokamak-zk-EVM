import { describe, expect, it, vi } from 'vitest'

import { BUFFER_LIST } from '../../../core/src/subcircuit/configuredTypes.ts'
import { createMemoryViewCompositionMapping } from '../../../core/src/subcircuit/special-builders/memoryViewComposition.ts'
import { calculateSubcircuitOutputValues } from '../../../core/src/subcircuit/subcircuitOutputOperations.ts'
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts'
import { MemoryPt } from '../../../core/src/synthesizer/dataStructure/memoryPt.ts'
import {
  ContextManager,
  createMemoryCopyEntries,
} from '../../../core/src/synthesizer/handlers/contextManager.ts'
import { PlacementManager } from '../../../core/src/synthesizer/handlers/placementManager.ts'
import {
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts'

const memoryViewComposition = createMemoryViewCompositionMapping().composition
const evmInSource = BUFFER_LIST.indexOf('EVM_IN')

const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
  dataPtType: DataPtType = UINT256_DATA_PT_TYPE,
): DataPt => DataPtFactory.create({ source, wireIndex, dataPtType }, value)

const memoryViewInfo = {
  id: 0,
  name: 'MemoryViewStep' as const,
  NWires: 11,
  NInWires: 7,
  NOutWires: 3,
  inWireIndex: 4,
  outWireIndex: 1,
  flattenMap: [],
  logicalInterface: {
    inputs: [
      { name: 'sourceWord', logicalType: { kind: 'uint' as const, bits: 256 } },
      { name: 'encodedShift', logicalType: { kind: 'uint' as const, bits: 6 } },
      { name: 'incomingOwnership', logicalType: { kind: 'uint' as const, bits: 32 } },
      { name: 'previousWord', logicalType: { kind: 'uint' as const, bits: 256 } },
      { name: 'previousOwnership', logicalType: { kind: 'uint' as const, bits: 32 } },
    ],
    outputs: [
      { name: 'nextWord', logicalType: { kind: 'uint' as const, bits: 256 } },
      { name: 'nextOwnership', logicalType: { kind: 'uint' as const, bits: 32 } },
    ],
  },
}

const createHarness = () => {
  let staticWireIndex = 0
  const placementManager = Object.assign(Object.create(PlacementManager.prototype), {
    _placements: Array.from({ length: 6 }, () => ({
      name: 'MemoryViewStep',
      usage: 'test',
      subcircuitId: 0,
      inPts: [],
      outPts: [],
    })),
    _placementCompositionMapping: { MemoryView: memoryViewComposition },
    subcircuitInfoByName: new Map([['MemoryViewStep', memoryViewInfo]]),
    subcircuitLibrary: { calculateSubcircuitOutputValues },
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, evmInSource, staticWireIndex++, dataPtType)),
    getReservedVariableFromBuffer: vi.fn((name: string) => dataPt(
      0n,
      evmInSource,
      staticWireIndex++,
      name === 'UINT32_CONST_ZERO' ? UINT32_DATA_PT_TYPE : UINT256_DATA_PT_TYPE,
    )),
  }) as PlacementManager
  return {
    contextManager: new ContextManager(placementManager),
    placementManager,
  }
}

const wordPt = (value: bigint, source: number): DataPt => dataPt(value, source)

describe('atomic MemoryView compositions', () => {
  it('records a serial fragment chain and returns its final word', () => {
    const { contextManager, placementManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 2, wordPt(0x1122n, 1))
    memoryPt.write(2, 2, wordPt(0x3344n, 2))
    const operands = contextManager.createMemoryOperands(memoryPt, 0n, 4n)

    const resultPts = placementManager.placeComposition('MemoryView', operands)
    const steps = placementManager.placements.slice(6)

    expect(steps).toHaveLength(2)
    expect(steps[0]!.inPts.slice(3).map(({ value }) => value)).toEqual([0n, 0n])
    expect(steps[1]!.inPts.slice(3).map(({ source, wireIndex }) => [source, wireIndex]))
      .toEqual([[6, 0], [6, 1]])
    expect(resultPts).toEqual(steps[1]!.outPts.slice(0, 1))
  })

  it('supports left and right shifts at magnitudes zero and 31', () => {
    const { placementManager } = createHarness()
    const highByte = 0xabn << 248n
    const views = [
      [dataPt(0xabn, 0), dataPt(0n, 5, 0, UINT32_DATA_PT_TYPE), dataPt(1n, 5, 1, UINT32_DATA_PT_TYPE)],
      [dataPt(0xabn, 0), dataPt(31n, 5, 2, UINT32_DATA_PT_TYPE), dataPt(1n << 31n, 5, 3, UINT32_DATA_PT_TYPE)],
      [dataPt(0xabn, 0), dataPt(32n, 5, 4, UINT32_DATA_PT_TYPE), dataPt(1n, 5, 5, UINT32_DATA_PT_TYPE)],
      [dataPt(highByte, 0), dataPt(63n, 5, 6, UINT32_DATA_PT_TYPE), dataPt(1n, 5, 7, UINT32_DATA_PT_TYPE)],
    ]

    const resultPts = placementManager.placeComposition('MemoryView', views)

    expect(resultPts.map(({ value }) => value)).toEqual([0xabn, highByte, 0xabn, 0xabn])
    expect(placementManager.placements.slice(6)).toHaveLength(4)
  })

  it('keeps all-zero and empty view lists placement-free', () => {
    const { placementManager } = createHarness()

    const zeroResults = placementManager.placeComposition('MemoryView', [[], []])
    expect(zeroResults).toMatchObject([{ value: 0n }, { value: 0n }])
    expect(placementManager.placeComposition('MemoryView', [])).toEqual([])
    expect(placementManager.placements).toHaveLength(6)
  })

  it('keeps multiple views in source order with monotonically advancing outputs', () => {
    const { contextManager, placementManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 32, wordPt(1n, 1))
    memoryPt.write(32, 32, wordPt(2n, 2))
    const operands = contextManager.createMemoryOperands(memoryPt, 0n, 64n)

    const resultPts = placementManager.placeComposition('MemoryView', operands)
    const steps = placementManager.placements.slice(6)

    expect(steps.map(({ inPts }) => inPts[0]!.source)).toEqual([1, 2])
    expect(resultPts.map(({ source, wireIndex }) => [source, wireIndex]))
      .toEqual([[6, 0], [7, 0]])
  })

  it('rejects a malformed view atomically', () => {
    const { placementManager } = createHarness()
    const malformedView = [[dataPt(1n, 0), dataPt(0n, 5, 0, UINT32_DATA_PT_TYPE)]]

    expect(() => placementManager.placeComposition('MemoryView', malformedView)).toThrow(
      'MemoryView view 0 must contain three inputs per fragment',
    )
    expect(placementManager.placements).toHaveLength(6)
  })

  it('freezes copy source operands and creates compact destination entries', () => {
    const { contextManager, placementManager } = createHarness()
    const memoryPt = new MemoryPt()
    memoryPt.write(0, 32, wordPt(1n, 1))
    memoryPt.write(32, 8, wordPt(2n, 2))
    const copyPlan = contextManager.prepareMemoryCopy(memoryPt, 0n, 40n, 96n)
    memoryPt.write(0, 32, wordPt(3n, 3))

    const resultPts = placementManager.placeComposition('MemoryView', copyPlan.operands)
    const destinationEntries = createMemoryCopyEntries(copyPlan, resultPts)

    expect(placementManager.placements.slice(6).map(({ inPts }) => inPts[0]!.source))
      .toEqual([1, 2])
    expect(destinationEntries).toMatchObject([
      { memByteOffset: 96, containerByteSize: 32, dataPt: { source: 6, wireIndex: 0 } },
      { memByteOffset: 128, containerByteSize: 8, dataPt: { source: 7, wireIndex: 0 } },
    ])
  })
})
