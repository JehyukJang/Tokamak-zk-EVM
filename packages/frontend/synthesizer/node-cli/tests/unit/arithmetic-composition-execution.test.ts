import { describe, expect, it, vi } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
  sourceBitSize = 256,
): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

describe('arithmetic composition execution', () => {
  it('routes EXP intermediates through the declared step outputs', () => {
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
          nJubjubExpBatch: 4,
          nPoseidonBatch: 6,
          nSubExpBatch: 8,
        }),
        poseidonBatchSize: 6,
        arithExpBatchSize: 8,
        jubjubExpBatchSize: 4,
      },
      state: {
        subcircuitInfoByName: new Map(
          ['DecToBit', 'SubExpBatch'].map((name) => [name, { name }]),
        ),
      },
      loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) =>
        dataPt(value, 0, staticWireIndex++, sourceBitSize),
      ),
      place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
        placements.push({ name, inPts, outPts, usage });
      }),
    };
    const manager = new ArithmeticManager(parent as never);

    const [result] = manager.placeArith('EXP', [
      dataPt(3n, 10),
      dataPt(5n, 11),
    ]);

    expect(result.value).toBe(243n);
    expect(placements).toHaveLength(33);
    expect(placements[0].name).toBe('DecToBit');
    expect(placements.slice(1).every(({ name }) => name === 'SubExpBatch')).toBe(true);
    expect(placements[2].inPts[0]).toMatchObject({ source: 1, wireIndex: 0 });
    expect(placements[2].inPts[1]).toMatchObject({ source: 1, wireIndex: 1 });
    expect(result).toMatchObject({ source: 32, wireIndex: 0 });
  });
});
