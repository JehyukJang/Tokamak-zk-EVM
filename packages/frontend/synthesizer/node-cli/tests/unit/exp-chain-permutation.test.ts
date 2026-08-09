import { describe, expect, it, vi } from 'vitest';

import { PermutationGenerator } from '../../../core/src/circuitGenerator/handlers/permutationGenerator.ts';
import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import type { SubcircuitInfoByNameEntry } from '../../../core/src/subcircuit/configuredTypes.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import {
  BIT_LIMB_DATA_PT_TYPE,
  EVM_WORD_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
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
const NUM_EXPONENT_BITS = 256;
const DEC_TO_BIT_PLACEMENT = BUFFER_SUBCIRCUITS.length;
const FIRST_SUB_EXP_PLACEMENT = DEC_TO_BIT_PLACEMENT + 1;
const FINAL_SUB_EXP_PLACEMENT = FIRST_SUB_EXP_PLACEMENT + NUM_EXPONENT_BITS - 1;
const CHECK_BUS_PLACEMENT = FINAL_SUB_EXP_PLACEMENT + 1;

const dataPt = (
  value: bigint,
  source: number,
  wireIndex: number,
  dataPtType: DataPtType = EVM_WORD_DATA_PT_TYPE,
): DataPt => ({
  source,
  wireIndex,
  dataPtType,
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

  placements[5]!.outPts = [dataPt(1n, 5, 0, BIT_LIMB_DATA_PT_TYPE)];
  const base = dataPt(3n, 6, 0);
  const exponent = dataPt(5n, 6, 1);
  placements[6]!.outPts = [base, exponent];

  const subcircuitInfoByName = new Map([
    ['DecToBit', { id: 7, name: 'DecToBit', NInWires: 2, NOutWires: 256 }],
    ['SubExp', { id: 8, name: 'SubExp', NInWires: 5, NOutWires: 4 }],
    ['CheckBus256', { id: 9, name: 'CheckBus256', NInWires: 2, NOutWires: 2 }],
  ]);
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
    state: { subcircuitInfoByName },
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType: DataPtType) => {
      const point = dataPt(value, 5, placements[5]!.outPts.length, dataPtType);
      placements[5]!.outPts.push(point);
      return point;
    }),
    place: vi.fn((
      name: 'DecToBit' | 'SubExp' | 'CheckBus256',
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

  const [result] = new ArithmeticManager(parent as never)
    .placeArithComposition('EXP', [base, exponent]);
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

const createPermutation = (placements: Placements) => {
  const physicalInterfaces = [
    ...BUFFER_SUBCIRCUITS.map(name => ({
      name,
      NInWires: 0,
      NOutWires: name === 'bufferEVMIn' ? 3 : name === 'bufferPrvIn' ? 4 : 0,
    })),
    { name: 'DecToBit' as const, NInWires: 2, NOutWires: 256 },
    { name: 'SubExp' as const, NInWires: 5, NOutWires: 4 },
    { name: 'CheckBus256' as const, NInWires: 2, NOutWires: 2 },
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
    variables: [
      1n,
      ...placement.outPts.map(({ value }) => value),
      ...placement.inPts.map(({ value }) => value),
    ].map(value => `0x${value.toString(16)}`),
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
  it('connects all bits, every serial state, and the terminal range check', () => {
    const { placements, result } = createLogicalPlacements();
    expect(result).toMatchObject({
      source: CHECK_BUS_PLACEMENT,
      wireIndex: 0,
      dataPtType: EVM_WORD_DATA_PT_TYPE,
    });

    convertToCircuitWires(placements);
    expect(placements).toHaveLength(CHECK_BUS_PLACEMENT + 1);

    const evmInput = placements[5]!;
    const privateInput = placements[6]!;
    const decToBit = placements[DEC_TO_BIT_PLACEMENT]!;
    expect(decToBit.name).toBe('DecToBit');
    expect(decToBit.inPts).toHaveLength(2);
    expect(decToBit.outPts).toHaveLength(NUM_EXPONENT_BITS);

    for (let bitIndex = 0; bitIndex < NUM_EXPONENT_BITS; bitIndex++) {
      const placementIndex = FIRST_SUB_EXP_PLACEMENT + bitIndex;
      const subExp = placements[placementIndex]!;
      expect(subExp.name).toBe('SubExp');
      expect(subExp.inPts).toHaveLength(5);
      expect(subExp.outPts).toHaveLength(4);

      if (bitIndex === 0) {
        for (let limb = 0; limb < 2; limb++) {
          expect(subExp.inPts[limb]).toBe(evmInput.outPts[1 + limb]);
          expect(subExp.inPts[2 + limb]).toBe(privateInput.outPts[limb]);
        }
      } else {
        const previous = placements[placementIndex - 1]!;
        for (let wireIndex = 0; wireIndex < 4; wireIndex++) {
          expect(subExp.inPts[wireIndex]).toBe(previous.outPts[wireIndex]);
        }
      }
      expect(subExp.inPts[4]).toBe(decToBit.outPts[bitIndex]);
    }

    const checkBus = placements[CHECK_BUS_PLACEMENT]!;
    const finalSubExp = placements[FINAL_SUB_EXP_PLACEMENT]!;
    expect(checkBus.name).toBe('CheckBus256');
    expect(checkBus.inPts).toEqual(finalSubExp.outPts.slice(0, 2));
    expect(checkBus.outPts).toHaveLength(2);

    const { permutation, subcircuitInfoByName } = createPermutation(placements);
    const evmInputInfo = subcircuitInfoByName.get('bufferEVMIn')!;
    const privateInputInfo = subcircuitInfoByName.get('bufferPrvIn')!;
    const decToBitInfo = subcircuitInfoByName.get('DecToBit')!;
    const subExpInfo = subcircuitInfoByName.get('SubExp')!;
    const checkBusInfo = subcircuitInfoByName.get('CheckBus256')!;

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
        X: subExpInfo.flattenMap[subExpInfo.inWireIndex + limb],
        Y: FIRST_SUB_EXP_PLACEMENT,
      });
      expect(permutation).toContainEqual({
        row: privateInputInfo.flattenMap[privateInputInfo.outWireIndex + limb],
        col: 6,
        X: subExpInfo.flattenMap[subExpInfo.inWireIndex + 2 + limb],
        Y: FIRST_SUB_EXP_PLACEMENT,
      });
    }

    for (let bitIndex = 0; bitIndex < NUM_EXPONENT_BITS; bitIndex++) {
      const placementIndex = FIRST_SUB_EXP_PLACEMENT + bitIndex;
      expect(permutation).toContainEqual({
        row: decToBitInfo.flattenMap[decToBitInfo.outWireIndex + bitIndex],
        col: DEC_TO_BIT_PLACEMENT,
        X: subExpInfo.flattenMap[subExpInfo.inWireIndex + 4],
        Y: placementIndex,
      });
      if (bitIndex > 0) {
        for (let wireIndex = 0; wireIndex < 4; wireIndex++) {
          expect(permutation).toContainEqual({
            row: subExpInfo.flattenMap[subExpInfo.outWireIndex + wireIndex],
            col: placementIndex - 1,
            X: subExpInfo.flattenMap[subExpInfo.inWireIndex + wireIndex],
            Y: placementIndex,
          });
        }
      }
    }

    for (let limb = 0; limb < 2; limb++) {
      expect(permutation).toContainEqual({
        row: subExpInfo.flattenMap[subExpInfo.outWireIndex + limb],
        col: FINAL_SUB_EXP_PLACEMENT,
        X: checkBusInfo.flattenMap[checkBusInfo.inWireIndex + limb],
        Y: CHECK_BUS_PLACEMENT,
      });
    }
  });
});
