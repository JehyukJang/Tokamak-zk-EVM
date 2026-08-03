import { describe, expect, it, vi } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
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

const createHarness = (
  mutatePlacement?: (placement: Placement, placements: Placement[]) => void,
) => {
  const placements: Placement[] = [];
  let staticWireIndex = 0;
  const subcircuitNames = ['ALU1', 'CheckBus256', 'ADDMOD', 'MULMOD'];
  const parent = {
    placements,
    subcircuitLibrary: {
      arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition({
        nAccumulation: 4,
        nEqualBatch: 2,
        nJubjubExpBatch: 128,
        nPoseidonBatch: 1,
        nSubExpBatch: 32,
      }),
      poseidonBatchSize: 1,
      arithExpBatchSize: 32,
      jubjubExpBatchSize: 128,
    },
    state: {
      subcircuitInfoByName: new Map(
        subcircuitNames.map((name) => [name, { name }]),
      ),
    },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) => ({
      ...dataPt(value, 0, staticWireIndex++),
      sourceBitSize,
    })),
    place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
      const placement = { name, inPts, outPts, usage };
      mutatePlacement?.(placement, placements);
      placements.push(placement);
    }),
  };

  return {
    manager: new ArithmeticManager(parent as never),
    placements,
  };
};

describe('modular CheckBus256 topology', () => {
  it.each([
    ['ADDMOD', 2n],
    ['MULMOD', 5n],
  ] as const)('places CheckBus256 immediately before %s', (operation, expected) => {
    const { manager, placements } = createHarness();
    const firstOperand = dataPt(5n, 10, 3);

    const result = manager.placeArith(operation, [
      firstOperand,
      dataPt(7n, 11),
      dataPt(10n, 12),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(expected);
    expect(result[0].source).toBe(1);
    expect(placements.map(({ name }) => name)).toEqual(['CheckBus256', operation]);
    expect(placements[0].inPts).toHaveLength(1);
    expect(placements[0].outPts).toHaveLength(0);
    expect(placements[0].inPts[0]).toMatchObject({ source: 10, wireIndex: 3 });
    expect(placements[1].inPts).toHaveLength(4);
    expect(placements[1].outPts).toHaveLength(1);
    expect(placements[1].inPts[0].value).toBe(operation === 'ADDMOD' ? 1n << 8n : 1n << 9n);
    expect(placements[1].inPts[1]).toMatchObject({ source: 10, wireIndex: 3 });
  });

  it('does not add CheckBus256 to an ordinary arithmetic placement', () => {
    const { manager, placements } = createHarness();

    manager.placeArith('ADD', [dataPt(1n, 10), dataPt(2n, 11)]);

    expect(placements.map(({ name }) => name)).toEqual(['ALU1']);
  });

  it('rejects a non-adjacent modular check placement', () => {
    const { manager } = createHarness((placement, placements) => {
      if (placement.name === 'ADDMOD') {
        placements.push({ name: 'ALU1', inPts: [], outPts: [], usage: 'ADD' });
      }
    });

    expect(() => manager.placeArith('ADDMOD', [
      dataPt(5n, 10),
      dataPt(7n, 11),
      dataPt(10n, 12),
    ])).toThrow('Invalid CheckBus256 topology for ADDMOD');
  });

  it('rejects an output-producing modular check placement', () => {
    const { manager } = createHarness((placement) => {
      if (placement.name === 'CheckBus256') {
        placement.outPts.push(dataPt(0n, 20));
      }
    });

    expect(() => manager.placeArith('MULMOD', [
      dataPt(5n, 10),
      dataPt(7n, 11),
      dataPt(10n, 12),
    ])).toThrow('Invalid CheckBus256 topology for MULMOD');
  });

  it('rejects a modular check placement with more than one input', () => {
    const { manager } = createHarness((placement) => {
      if (placement.name === 'CheckBus256') {
        placement.inPts.push(dataPt(0n, 20));
      }
    });

    expect(() => manager.placeArith('ADDMOD', [
      dataPt(5n, 10),
      dataPt(7n, 11),
      dataPt(10n, 12),
    ])).toThrow('Invalid CheckBus256 topology for ADDMOD');
  });

  it('rejects a different first-operand wire on the modular placement', () => {
    const { manager } = createHarness((placement) => {
      if (placement.name === 'ADDMOD') {
        placement.inPts[1] = dataPt(5n, 99, 4);
      }
    });

    expect(() => manager.placeArith('ADDMOD', [
      dataPt(5n, 10, 3),
      dataPt(7n, 11),
      dataPt(10n, 12),
    ])).toThrow('CheckBus256 operand mismatch for ADDMOD');
  });

  it('rejects a modular operation without exactly three operands', () => {
    const { manager, placements } = createHarness();

    expect(() => manager.placeArith('MULMOD', [
      dataPt(5n, 10),
      dataPt(7n, 11),
    ])).toThrow('MULMOD expected 3 operands, but got 2');
    expect(placements).toHaveLength(0);
  });
});
