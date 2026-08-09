import { describe, expect, it, vi } from 'vitest';
import { poseidonChainCompress } from 'tokamak-l2js';

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
const POSEIDON_BATCH_SIZE = 1;
const FIRST_POSEIDON_PLACEMENT = BUFFER_SUBCIRCUITS.length;
const INPUT_VALUES = [2n, 3n, 5n, 7n] as const;

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
  const inputs = INPUT_VALUES.map((value, wireIndex) => dataPt(value, 6, wireIndex, 255));
  placements[6]!.outPts = inputs;

  const subcircuitInfoByName = new Map([[
    'Poseidon',
    { id: 7, name: 'Poseidon', NInWires: 5, NOutWires: 2 },
  ]]);
  const parent = {
    placements,
    subcircuitLibrary: {
      arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition({
        nAccumulation: 4,
        nEqualBatch: 2,
        nJubjubExpBatch: 4,
        nPoseidonBatch: POSEIDON_BATCH_SIZE,
      }),
      poseidonBatchSize: POSEIDON_BATCH_SIZE,
      jubjubExpBatchSize: 4,
    },
    state: { subcircuitInfoByName },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) => {
      const point = dataPt(value, 5, placements[5]!.outPts.length, sourceBitSize);
      placements[5]!.outPts.push(point);
      return point;
    }),
    place: vi.fn((name: 'Poseidon', inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({
        name,
        usage,
        subcircuitId: subcircuitInfoByName.get(name)!.id,
        inPts,
        outPts,
      });
    }),
  };

  const [result] = new ArithmeticManager(parent as never).placeArithComposition('Poseidon', inputs);
  expect(result.value).toBe(poseidonChainCompress([...INPUT_VALUES]));
  return { placements, result };
};

const prepareCircuitWires = (placements: Placements): void => {
  const generator = new VariableGenerator({} as never);
  const internals = generator as unknown as {
    _removeUnusedWiresFromEVMInBuffer(oldPlacements: Placements, newPlacements: Placements): void;
    _convertEVMWiresIntoCircomWires(placements: Placements): void;
  };
  internals._removeUnusedWiresFromEVMInBuffer(placements, placements);
  internals._convertEVMWiresIntoCircomWires(placements);
};

const assertExactPoseidonInputs = (placements: Placements): void => {
  const evmInput = placements[5]!;
  const privateInput = placements[6]!;
  expect(placements).toHaveLength(FIRST_POSEIDON_PLACEMENT + 3);
  expect(evmInput.outPts).toHaveLength(4);

  for (let chainIndex = 0; chainIndex < 3; chainIndex++) {
    const placementIndex = FIRST_POSEIDON_PLACEMENT + chainIndex;
    const poseidon = placements[placementIndex]!;
    expect(poseidon.name).toBe('Poseidon');
    expect(poseidon.inPts).toHaveLength(5);
    expect(poseidon.outPts).toHaveLength(2);
    expect(poseidon.inPts[0]).toBe(evmInput.outPts[1 + chainIndex]);
    expect(poseidon.inPts[0]!.value).toBe(1n);

    if (chainIndex === 0) {
      for (let wireIndex = 0; wireIndex < 4; wireIndex++) {
        expect(poseidon.inPts[1 + wireIndex]).toBe(privateInput.outPts[wireIndex]);
      }
    } else {
      const previousPoseidon = placements[placementIndex - 1]!;
      for (let limb = 0; limb < 2; limb++) {
        expect(poseidon.inPts[1 + limb]).toBe(previousPoseidon.outPts[limb]);
        expect(poseidon.inPts[3 + limb]).toBe(privateInput.outPts[2 * (chainIndex + 1) + limb]);
      }
    }
  }
};

const createPermutation = (placements: Placements) => {
  const physicalInterfaces = [
    ...BUFFER_SUBCIRCUITS.map(name => ({
      name,
      NInWires: 0,
      NOutWires: name === 'bufferEVMIn' ? 4 : name === 'bufferPrvIn' ? 8 : 0,
    })),
    { name: 'Poseidon' as const, NInWires: 5, NOutWires: 2 },
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

describe('Poseidon chain physical permutation', () => {
  it('connects every selector, original input, and chained hash limb to its declared input', () => {
    const { placements, result } = createLogicalPlacements();
    expect(result).toMatchObject({ source: 9, wireIndex: 0, sourceBitSize: 255 });

    prepareCircuitWires(placements);
    assertExactPoseidonInputs(placements);

    const { permutation, subcircuitInfoByName } = createPermutation(placements);
    const evmInputInfo = subcircuitInfoByName.get('bufferEVMIn')!;
    const privateInputInfo = subcircuitInfoByName.get('bufferPrvIn')!;
    const poseidonInfo = subcircuitInfoByName.get('Poseidon')!;

    for (let chainIndex = 0; chainIndex < 3; chainIndex++) {
      const placementIndex = FIRST_POSEIDON_PLACEMENT + chainIndex;
      expect(permutation).toContainEqual({
        row: evmInputInfo.flattenMap[evmInputInfo.outWireIndex + 1 + chainIndex],
        col: 5,
        X: poseidonInfo.flattenMap[poseidonInfo.inWireIndex],
        Y: placementIndex,
      });

      if (chainIndex === 0) {
        for (let wireIndex = 0; wireIndex < 4; wireIndex++) {
          expect(permutation).toContainEqual({
            row: privateInputInfo.flattenMap[privateInputInfo.outWireIndex + wireIndex],
            col: 6,
            X: poseidonInfo.flattenMap[poseidonInfo.inWireIndex + 1 + wireIndex],
            Y: placementIndex,
          });
        }
      } else {
        for (let limb = 0; limb < 2; limb++) {
          expect(permutation).toContainEqual({
            row: poseidonInfo.flattenMap[poseidonInfo.outWireIndex + limb],
            col: placementIndex - 1,
            X: poseidonInfo.flattenMap[poseidonInfo.inWireIndex + 1 + limb],
            Y: placementIndex,
          });
          expect(permutation).toContainEqual({
            row: privateInputInfo.flattenMap[
              privateInputInfo.outWireIndex + 2 * (chainIndex + 1) + limb
            ],
            col: 6,
            X: poseidonInfo.flattenMap[poseidonInfo.inWireIndex + 3 + limb],
            Y: placementIndex,
          });
        }
      }
    }
  });
});
