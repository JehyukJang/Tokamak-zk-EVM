import { describe, expect, it, vi } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import {
  EVM_WORD_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';

const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
  dataPtType: DataPtType = EVM_WORD_DATA_PT_TYPE,
): DataPt => ({
  source,
  wireIndex,
  dataPtType,
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
        }),
        poseidonBatchSize: 6,
        jubjubExpBatchSize: 4,
      },
      state: {
        subcircuitInfoByName: new Map(
          [
            ['DecToBit', { name: 'DecToBit', NInWires: 2, NOutWires: 256 }],
            ['SubExp', { name: 'SubExp', NInWires: 5, NOutWires: 4 }],
            ['CheckBus256', { name: 'CheckBus256', NInWires: 2, NOutWires: 2 }],
          ],
        ),
      },
      loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
        dataPt(value, 0, staticWireIndex++, dataPtType),
      ),
      place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
        placements.push({ name, inPts, outPts, usage });
      }),
    };
    const manager = new ArithmeticManager(parent as never);

    const [result] = manager.placeArithComposition('EXP', [
      dataPt(3n, 10),
      dataPt(5n, 11),
    ]);

    expect(result.value).toBe(243n);
    expect(placements).toHaveLength(258);
    expect(placements[0].name).toBe('DecToBit');
    expect(placements.slice(1, -1).every(({ name }) => name === 'SubExp')).toBe(true);
    expect(placements.at(-1)?.name).toBe('CheckBus256');
    expect(placements[2].inPts[0]).toMatchObject({ source: 1, wireIndex: 0 });
    expect(placements[2].inPts[1]).toMatchObject({ source: 1, wireIndex: 1 });
    expect(result).toMatchObject({ source: 257, wireIndex: 0 });
  });

  it.each([
    ['DIV', 7n, 3n, 2n],
    ['DIV', 7n, 0n, 0n],
    ['MOD', 7n, 3n, 1n],
    ['SDIV', BigInt.asUintN(256, -7n), 3n, BigInt.asUintN(256, -2n)],
    [
      'SDIV',
      1n << 255n,
      BigInt.asUintN(256, -1n),
      1n << 255n,
    ],
    ['SMOD', BigInt.asUintN(256, -7n), 3n, BigInt.asUintN(256, -1n)],
  ] as const)(
    'routes %s through the declared ALU4A and ALU4B bridge',
    (operation, dividend, divisor, expected) => {
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
            nPoseidonBatch: 1,
          }),
          poseidonBatchSize: 1,
          jubjubExpBatchSize: 4,
        },
        state: {
          subcircuitInfoByName: new Map(
            [
              ['ALU4A', { name: 'ALU4A', NInWires: 5, NOutWires: 13 }],
              ['ALU4B', { name: 'ALU4B', NInWires: 13, NOutWires: 2 }],
            ],
          ),
        },
        loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) =>
          dataPt(value, -1, staticWireIndex++, dataPtType),
        ),
        place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
          placements.push({ name, inPts, outPts, usage });
        }),
      };
      const manager = new ArithmeticManager(parent as never);

      const [result] = manager.placeArithComposition(operation, [
        dataPt(dividend, 10),
        dataPt(divisor, 11),
      ]);

      expect(result.value).toBe(expected);
      expect(placements.map(({ name }) => name)).toEqual(['ALU4A', 'ALU4B']);
      expect(placements.map(({ usage }) => usage)).toEqual([operation, operation]);
      expect(placements[0].outPts.map(({ dataPtType }) => (
        dataPtType.valueDomain.kind === 'uint'
          ? dataPtType.valueDomain.bits
          : undefined
      ))).toEqual([
        256, 256, 256, 64, 64, 64, 64, 1, 1, 1,
      ]);
      expect(placements[1].inPts).toEqual(placements[0].outPts);
      expect(result).toMatchObject({
        source: 1,
        wireIndex: 0,
        dataPtType: EVM_WORD_DATA_PT_TYPE,
      });
    },
  );
});
