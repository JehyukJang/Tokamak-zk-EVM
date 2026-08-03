import { describe, expect, it, vi } from 'vitest';

import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import { StateManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

const dataPt = (value: bigint, source = 1, wireIndex = 0): DataPt => ({
  source,
  wireIndex,
  sourceBitSize: 256,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createHarness = () => {
  const placements: Array<{
    name: string;
    inPts: DataPt[];
    outPts: DataPt[];
    usage: string;
  }> = [];
  const subcircuitNames = ['ADD', 'ADDMOD', 'MULMOD', 'SHL', 'SHR', 'SAR', 'BYTE', 'SIGNEXTEND', 'CheckBus'];
  const parent = {
    placements,
    subcircuitLibrary: {
      poseidonBatchSize: 3,
      arithExpBatchSize: 16,
      jubjubExpBatchSize: 75,
    },
    state: {
      subcircuitInfoByName: new Map(subcircuitNames.map(name => [name, { name }])),
    },
    loadArbitraryStatic: vi.fn(),
    place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({ name, inPts, outPts, usage });
    }),
  };

  return {
    manager: new ArithmeticManager(parent as never),
    placements,
  };
};

describe('per-operation arithmetic subcircuit placement', () => {
  it('places an ordinary operation directly without an ALU selector', () => {
    const { manager, placements } = createHarness();
    const inputs = [dataPt(3n), dataPt(5n)];

    const [result] = manager.placeArith('ADD', inputs);

    expect(result.value).toBe(8n);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      name: 'ADD',
      usage: 'ADD',
      inPts: inputs,
    });
  });

  it.each(['ADDMOD', 'MULMOD'] as const)('places CheckBus on the first operand immediately before %s', operation => {
    const { manager, placements } = createHarness();
    const inputs = [dataPt(7n, 1, 0), dataPt(11n, 1, 1), dataPt(13n, 1, 2)];

    const [result] = manager.placeArith(operation, inputs);

    expect(result.value).toBe(operation === 'ADDMOD' ? 5n : 12n);
    expect(placements.map(placement => placement.name)).toEqual(['CheckBus', operation]);
    expect(placements[0]).toMatchObject({
      usage: 'CheckBus',
      inPts: [inputs[0]],
      outPts: [],
    });
    expect(placements[1].inPts).toEqual(inputs);
    expect(placements[1].outPts[0].source).toBe(1);
  });

  it('rejects a modular placement that bypasses the matching CheckBus', () => {
    const state = new StateManager({
      subcircuitLibrary: {
        subcircuitInfoByName: new Map([
          ['CheckBus', { id: 1 }],
          ['ADDMOD', { id: 2 }],
        ]),
      },
    } as never);
    const inputs = [dataPt(7n, 1, 0), dataPt(11n, 1, 1), dataPt(13n, 1, 2)];
    const output = dataPt(5n, 2);

    expect(() => state.place('ADDMOD', inputs, [output], 'ADDMOD')).toThrow(
      'ADDMOD must immediately follow CheckBus for its first operand',
    );

    state.place('CheckBus', [inputs[1]], [], 'CheckBus');
    expect(() => state.place('ADDMOD', inputs, [output], 'ADDMOD')).toThrow(
      'ADDMOD must immediately follow CheckBus for its first operand',
    );

    state.place('CheckBus', [inputs[0]], [], 'CheckBus');
    expect(() => state.place('ADDMOD', inputs, [output], 'ADDMOD')).not.toThrow();
  });

  it.each([
    ['SHL', [256n, 1n], 0n],
    ['SHR', [1n << 200n, 1n], 0n],
    ['SAR', [256n, 1n << 255n], (1n << 256n) - 1n],
    ['BYTE', [32n, (1n << 256n) - 1n], 0n],
    ['SIGNEXTEND', [1n << 200n, 0x80n], 0x80n],
  ] as const)('places full-domain %s inputs without host-side rejection', (operation, values, expected) => {
    const { manager, placements } = createHarness();
    const inputs = values.map(value => dataPt(value));

    const [result] = manager.placeArith(operation, inputs);

    expect(result.value).toBe(expected);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ name: operation, inPts: inputs });
  });
});
