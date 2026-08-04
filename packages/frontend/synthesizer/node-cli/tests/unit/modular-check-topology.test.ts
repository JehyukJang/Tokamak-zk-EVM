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

const createHarness = (alu1Interface = { NInWires: 5, NOutWires: 2 }) => {
  const placements: Placement[] = [];
  let staticWireIndex = 0;
  const subcircuitInfo = [
    ['ALU1', { name: 'ALU1', ...alu1Interface }],
    ['CheckBus256', { name: 'CheckBus256', NInWires: 2, NOutWires: 0 }],
    ['ADDMOD', { name: 'ADDMOD', NInWires: 7, NOutWires: 2 }],
    ['MULMOD', { name: 'MULMOD', NInWires: 7, NOutWires: 2 }],
  ] as const;
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
      subcircuitInfoByName: new Map(subcircuitInfo),
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

describe('modular CheckBus256 topology', () => {
  it.each([
    ['ADDMOD', 2n],
    ['MULMOD', 5n],
  ] as const)('places CheckBus256 immediately before %s', (operation, expected) => {
    const { manager, placements } = createHarness();
    const firstOperand = dataPt(5n, 10, 3);

    const result = manager.placeArithComposition(operation, [
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
    expect(placements[0].inPts[0]).toBe(firstOperand);
    expect(placements[1].inPts).toHaveLength(4);
    expect(placements[1].outPts).toHaveLength(1);
    expect(placements[1].inPts[0].value).toBe(operation === 'ADDMOD' ? 1n << 8n : 1n << 9n);
    expect(placements[1].inPts[1]).toBe(firstOperand);
  });

  it('does not add CheckBus256 to an ordinary arithmetic placement', () => {
    const { manager, placements } = createHarness();

    manager.placeArithComposition('ADD', [dataPt(1n, 10), dataPt(2n, 11)]);

    expect(placements.map(({ name }) => name)).toEqual(['ALU1']);
  });

  it('rejects a modular operation without exactly three operands', () => {
    const { manager, placements } = createHarness();

    expect(() => manager.placeArithComposition('MULMOD', [
      dataPt(5n, 10),
      dataPt(7n, 11),
    ])).toThrow('MULMOD expected 3 operands, but got 2');
    expect(placements).toHaveLength(0);
  });

  it.each([
    ['input', { NInWires: 4, NOutWires: 2 }, 'ALU1 expected 4 input wires, but got 5'],
    ['output', { NInWires: 5, NOutWires: 1 }, 'ALU1 expected 1 output wires, but got 2'],
  ] as const)(
    'rejects an incompatible loaded ALU1 %s interface before placement',
    (_target, alu1Interface, expectedError) => {
      const { manager, placements } = createHarness(alu1Interface);

      expect(() => manager.placeArithComposition('ADD', [
        dataPt(1n, 10),
        dataPt(2n, 11),
      ])).toThrow(expectedError);
      expect(placements).toHaveLength(0);
    },
  );
});
