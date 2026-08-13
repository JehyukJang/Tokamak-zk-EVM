import { describe, expect, it } from 'vitest';

import { StateManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import {
  UINT160_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { PlacementComposition } from '../../../core/src/subcircuit/placementCompositionManager.ts';

const composition = {
  placementStrategy: 'generic',
  constants: [],
  numSteps: 1,
  numOperands: 2,
  numResults: 1,
  steps: [{
    subcircuit: 'ALU1',
    selector: 1n,
    inputs: [
      { kind: 'selector' },
      { kind: 'operand', index: 0 },
      { kind: 'operand', index: 1 },
    ],
    outputs: [{ kind: 'result', index: 0 }],
  }],
} as const satisfies PlacementComposition;

const createDataPt = (
  dataPtType: DataPtType,
  source: number,
  wireIndex: number,
  value: bigint,
): DataPt => DataPtFactory.create({ dataPtType, source, wireIndex }, value);

function createState(): StateManager {
  return Object.assign(Object.create(StateManager.prototype), {
    _placements: Array.from({ length: 6 }, () => ({
      name: 'ALU1',
      usage: 'test',
      subcircuitId: 0,
      inPts: [],
      outPts: [],
    })),
    subcircuitInfoByName: new Map([['ALU1', {
      id: 0,
      name: 'ALU1',
      NWires: 8,
      NInWires: 5,
      NOutWires: 2,
      inWireIndex: 3,
      outWireIndex: 1,
      flattenMap: [],
      logicalInterface: {
        inputs: [
          { name: 'selector', logicalType: { kind: 'uint', bits: 32 } },
          { name: 'lhs', logicalType: { kind: 'uint', bits: 256 } },
          { name: 'rhs', logicalType: { kind: 'uint', bits: 256 } },
        ],
        outputs: [
          { name: 'result', logicalType: { kind: 'uint', bits: 256 } },
        ],
      },
    }]]),
    _placementCompositionManager: { get: () => composition },
  }) as StateManager;
}

function createPreparedComposition(selectorType = UINT32_DATA_PT_TYPE) {
  const selector = createDataPt(selectorType, 5, 0, 1n)
  const lhs = createDataPt(UINT256_DATA_PT_TYPE, 0, 0, 2n)
  const rhs = createDataPt(UINT256_DATA_PT_TYPE, 1, 0, 3n)
  const result = createDataPt(UINT256_DATA_PT_TYPE, 6, 0, 5n)

  return {
    operation: 'ADD' as const,
    operands: [lhs, rhs],
    resultPts: [result],
    steps: [{ inPts: [selector, lhs, rhs], outPts: [result] }],
  };
}

describe('prepared composition logical ports', () => {
  it('accepts DataPt types that match every qap logical port', () => {
    const state = createState()

    expect(() => state.placeComposition(createPreparedComposition())).not.toThrow()
    expect(state.placements.at(-1)?.usage).toBe('ADD')
  })

  it('rejects a same-width DataPt whose logical port type differs', () => {
    const state = createState()

    expect(() => state.placeComposition(createPreparedComposition(UINT160_DATA_PT_TYPE))).toThrow(
      'ADD ALU1 input port 0 (selector) expected uint32, but got uint160',
    )
  })

  it('does not record a partial composition after a prepared wire is mutated', () => {
    const state = createState()
    const prepared = createPreparedComposition()
    const mutated = {
      ...prepared,
      steps: [{
        ...prepared.steps[0]!,
        outPts: [createDataPt(UINT256_DATA_PT_TYPE, 5, 0, 5n)],
      }],
    }

    expect(() => state.placeComposition(mutated)).toThrow(
      'ADD step 0 output 0 has an invalid placement source',
    )
    expect(state.placements).toHaveLength(6)
  })

  it('does not record a partial composition after a declared operand is replaced', () => {
    const state = createState()
    const prepared = createPreparedComposition()
    const mutated = {
      ...prepared,
      steps: [{
        ...prepared.steps[0]!,
        inPts: [
          prepared.steps[0]!.inPts[0]!,
          createDataPt(UINT256_DATA_PT_TYPE, 4, 0, 2n),
          prepared.steps[0]!.inPts[2]!,
        ],
      }],
    }

    expect(() => state.placeComposition(mutated)).toThrow(
      'ADD step 0 input 1 is not connected to its declared source',
    )
    expect(state.placements).toHaveLength(6)
  })
})
