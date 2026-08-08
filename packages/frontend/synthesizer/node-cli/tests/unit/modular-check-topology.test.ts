import { describe, expect, it, vi } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';
import { EVM_WORD_DATA_PT_TYPE } from '../../../core/src/synthesizer/types/dataStructure.ts';

type Placement = {
  name: string;
  inPts: DataPt[];
  outPts: DataPt[];
  usage: string;
};

const dataPt = (value: bigint, source: number, wireIndex = 0): DataPt => ({
  source,
  wireIndex,
  dataPtType: EVM_WORD_DATA_PT_TYPE,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createHarness = (alu1Interface = { NInWires: 5, NOutWires: 2 }) => {
  const placements: Placement[] = [];
  let staticWireIndex = 0;
  const subcircuitInfo = [
    ['ALU1', { name: 'ALU1', ...alu1Interface }],
    ['ADDMODPrepare', { name: 'ADDMODPrepare', NInWires: 6, NOutWires: 8 }],
    ['ADDMODVerify', { name: 'ADDMODVerify', NInWires: 10, NOutWires: 2 }],
    ['MULMODPrepare', { name: 'MULMODPrepare', NInWires: 6, NOutWires: 18 }],
    ['MULMODCandidate', { name: 'MULMODCandidate', NInWires: 6, NOutWires: 12 }],
    ['MULMODVerify', { name: 'MULMODVerify', NInWires: 24, NOutWires: 2 }],
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
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType = EVM_WORD_DATA_PT_TYPE) => ({
      ...dataPt(value, 0, staticWireIndex++),
      dataPtType,
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

describe('modular arithmetic topology', () => {
  it('places the two ADDMOD stages with the exact original modulus', () => {
    const { manager, placements } = createHarness();
    const firstOperand = dataPt(5n, 10, 3);
    const secondOperand = dataPt(7n, 11);
    const modulus = dataPt(10n, 12);

    const result = manager.placeArithComposition('ADDMOD', [
      firstOperand,
      secondOperand,
      modulus,
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(2n);
    expect(result[0].source).toBe(1);
    expect(placements.map(({ name }) => name)).toEqual([
      'ADDMODPrepare',
      'ADDMODVerify',
    ]);
    expect(placements[0].inPts).toEqual([firstOperand, secondOperand, modulus]);
    expect(placements[0].outPts).toHaveLength(7);
    expect(placements[1].inPts).toEqual([
      ...placements[0].outPts.slice(0, 3),
      modulus,
      ...placements[0].outPts.slice(3),
    ]);
    expect(placements[1].outPts).toHaveLength(1);
  });

  it('places the three MULMOD stages without a selector', () => {
    const { manager, placements } = createHarness();
    const firstOperand = dataPt(5n, 10, 3);

    const result = manager.placeArithComposition('MULMOD', [
      firstOperand,
      dataPt(7n, 11),
      dataPt(10n, 12),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(5n);
    expect(result[0].source).toBe(2);
    expect(placements.map(({ name }) => name)).toEqual([
      'MULMODPrepare',
      'MULMODCandidate',
      'MULMODVerify',
    ]);
    expect(placements[0].inPts).toHaveLength(3);
    expect(placements[0].inPts[0]).toBe(firstOperand);
    expect(placements[0].outPts).toHaveLength(15);
    expect(placements[1].inPts).toEqual(placements[0].outPts.slice(12, 15));
    expect(placements[1].outPts).toHaveLength(12);
    expect(placements[2].inPts).toEqual([
      ...placements[0].outPts.slice(0, 12),
      ...placements[1].outPts,
    ]);
    expect(placements[2].outPts).toHaveLength(1);
  });

  it('uses one placement for an ordinary arithmetic operation', () => {
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
