import { describe, expect, it, vi } from 'vitest';

import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

type Placement = {
  name: string;
  inPts: DataPt[];
  outPts: DataPt[];
  usage: string;
};

const dataPt = (value: bigint, source: number, wireIndex = 0): DataPt => ({
  source,
  wireIndex,
  sourceBitSize: 256,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createHarness = () => {
  const placements: Placement[] = [];
  let staticWireIndex = 0;
  const parent = {
    placements,
    subcircuitLibrary: {
      poseidonBatchSize: 1,
      arithExpBatchSize: 32,
      jubjubExpBatchSize: 128,
    },
    state: {
      subcircuitInfoByName: new Map(
        ['BYTE', 'SIGNEXTEND'].map((name) => [name, { name }]),
      ),
    },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) => ({
      ...dataPt(value, 0, staticWireIndex++),
      sourceBitSize,
    })),
    place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({ name, inPts, outPts, usage });
    }),
  };

  return {
    manager: new ArithmeticManager(parent as never),
    placements,
  };
};

describe('full-domain BYTE synthesis', () => {
  it.each([32n, 1n << 128n, (1n << 256n) - 1n])(
    'places BYTE for out-of-range EVM index %s and returns zero',
    (index) => {
      const { manager, placements } = createHarness();
      const indexPt = dataPt(index, 10, 3);
      const valuePt = dataPt((1n << 256n) - 1n, 11, 4);

      const result = manager.placeArith('BYTE', [indexPt, valuePt]);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(0n);
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({ name: 'BYTE', usage: 'BYTE' });
      expect(placements[0].inPts).toHaveLength(3);
      expect(placements[0].inPts[0].value).toBe(1n << 26n);
      expect(placements[0].inPts[1]).toMatchObject({ source: 10, wireIndex: 3 });
      expect(placements[0].inPts[2]).toMatchObject({ source: 11, wireIndex: 4 });
    },
  );

  it('retains the index limit for SIGNEXTEND', () => {
    const { manager, placements } = createHarness();

    expect(() => manager.placeArith('SIGNEXTEND', [
      dataPt(32n, 10),
      dataPt(1n, 11),
    ])).toThrow('Operation SIGNEXTEND has an index or size value greater than 31');
    expect(placements).toHaveLength(0);
  });
});
