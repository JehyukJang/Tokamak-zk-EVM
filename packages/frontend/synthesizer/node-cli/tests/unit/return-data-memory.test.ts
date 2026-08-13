import { describe, expect, it, vi } from 'vitest';

import { BUFFER_LIST } from '../../../core/src/subcircuit/configuredTypes.ts';
import { createMemoryLoadCompositionMapping } from '../../../core/src/subcircuit/special-builders/memoryLoadComposition.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { MemoryPt } from '../../../core/src/synthesizer/dataStructure/memoryPt.ts';
import { StackPt } from '../../../core/src/synthesizer/dataStructure/stackPt.ts';
import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import { ContextManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import { SubcircuitOutputCalculator } from '../../../core/src/synthesizer/handlers/subcircuitOutputCalculator.ts';
import {
  UINT256_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';

const memoryLoadComposition = createMemoryLoadCompositionMapping().composition
const evmInSource = BUFFER_LIST.indexOf('EVM_IN')

const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
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

const createContext = () => new ContextManager({
  callerPt: dataPt(1n, 1),
  codeAddressPt: dataPt(2n, 2),
  storageAddressPt: dataPt(3n, 3),
  callDataMemoryPts: [],
  callDataByteLength: 0,
})

const createHarness = () => {
  let staticWireIndex = 0
  const outputCalculator = new SubcircuitOutputCalculator()
  const parent = {
    placements: Array.from({ length: 6 }, () => ({})),
    subcircuitLibrary: {
      placementCompositionManager: { get: () => memoryLoadComposition },
      subcircuitInfoByName: new Map([['MemoryLoadStep', memoryLoadInfo]]),
    },
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, evmInSource, staticWireIndex++, dataPtType)),
    calculateSubcircuitOutputValues: outputCalculator.calculateSubcircuitOutputValues.bind(outputCalculator),
    placeComposition: vi.fn(),
  }
  return { handler: new InstructionHandler(parent as never, {} as never, {} as never), parent }
}

const stackFor = (inputs: bigint[]): StackPt => {
  const stack = new StackPt()
  for (const value of inputs.slice().reverse()) {
    stack.push(dataPt(value, 20 + stack.length))
  }
  return stack
}

describe('RETURNDATACOPY memory flow', () => {
  it('copies the requested returndata view into the requested destination offset', () => {
    const { handler, parent } = createHarness()
    const context = createContext()
    context.returnDataMemoryPts = [{
      memByteOffset: 0,
      containerByteSize: 4,
      dataPt: dataPt(0x11223344n, 1),
    }]
    context.returnDataByteLength = 4
    const memoryPt = new MemoryPt()
    const stackPt = stackFor([8n, 0n, 4n])

    handler.handleEnvInf([8n, 0n, 4n], null, {
      op: 'RETURNDATACOPY',
      pc: 0n,
      thisAddress: {} as never,
      codeAddress: {} as never,
      originAddress: {} as never,
      callerAddress: {} as never,
      callDepth: 0,
      thisContext: context,
      prevStepResult: {} as never,
      stackPt,
      memoryPt,
      memOut: new Uint8Array([0x11, 0x22, 0x33, 0x44]),
    })

    expect(parent.placeComposition).toHaveBeenCalledOnce()
    expect(memoryPt.viewMemory(8, 4)).toEqual(new Uint8Array([0x11, 0x22, 0x33, 0x44]))
  })

  it('rejects a returndata range beyond the child result before recording a composition', () => {
    const { handler, parent } = createHarness()
    const context = createContext()
    context.returnDataMemoryPts = [{
      memByteOffset: 0,
      containerByteSize: 4,
      dataPt: dataPt(0x11223344n, 1),
    }]
    context.returnDataByteLength = 4
    const memoryPt = new MemoryPt()

    expect(() => handler.handleEnvInf([0n, 0n, 5n], null, {
      op: 'RETURNDATACOPY',
      pc: 0n,
      thisAddress: {} as never,
      codeAddress: {} as never,
      originAddress: {} as never,
      callerAddress: {} as never,
      callDepth: 0,
      thisContext: context,
      prevStepResult: {} as never,
      stackPt: stackFor([0n, 0n, 5n]),
      memoryPt,
      memOut: new Uint8Array(5),
    })).toThrow('RETURNDATACOPY: requested range exceeds return data')
    expect(parent.placeComposition).not.toHaveBeenCalled()
    expect(memoryPt.viewMemory(0, 5)).toEqual(new Uint8Array(5))
  })
})
