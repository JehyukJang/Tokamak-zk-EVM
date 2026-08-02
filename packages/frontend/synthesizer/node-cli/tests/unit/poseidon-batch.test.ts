import { poseidonChainCompress } from 'tokamak-l2js';
import { describe, expect, it, vi } from 'vitest';

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

  it('uses the configured batch size for selector generation and padding', () => {
    const { manager, placements } = createHarness(4);
    const inputs = [dataPt(1n), dataPt(2n), dataPt(3n)];

    const result = manager.placePoseidon(inputs);

    expect(result.value).toBe(poseidonChainCompress(inputs.map(input => input.value)));
    expect(placements).toHaveLength(1);
    expect(placements[0].name).toBe('Poseidon');
    expect(placements[0].inPts.map(input => input.value)).toEqual([2n, 1n, 2n, 3n, 0n, 0n]);
  });

  it('chunks a chain at the configured number of Poseidon calls', () => {
    const { manager, placements } = createHarness(3);
    const inputs = [1n, 2n, 3n, 4n, 5n, 6n].map(value => dataPt(value));

    const result = manager.placePoseidon(inputs);

    expect(result.value).toBe(poseidonChainCompress(inputs.map(input => input.value)));
    expect(placements).toHaveLength(2);
    expect(placements[0].inPts[0].value).toBe(4n);
    expect(placements[1].inPts.map(input => input.value)).toEqual([2n, placements[0].outPts[0].value, 5n, 6n, 0n]);
  });
});
