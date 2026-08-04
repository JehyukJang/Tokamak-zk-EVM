import { describe, expect, it, vi } from 'vitest';

import { PermutationGenerator } from '../../../core/src/circuitGenerator/handlers/permutationGenerator.ts';
import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import type { SubcircuitInfoByNameEntry } from '../../../core/src/subcircuit/configuredTypes.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';
import type {
  Placements,
  PlacementVariables,
} from '../../../core/src/synthesizer/types/placements.ts';

const BUFFER_SUBCIRCUITS = [
  'bufferLogOut',
  'bufferStorageStore',
  'bufferStorageLoad',
  'bufferTxIn',
  'bufferBlockIn',
  'bufferEVMIn',
  'bufferPrvIn',
] as const;

const dataPt = (
  value: bigint,
  source: number,
  wireIndex: number,
  sourceBitSize: number,
): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createLogicalPlacements = (): Placements => {
  const placements: Placements = BUFFER_SUBCIRCUITS.map((name, subcircuitId) => ({
    name,
    usage: name,
    subcircuitId,
    inPts: [],
    outPts: [],
  }));

  placements[5]!.outPts = [dataPt(1n, 5, 0, 1)];

  const dividend = dataPt(7n, 6, 0, 256);
  const divisor = dataPt(3n, 6, 1, 256);
  placements[6]!.outPts = [dividend, divisor];
  const subcircuitInfoByName = new Map([
    ['ALU4A', { id: 7, name: 'ALU4A', NInWires: 5, NOutWires: 13 }],
    ['ALU4B', { id: 8, name: 'ALU4B', NInWires: 13, NOutWires: 2 }],
  ]);
  const parent = {
    placements,
    subcircuitLibrary: {
      arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition({
        nAccumulation: 4,
        nEqualBatch: 2,
        nJubjubExpBatch: 4,
        nPoseidonBatch: 1,
        nSubExpBatch: 8,
      }),
      poseidonBatchSize: 1,
      arithExpBatchSize: 8,
      jubjubExpBatchSize: 4,
    },
    state: { subcircuitInfoByName },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) => {
      const point = dataPt(value, 5, placements[5]!.outPts.length, sourceBitSize);
      placements[5]!.outPts.push(point);
      return point;
    }),
    place: vi.fn((
      name: 'ALU4A' | 'ALU4B',
      inPts: DataPt[],
      outPts: DataPt[],
      usage: string,
    ) => {
      placements.push({
        name,
        usage,
        subcircuitId: subcircuitInfoByName.get(name)!.id,
        inPts,
        outPts,
      });
    }),
  };
  new ArithmeticManager(parent as never).placeArithComposition(
    'DIV',
    [dividend, divisor],
  );
  return placements;
};

const convertToCircuitWires = (placements: Placements): void => {
  const generator = new VariableGenerator({} as never);
  (generator as unknown as {
    _convertEVMWiresIntoCircomWires(placements: Placements): void;
  })._convertEVMWiresIntoCircomWires(placements);
};

const assertExactDivisionBridge = (placements: Placements): void => {
  const first = placements[7]!;
  const second = placements[8]!;
  expect(first.outPts).toHaveLength(13);
  expect(second.inPts).toHaveLength(13);
  expect(first.outPts.map(({ value }) => value)).toEqual([
    7n, 0n,
    2n, 0n,
    1n, 0n,
    3n, 0n, 0n, 0n,
    0n, 0n, 0n,
  ]);
  for (let wireIndex = 0; wireIndex < 13; wireIndex++) {
    expect(second.inPts[wireIndex]).toBe(first.outPts[wireIndex]);
    expect(second.inPts[wireIndex]).toMatchObject({
      source: 7,
      wireIndex,
    });
  }
};

const createPermutation = (placements: Placements) => {
  const physicalInterfaces = [
    ...BUFFER_SUBCIRCUITS.map((name) => ({
      name,
      NInWires: 0,
      NOutWires: name === 'bufferEVMIn'
        ? 2
        : name === 'bufferPrvIn'
          ? 4
          : 0,
    })),
    { name: 'ALU4A' as const, NInWires: 5, NOutWires: 13 },
    { name: 'ALU4B' as const, NInWires: 13, NOutWires: 2 },
  ];
  let nextGlobalWire = 0;
  const subcircuitInfoByName = new Map<string, SubcircuitInfoByNameEntry>();
  for (const [id, subcircuit] of physicalInterfaces.entries()) {
    const NWires = 1 + subcircuit.NOutWires + subcircuit.NInWires;
    const flattenMap = Array.from(
      { length: NWires },
      () => nextGlobalWire++,
    );
    subcircuitInfoByName.set(subcircuit.name, {
      id,
      name: subcircuit.name,
      NWires,
      outWireIndex: 1,
      NOutWires: subcircuit.NOutWires,
      inWireIndex: 1 + subcircuit.NOutWires,
      NInWires: subcircuit.NInWires,
      flattenMap,
    });
  }

  const placementVariables: PlacementVariables = placements.map((placement) => ({
    subcircuitId: placement.subcircuitId,
    variables: [
      1n,
      ...placement.outPts.map(({ value }) => value),
      ...placement.inPts.map(({ value }) => value),
    ]
      .map((value) => `0x${value.toString(16)}`),
    instanceList: [],
  }));
  const parent = {
    circuitPlacements: placements,
    variableGenerator: { placementVariables },
    subcircuitLibrary: {
      data: {
        setupParams: {
          l: 0,
          l_D: nextGlobalWire,
        },
      },
      subcircuitInfoByName,
    },
  };

  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    return {
      permutation: new PermutationGenerator(parent as never).permutation,
      subcircuitInfoByName,
    };
  } finally {
    log.mockRestore();
  }
};

describe('division-family physical permutation', () => {
  it('connects every split ALU4A output to the matching ALU4B input', () => {
    const placements = createLogicalPlacements();
    convertToCircuitWires(placements);
    assertExactDivisionBridge(placements);

    const { permutation, subcircuitInfoByName } = createPermutation(placements);
    const firstInfo = subcircuitInfoByName.get('ALU4A')!;
    const secondInfo = subcircuitInfoByName.get('ALU4B')!;
    for (let wireIndex = 0; wireIndex < 13; wireIndex++) {
      expect(permutation).toContainEqual({
        row: firstInfo.flattenMap[firstInfo.outWireIndex + wireIndex],
        col: 7,
        X: secondInfo.flattenMap[secondInfo.inWireIndex + wireIndex],
        Y: 8,
      });
    }
  });

  it.each(['source', 'wireIndex', 'sourceBitSize'] as const)(
    'detects a bridge %s mutation in the generated physical topology',
    (mutation) => {
      const placements = createLogicalPlacements();
      if (mutation === 'source') {
        placements[8]!.inPts[0] = {
          ...placements[8]!.inPts[0]!,
          source: 6,
          wireIndex: 0,
        };
      } else if (mutation === 'wireIndex') {
        placements[8]!.inPts[0] = {
          ...placements[8]!.inPts[0]!,
          wireIndex: 1,
        };
      } else {
        placements[7]!.outPts[0]!.sourceBitSize = 128;
      }

      convertToCircuitWires(placements);
      expect(() => assertExactDivisionBridge(placements)).toThrow();
    },
  );
});
