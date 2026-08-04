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

type ModularOperation = 'ADDMOD' | 'MULMOD';

const dataPt = (value: bigint, source: number, wireIndex: number, sourceBitSize: number): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createLogicalPlacements = (operation: ModularOperation): Placements => {
  const placements: Placements = BUFFER_SUBCIRCUITS.map((name, subcircuitId) => ({
    name,
    usage: name,
    subcircuitId,
    inPts: [],
    outPts: [],
  }));

  placements[5]!.outPts = [dataPt(1n, 5, 0, 1)];

  const firstOperand = dataPt(5n, 6, 0, 256);
  const secondOperand = dataPt(7n, 6, 1, 256);
  const modulus = dataPt(10n, 6, 2, 256);
  const duplicateFirstOperand = dataPt(5n, 6, 3, 256);
  placements[6]!.outPts = [firstOperand, secondOperand, modulus, duplicateFirstOperand];

  // Equal-valued wires used only by mutation tests ensure that source and
  // wire-index identity are checked independently from the witness value.
  placements[3]!.outPts = [dataPt(5n, 3, 0, 256)];

  const subcircuitInfoByName = new Map([
    [
      'CheckBus256',
      {
        id: 7,
        name: 'CheckBus256',
        NInWires: 2,
        NOutWires: 0,
      },
    ],
    [
      operation,
      {
        id: 8,
        name: operation,
        NInWires: 7,
        NOutWires: 2,
      },
    ],
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
    place: vi.fn((name: 'CheckBus256' | ModularOperation, inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({
        name,
        usage,
        subcircuitId: subcircuitInfoByName.get(name)!.id,
        inPts,
        outPts,
      });
    }),
  };

  const [result] = new ArithmeticManager(parent as never).placeArithComposition(operation, [
    firstOperand,
    secondOperand,
    modulus,
  ]);
  expect(result.value).toBe(operation === 'ADDMOD' ? 2n : 5n);
  return placements;
};

const convertToCircuitWires = (placements: Placements): void => {
  const generator = new VariableGenerator({} as never);
  (
    generator as unknown as {
      _convertEVMWiresIntoCircomWires(placements: Placements): void;
    }
  )._convertEVMWiresIntoCircomWires(placements);
};

const assertExactModularInputs = (placements: Placements, operation: ModularOperation): void => {
  const privateInput = placements[6]!;
  const checkBus = placements[7]!;
  const modular = placements[8]!;

  expect(checkBus.name).toBe('CheckBus256');
  expect(modular.name).toBe(operation);
  expect(checkBus.inPts).toHaveLength(2);
  expect(modular.inPts).toHaveLength(7);
  for (let limb = 0; limb < 2; limb++) {
    expect(checkBus.inPts[limb]).toBe(privateInput.outPts[limb]);
    expect(modular.inPts[1 + limb]).toBe(privateInput.outPts[limb]);
    expect(privateInput.outPts[limb]).toMatchObject({
      source: 6,
      wireIndex: limb,
      sourceBitSize: 256,
    });
  }
};

const createPermutation = (placements: Placements, operation: ModularOperation) => {
  const physicalInterfaces = [
    ...BUFFER_SUBCIRCUITS.map(name => ({
      name,
      NInWires: 0,
      NOutWires: name === 'bufferTxIn' ? 2 : name === 'bufferEVMIn' ? 2 : name === 'bufferPrvIn' ? 8 : 0,
    })),
    { name: 'CheckBus256' as const, NInWires: 2, NOutWires: 0 },
    { name: operation, NInWires: 7, NOutWires: 2 },
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

describe('modular CheckBus256 physical permutation', () => {
  it.each(['ADDMOD', 'MULMOD'] as const)(
    'connects both limbs of the %s first operand through one permutation group',
    operation => {
      const placements = createLogicalPlacements(operation);
      convertToCircuitWires(placements);
      assertExactModularInputs(placements, operation);

      const { permutation, subcircuitInfoByName } = createPermutation(placements, operation);
      const privateInfo = subcircuitInfoByName.get('bufferPrvIn')!;
      const checkInfo = subcircuitInfoByName.get('CheckBus256')!;
      const modularInfo = subcircuitInfoByName.get(operation)!;
      for (let limb = 0; limb < 2; limb++) {
        const producerWire = privateInfo.flattenMap[privateInfo.outWireIndex + limb];
        const checkWire = checkInfo.flattenMap[checkInfo.inWireIndex + limb];
        const modularWire = modularInfo.flattenMap[modularInfo.inWireIndex + 1 + limb];
        expect(permutation).toContainEqual({
          row: producerWire,
          col: 6,
          X: checkWire,
          Y: 7,
        });
        expect(permutation).toContainEqual({
          row: checkWire,
          col: 7,
          X: modularWire,
          Y: 8,
        });
        expect(permutation).toContainEqual({
          row: modularWire,
          col: 8,
          X: producerWire,
          Y: 6,
        });
      }
    },
  );

  it.each([
    ['ADDMOD', 'source'],
    ['ADDMOD', 'wireIndex'],
    ['ADDMOD', 'sourceBitSize'],
    ['MULMOD', 'source'],
    ['MULMOD', 'wireIndex'],
    ['MULMOD', 'sourceBitSize'],
  ] as const)('detects a %s first-operand %s mutation after physical conversion', (operation, mutation) => {
    const placements = createLogicalPlacements(operation);
    if (mutation === 'source') {
      placements[8]!.inPts[1] = placements[3]!.outPts[0]!;
    } else if (mutation === 'wireIndex') {
      placements[8]!.inPts[1] = placements[6]!.outPts[3]!;
    } else {
      placements[6]!.outPts[0]!.sourceBitSize = 128;
    }

    convertToCircuitWires(placements);
    expect(() => assertExactModularInputs(placements, operation)).toThrow();
  });
});
