import { describe, expect, it, vi } from 'vitest';

import { PermutationGenerator } from '../../../core/src/circuitGenerator/handlers/permutationGenerator.ts';
import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import type { SubcircuitInfoByNameEntry } from '../../../core/src/subcircuit/configuredTypes.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { Placements, PlacementVariables } from '../../../core/src/synthesizer/types/placements.ts';

const BUFFER_SUBCIRCUITS = [
  'bufferLogOut',
  'bufferStorageStore',
  'bufferStorageLoad',
  'bufferTxIn',
  'bufferBlockIn',
  'bufferEVMIn',
  'bufferPrvIn',
] as const;
const EXP_BATCH_SIZE = 8;
const EXP_BATCH_COUNT = 256 / EXP_BATCH_SIZE;
const DEC_TO_BIT_PLACEMENT = BUFFER_SUBCIRCUITS.length;
const FIRST_BATCH_PLACEMENT = DEC_TO_BIT_PLACEMENT + 1;

const dataPt = (value: bigint, source: number, wireIndex: number, sourceBitSize: number): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createLogicalPlacements = (): { placements: Placements; result: DataPt } => {
  const placements: Placements = BUFFER_SUBCIRCUITS.map((name, subcircuitId) => ({
    name,
    usage: name,
    subcircuitId,
    inPts: [],
    outPts: [],
  }));

  placements[5]!.outPts = [dataPt(1n, 5, 0, 1)];
  const base = dataPt(3n, 6, 0, 256);
  const exponent = dataPt(5n, 6, 1, 256);
  placements[6]!.outPts = [base, exponent];

  const subcircuitInfoByName = new Map([
    ['DecToBit', { id: 7, name: 'DecToBit', NInWires: 2, NOutWires: 256 }],
    ['SubExpBatch', { id: 8, name: 'SubExpBatch', NInWires: 12, NOutWires: 4 }],
  ]);
  const parent = {
    placements,
    subcircuitLibrary: {
      arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition({
        nAccumulation: 4,
        nEqualBatch: 2,
        nJubjubExpBatch: 4,
        nPoseidonBatch: 1,
        nSubExpBatch: EXP_BATCH_SIZE,
      }),
      poseidonBatchSize: 1,
      arithExpBatchSize: EXP_BATCH_SIZE,
      jubjubExpBatchSize: 4,
    },
    state: { subcircuitInfoByName },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) => {
      const point = dataPt(value, 5, placements[5]!.outPts.length, sourceBitSize);
      placements[5]!.outPts.push(point);
      return point;
    }),
    place: vi.fn((name: 'DecToBit' | 'SubExpBatch', inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({
        name,
        usage,
        subcircuitId: subcircuitInfoByName.get(name)!.id,
        inPts,
        outPts,
      });
    }),
  };

  const [result] = new ArithmeticManager(parent as never).placeArithComposition('EXP', [base, exponent]);
  expect(result.value).toBe(243n);
  return { placements, result };
};

const convertToCircuitWires = (placements: Placements): void => {
  const generator = new VariableGenerator({} as never);
  (
    generator as unknown as {
      _convertEVMWiresIntoCircomWires(placements: Placements): void;
    }
  )._convertEVMWiresIntoCircomWires(placements);
};

const assertExactExpInputs = (placements: Placements): void => {
  const evmInput = placements[5]!;
  const privateInput = placements[6]!;
  const decToBit = placements[DEC_TO_BIT_PLACEMENT]!;
  expect(placements).toHaveLength(FIRST_BATCH_PLACEMENT + EXP_BATCH_COUNT);
  expect(decToBit.name).toBe('DecToBit');
  expect(decToBit.inPts).toHaveLength(2);
  expect(decToBit.outPts).toHaveLength(256);
  for (let limb = 0; limb < 2; limb++) {
    expect(decToBit.inPts[limb]).toBe(privateInput.outPts[2 + limb]);
  }

  for (let batchIndex = 0; batchIndex < EXP_BATCH_COUNT; batchIndex++) {
    const batchPlacement = FIRST_BATCH_PLACEMENT + batchIndex;
    const batch = placements[batchPlacement]!;
    expect(batch.name).toBe('SubExpBatch');
    expect(batch.inPts).toHaveLength(12);
    expect(batch.outPts).toHaveLength(4);

    if (batchIndex === 0) {
      for (let limb = 0; limb < 2; limb++) {
        expect(batch.inPts[limb]).toBe(evmInput.outPts[1 + limb]);
        expect(batch.inPts[2 + limb]).toBe(privateInput.outPts[limb]);
      }
    } else {
      const previousBatch = placements[batchPlacement - 1]!;
      for (let wireIndex = 0; wireIndex < 4; wireIndex++) {
        expect(batch.inPts[wireIndex]).toBe(previousBatch.outPts[wireIndex]);
      }
    }

    for (let bitIndex = 0; bitIndex < EXP_BATCH_SIZE; bitIndex++) {
      expect(batch.inPts[4 + bitIndex]).toBe(
        decToBit.outPts[batchIndex * EXP_BATCH_SIZE + bitIndex],
      );
    }
  }
};

const createPermutation = (placements: Placements) => {
  const physicalInterfaces = [
    ...BUFFER_SUBCIRCUITS.map(name => ({
      name,
      NInWires: 0,
      NOutWires: name === 'bufferEVMIn' ? 3 : name === 'bufferPrvIn' ? 4 : 0,
    })),
    { name: 'DecToBit' as const, NInWires: 2, NOutWires: 256 },
    { name: 'SubExpBatch' as const, NInWires: 12, NOutWires: 4 },
  ];
  let nextGlobalWire = 0;
  const subcircuitInfoByName = new Map<string, SubcircuitInfoByNameEntry>();
  for (const [id, subcircuit] of physicalInterfaces.entries()) {
    const NWires = 1 + subcircuit.NOutWires + subcircuit.NInWires;
    const flattenMap = Array.from({ length: NWires }, () => nextGlobalWire++);
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

  const placementVariables: PlacementVariables = placements.map(placement => ({
    subcircuitId: placement.subcircuitId,
    variables: [1n, ...placement.outPts.map(({ value }) => value), ...placement.inPts.map(({ value }) => value)].map(
      value => `0x${value.toString(16)}`,
    ),
    instanceList: [],
  }));
  const parent = {
    circuitPlacements: placements,
    variableGenerator: { placementVariables },
    subcircuitLibrary: {
      data: { setupParams: { l: 0, l_D: nextGlobalWire } },
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

describe('EXP chain physical permutation', () => {
  it('connects every exponent bit and state limb to the declared batch input', () => {
    const { placements, result } = createLogicalPlacements();
    expect(result).toMatchObject({
      source: FIRST_BATCH_PLACEMENT + EXP_BATCH_COUNT - 1,
      wireIndex: 0,
      sourceBitSize: 256,
    });

    convertToCircuitWires(placements);
    assertExactExpInputs(placements);

    const { permutation, subcircuitInfoByName } = createPermutation(placements);
    const evmInputInfo = subcircuitInfoByName.get('bufferEVMIn')!;
    const privateInputInfo = subcircuitInfoByName.get('bufferPrvIn')!;
    const decToBitInfo = subcircuitInfoByName.get('DecToBit')!;
    const batchInfo = subcircuitInfoByName.get('SubExpBatch')!;

    for (let limb = 0; limb < 2; limb++) {
      expect(permutation).toContainEqual({
        row: privateInputInfo.flattenMap[privateInputInfo.outWireIndex + 2 + limb],
        col: 6,
        X: decToBitInfo.flattenMap[decToBitInfo.inWireIndex + limb],
        Y: DEC_TO_BIT_PLACEMENT,
      });
      expect(permutation).toContainEqual({
        row: evmInputInfo.flattenMap[evmInputInfo.outWireIndex + 1 + limb],
        col: 5,
        X: batchInfo.flattenMap[batchInfo.inWireIndex + limb],
        Y: FIRST_BATCH_PLACEMENT,
      });
      expect(permutation).toContainEqual({
        row: privateInputInfo.flattenMap[privateInputInfo.outWireIndex + limb],
        col: 6,
        X: batchInfo.flattenMap[batchInfo.inWireIndex + 2 + limb],
        Y: FIRST_BATCH_PLACEMENT,
      });
    }

    for (let batchIndex = 0; batchIndex < EXP_BATCH_COUNT; batchIndex++) {
      const batchPlacement = FIRST_BATCH_PLACEMENT + batchIndex;
      for (let bitIndex = 0; bitIndex < EXP_BATCH_SIZE; bitIndex++) {
        const exponentBitIndex = batchIndex * EXP_BATCH_SIZE + bitIndex;
        expect(permutation).toContainEqual({
          row: decToBitInfo.flattenMap[decToBitInfo.outWireIndex + exponentBitIndex],
          col: DEC_TO_BIT_PLACEMENT,
          X: batchInfo.flattenMap[batchInfo.inWireIndex + 4 + bitIndex],
          Y: batchPlacement,
        });
      }

      if (batchIndex > 0) {
        for (let wireIndex = 0; wireIndex < 4; wireIndex++) {
          expect(permutation).toContainEqual({
            row: batchInfo.flattenMap[batchInfo.outWireIndex + wireIndex],
            col: batchPlacement - 1,
            X: batchInfo.flattenMap[batchInfo.inWireIndex + wireIndex],
            Y: batchPlacement,
          });
        }
      }
    }
  });
});
