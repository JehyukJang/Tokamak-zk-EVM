import { describe, expect, it, vi } from 'vitest';

import {
  SUBCIRCUIT_ALU_MAPPING,
  SUBCIRCUIT_LIST,
} from '../../../core/src/subcircuit/configuredTypes.ts';
import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

type Placement = {
  name: string;
  inPts: DataPt[];
  outPts: DataPt[];
  usage: string;
};

type DivisionOperation = 'DIV' | 'SDIV' | 'MOD' | 'SMOD';

const UINT256_MASK = (1n << 256n) - 1n;

const dataPt = (value: bigint, source: number, wireIndex = 0): DataPt => ({
  source,
  wireIndex,
  sourceBitSize: 256,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const circuitWireCount = (dataPts: DataPt[]): number => dataPts.reduce(
  (count, point) => count + (point.sourceBitSize > 128 ? 2 : 1),
  0,
);

const createHarness = (
  mutatePlacement?: (placement: Placement, placements: Placement[]) => void,
  interfaces: { first: [number, number]; second: [number, number] } = {
    first: [5, 13],
    second: [13, 2],
  },
) => {
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
      subcircuitInfoByName: new Map([
        ['ALU1', { name: 'ALU1', NInWires: 5, NOutWires: 2 }],
        ['ALU4A', {
          name: 'ALU4A',
          NInWires: interfaces.first[0],
          NOutWires: interfaces.first[1],
        }],
        ['ALU4B', {
          name: 'ALU4B',
          NInWires: interfaces.second[0],
          NOutWires: interfaces.second[1],
        }],
      ]),
    },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) => ({
      ...dataPt(value, 5, staticWireIndex++),
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

describe('division-family topology', () => {
  it('uses the production pair for all four division operations', () => {
    expect(SUBCIRCUIT_LIST).not.toContain('ALU4');
    expect(SUBCIRCUIT_LIST).not.toContain('ALU5');
    expect(SUBCIRCUIT_LIST.slice(13, 15)).toEqual(['ALU4A', 'ALU4B']);

    for (const operation of ['DIV', 'SDIV', 'MOD', 'SMOD'] as const) {
      expect(SUBCIRCUIT_ALU_MAPPING[operation][0]).toBe('ALU4A');
    }
  });

  it.each([
    ['DIV', 13n, 5n, 2n, 0n, 0n],
    ['MOD', 13n, 5n, 3n, 0n, 1n],
    ['SDIV', BigInt.asUintN(256, -13n), 5n, BigInt.asUintN(256, -2n), 1n, 0n],
    ['SDIV', BigInt.asUintN(256, -13n), BigInt.asUintN(256, -5n), 2n, 0n, 0n],
    ['SDIV', 13n, BigInt.asUintN(256, -5n), BigInt.asUintN(256, -2n), 1n, 0n],
    ['SMOD', BigInt.asUintN(256, -13n), 5n, BigInt.asUintN(256, -3n), 1n, 1n],
    ['SMOD', 13n, BigInt.asUintN(256, -5n), 3n, 0n, 1n],
  ] as const)(
    'places the exact ALU4A-to-ALU4B bridge for %s',
    (operation, dividend, divisor, expected, resultIsNegative, useMod) => {
      const { manager, placements } = createHarness();
      const dividendPt = dataPt(dividend, 10, 3);
      const divisorPt = dataPt(divisor, 11, 4);

      const result = manager.placeArith(operation, [dividendPt, divisorPt]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        value: expected,
        source: 1,
        wireIndex: 0,
        sourceBitSize: 256,
      });
      expect(placements.map(({ name }) => name)).toEqual(['ALU4A', 'ALU4B']);
      expect(placements.map(({ usage }) => usage)).toEqual([operation, operation]);

      const first = placements[0];
      const second = placements[1];
      expect(first.inPts[0].value).toBe(SUBCIRCUIT_ALU_MAPPING[operation][1]);
      expect(first.inPts[1]).toMatchObject({ source: 10, wireIndex: 3 });
      expect(first.inPts[2]).toMatchObject({ source: 11, wireIndex: 4 });
      expect(first.outPts.map(({ value }) => value)).toEqual([
        13n,
        2n,
        3n,
        5n,
        0n,
        0n,
        0n,
        0n,
        resultIsNegative,
        useMod,
      ]);
      expect(first.outPts.map(({ sourceBitSize }) => sourceBitSize)).toEqual([
        256, 256, 256, 64, 64, 64, 64, 1, 1, 1,
      ]);
      expect(circuitWireCount(first.inPts)).toBe(5);
      expect(circuitWireCount(first.outPts)).toBe(13);
      expect(circuitWireCount(second.inPts)).toBe(13);
      expect(circuitWireCount(second.outPts)).toBe(2);

      for (let index = 0; index < first.outPts.length; index++) {
        expect(first.outPts[index]).toMatchObject({ source: 0, wireIndex: index });
        expect(second.inPts[index]).toMatchObject({
          source: first.outPts[index].source,
          wireIndex: first.outPts[index].wireIndex,
          sourceBitSize: first.outPts[index].sourceBitSize,
        });
      }
    },
  );

  it('uses the safe internal divisor witness and publishes zero for division by zero', () => {
    const { manager, placements } = createHarness();

    const result = manager.placeArith('SDIV', [
      dataPt(BigInt.asUintN(256, -13n), 10),
      dataPt(0n, 11),
    ]);

    expect(result[0].value).toBe(0n);
    expect(placements[0].outPts.map(({ value }) => value)).toEqual([
      13n,
      13n,
      0n,
      0n,
      0n,
      0n,
      0n,
      1n,
      1n,
      0n,
    ]);
  });

  it('expands the logical bridge into thirteen exactly connected circuit wires', () => {
    const { manager, placements } = createHarness();
    manager.placeArith('DIV', [
      dataPt(13n, 0, 1),
      dataPt(5n, 0, 2),
    ]);
    placements[0].inPts[0] = {
      ...placements[0].inPts[0],
      source: 0,
    };

    const generator = new VariableGenerator({} as never);
    (
      generator as unknown as {
        _convertEVMWiresIntoCircomWires(placements: Placement[]): void;
      }
    )._convertEVMWiresIntoCircomWires(placements);

    expect(placements[0].inPts).toHaveLength(5);
    expect(placements[0].outPts).toHaveLength(13);
    expect(placements[1].inPts).toHaveLength(13);
    expect(placements[1].outPts).toHaveLength(2);
    expect(placements[0].outPts.map(({ value }) => value)).toEqual([
      13n, 0n,
      2n, 0n,
      3n, 0n,
      5n, 0n, 0n, 0n,
      0n, 0n, 0n,
    ]);
    for (let wireIndex = 0; wireIndex < 13; wireIndex++) {
      expect(placements[0].outPts[wireIndex]).toMatchObject({
        source: 0,
        wireIndex,
      });
      expect(placements[1].inPts[wireIndex]).toEqual(placements[0].outPts[wireIndex]);
    }
  });

  it.each(Array.from({ length: 10 }, (_, index) => index))(
    'rejects replacement of bridge DataPt %i',
    (bridgeIndex) => {
      const { manager } = createHarness((placement) => {
        if (placement.name === 'ALU4B') {
          placement.inPts[bridgeIndex] = {
            ...placement.inPts[bridgeIndex],
            source: 99,
          };
        }
      });

      expect(() => manager.placeArith('DIV', [
        dataPt(13n, 10),
        dataPt(5n, 11),
      ])).toThrow('ALU4A/ALU4B bridge mismatch for DIV');
    },
  );

  it('rejects a non-adjacent pair', () => {
    const { manager } = createHarness((placement, placements) => {
      if (placement.name === 'ALU4B') {
        placements.push({ name: 'ALU1', inPts: [], outPts: [], usage: 'ADD' });
      }
    });

    expect(() => manager.placeArith('MOD', [
      dataPt(13n, 10),
      dataPt(5n, 11),
    ])).toThrow('Invalid ALU4A/ALU4B topology for MOD');
  });

  it('rejects replacement of an original ALU4A operand', () => {
    const { manager } = createHarness((placement) => {
      if (placement.name === 'ALU4A') {
        placement.inPts[1] = dataPt(13n, 99, 4);
      }
    });

    expect(() => manager.placeArith('SDIV', [
      dataPt(13n, 10, 3),
      dataPt(5n, 11),
    ])).toThrow('ALU4A operand mismatch for SDIV');
  });

  it('rejects using an ALU4A intermediate as the final result', () => {
    const { manager } = createHarness((placement) => {
      if (placement.name === 'ALU4B') {
        placement.outPts[0] = {
          ...placement.outPts[0],
          source: 0,
        };
      }
    });

    expect(() => manager.placeArith('SMOD', [
      dataPt(13n, 10),
      dataPt(5n, 11),
    ])).toThrow('ALU4B result mismatch for SMOD');
  });

  it('rejects a malformed production interface before placing either part', () => {
    const { manager, placements } = createHarness(undefined, {
      first: [5, 12],
      second: [13, 2],
    });

    expect(() => manager.placeArith('SMOD', [
      dataPt(UINT256_MASK, 10),
      dataPt(5n, 11),
    ])).toThrow('Invalid ALU4A/ALU4B subcircuit interface');
    expect(placements).toHaveLength(0);
  });

  it('rejects a division operation without exactly two operands', () => {
    const { manager, placements } = createHarness();

    expect(() => manager.placeArith('DIV', [dataPt(13n, 10)]))
      .toThrow('DIV requires exactly two operands');
    expect(placements).toHaveLength(0);
  });
});
