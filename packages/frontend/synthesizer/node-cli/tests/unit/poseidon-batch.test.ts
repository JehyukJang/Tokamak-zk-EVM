import { describe, expect, it, vi } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

const dataPt = (value: bigint, source = 1, wireIndex = 0, sourceBitSize = 255): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

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
      subcircuitInfoByName: new Map([['Poseidon', { name: 'Poseidon' }]]),
    },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) =>
      dataPt(value, 0, staticWireIndex++, sourceBitSize),
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

  it('rejects execution until dynamic output generation is defined', () => {
    const { manager, placements } = createHarness(4);
    const inputs = [dataPt(1n), dataPt(2n), dataPt(3n)];

    expect(() => manager.placePoseidon(inputs)).toThrow(
      'Poseidon step 0 dynamic output generation is unavailable',
    );
    expect(placements).toHaveLength(0);
  });
});
