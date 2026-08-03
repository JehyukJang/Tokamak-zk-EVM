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
        ['BYTE', 'SIGNEXTEND', 'SHL', 'ALU6'].map((name) => [name, { name }]),
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

describe('full-domain word operation synthesis', () => {
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

  it.each([32n, 1n << 128n, (1n << 256n) - 1n])(
    'places SIGNEXTEND for out-of-range EVM index %s and preserves the value',
    (index) => {
      const { manager, placements } = createHarness();
      const indexPt = dataPt(index, 10, 3);
      const valuePt = dataPt((1n << 255n) + 0x80n, 11, 4);

      const result = manager.placeArith('SIGNEXTEND', [indexPt, valuePt]);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(valuePt.value);
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({ name: 'SIGNEXTEND', usage: 'SIGNEXTEND' });
      expect(placements[0].inPts).toHaveLength(3);
      expect(placements[0].inPts[0].value).toBe(1n << 11n);
      expect(placements[0].inPts[1]).toMatchObject({ source: 10, wireIndex: 3 });
      expect(placements[0].inPts[2]).toMatchObject({ source: 11, wireIndex: 4 });
    },
  );

  it.each([256n, 1n << 128n, (1n << 256n) - 1n])(
    'places SHL for oversized EVM shift %s and returns zero',
    (shift) => {
      const { manager, placements } = createHarness();
      const shiftPt = dataPt(shift, 10, 3);
      const valuePt = dataPt((1n << 256n) - 1n, 11, 4);

      const result = manager.placeArith('SHL', [shiftPt, valuePt]);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(0n);
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({ name: 'SHL', usage: 'SHL' });
      expect(placements[0].inPts).toHaveLength(3);
      expect(placements[0].inPts[0].value).toBe(1n << 27n);
      expect(placements[0].inPts[1]).toMatchObject({ source: 10, wireIndex: 3 });
      expect(placements[0].inPts[2]).toMatchObject({ source: 11, wireIndex: 4 });
    },
  );

  it.each([256n, 1n << 128n, (1n << 256n) - 1n])(
    'places SHR for oversized EVM shift %s and returns zero',
    (shift) => {
      const { manager, placements } = createHarness();
      const shiftPt = dataPt(shift, 10, 3);
      const valuePt = dataPt((1n << 256n) - 1n, 11, 4);

      const result = manager.placeArith('SHR', [shiftPt, valuePt]);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(0n);
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({ name: 'ALU6', usage: 'SHR' });
      expect(placements[0].inPts).toHaveLength(3);
      expect(placements[0].inPts[0].value).toBe(1n << 28n);
      expect(placements[0].inPts[1]).toMatchObject({ source: 10, wireIndex: 3 });
      expect(placements[0].inPts[2]).toMatchObject({ source: 11, wireIndex: 4 });
    },
  );

  it.each([
    [256n, 'nonnegative', 1n << 254n, 0n],
    [256n, 'negative', 1n << 255n, (1n << 256n) - 1n],
    [1n << 128n, 'nonnegative', 1n << 254n, 0n],
    [1n << 128n, 'negative', 1n << 255n, (1n << 256n) - 1n],
    [(1n << 256n) - 1n, 'nonnegative', 1n << 254n, 0n],
    [(1n << 256n) - 1n, 'negative', 1n << 255n, (1n << 256n) - 1n],
  ])(
    'places SAR for oversized EVM shift %s and %s value',
    (shift, _sign, value, expected) => {
      const { manager, placements } = createHarness();
      const shiftPt = dataPt(shift, 10, 3);
      const valuePt = dataPt(value, 11, 4);

      const result = manager.placeArith('SAR', [shiftPt, valuePt]);

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(expected);
      expect(placements).toHaveLength(1);
      expect(placements[0]).toMatchObject({ name: 'ALU6', usage: 'SAR' });
      expect(placements[0].inPts).toHaveLength(3);
      expect(placements[0].inPts[0].value).toBe(1n << 29n);
      expect(placements[0].inPts[1]).toBe(shiftPt);
      expect(placements[0].inPts[2]).toBe(valuePt);
    },
  );
});
