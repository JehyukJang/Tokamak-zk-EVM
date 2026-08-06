import { describe, expect, it, vi } from 'vitest';
import { poseidonChainCompress } from 'tokamak-l2js';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import {
  EVM_WORD_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';

const SPLIT_FIELD_DATA_PT_TYPE: DataPtType = {
  valueDomain: { kind: 'bls12-381-fr' },
  wireLayout: { kind: 'limbs-128', count: 2 },
};

const dataPt = (
  value: bigint,
  source = 1,
  wireIndex = 0,
  dataPtType = SPLIT_FIELD_DATA_PT_TYPE,
): DataPt => DataPtFactory.create({ source, wireIndex, dataPtType }, value);

const createHarness = (poseidonBatchSize: number) => {
  const placements: Array<{
    name: string;
    inPts: DataPt[];
    outPts: DataPt[];
    usage: string;
  }> = [];
  let staticWireIndex = 0;
  const parent = {
    placements,
    subcircuitLibrary: {
      arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition({
        nAccumulation: 4,
        nEqualBatch: 2,
        nJubjubExpBatch: 128,
        nPoseidonBatch: poseidonBatchSize,
        nSubExpBatch: 32,
      }),
      poseidonBatchSize,
      arithExpBatchSize: 32,
      jubjubExpBatchSize: 128,
    },
    state: {
      subcircuitInfoByName: new Map([[
        'Poseidon',
        {
          name: 'Poseidon',
          NInWires: 1 + 2 * (poseidonBatchSize + 1),
          NOutWires: 2,
        },
      ]]),
    },
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
      dataPt(value, 0, staticWireIndex++, dataPtType),
    ),
    place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({ name, inPts, outPts, usage });
    }),
  };

  return {
    manager: new ArithmeticManager(parent as never),
    placements,
  };
};

describe('configurable Poseidon batching', () => {
  it('rejects a batch size that cannot fit in one unsplit selector wire', () => {
    expect(() => createHarness(129)).toThrow('nPoseidonBatch must be an integer between 1 and 128');
  });

  it('places a normalized dynamic Poseidon step through the composition entry point', () => {
    const { manager, placements } = createHarness(4);
    const inputs = [dataPt(1n), dataPt(2n), dataPt(3n)];

    const [result] = manager.placeArithComposition('Poseidon', inputs);

    expect(placements).toHaveLength(1);
    expect(placements[0].name).toBe('Poseidon');
    expect(placements[0].usage).toBe('Poseidon');
    expect(placements[0].inPts).toHaveLength(6);
    expect(placements[0].outPts).toHaveLength(1);
    expect(result.value).toBe(poseidonChainCompress(inputs.map(({ value }) => value)));
    expect(result.value).toBe(placements[0].outPts[0].value);
    expect(result.dataPtType).toEqual(EVM_WORD_DATA_PT_TYPE);
  });
});
