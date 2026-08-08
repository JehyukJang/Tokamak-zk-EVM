import { describe, expect, it, vi } from 'vitest';

import { PermutationGenerator } from '../../../core/src/circuitGenerator/handlers/permutationGenerator.ts';
import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import type { SubcircuitInfoByNameEntry } from '../../../core/src/subcircuit/configuredTypes.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import {
  EVM_WORD_DATA_PT_TYPE,
  UINT64_LIMB_DATA_PT_TYPE,
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

type ModularOperation = 'ADDMOD' | 'MULMOD';

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

const createLogicalPlacements = (operation: ModularOperation): Placements => {
  const placements: Placements = BUFFER_SUBCIRCUITS.map((name, subcircuitId) => ({
    name,
    usage: name,
    subcircuitId,
    inPts: [],
    outPts: [],
  }));

  placements[5]!.outPts = [dataPt(1n, 5, 0, UINT64_LIMB_DATA_PT_TYPE)];

  const firstOperand = dataPt(5n, 6, 0);
  const secondOperand = dataPt(7n, 6, 1);
  const modulus = dataPt(10n, 6, 2);
  const duplicateFirstOperand = dataPt(5n, 6, 3);
  placements[6]!.outPts = [firstOperand, secondOperand, modulus, duplicateFirstOperand];

  // Equal-valued wires used only by mutation tests ensure that source and
  // wire-index identity are checked independently from the witness value.
  placements[3]!.outPts = [dataPt(5n, 3, 0)];

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
    ...(operation === 'ADDMOD'
      ? [
          ['ADDMODPrepare', { id: 8, name: 'ADDMODPrepare', NInWires: 7, NOutWires: 19 }],
          ['ADDMODVerify', { id: 9, name: 'ADDMODVerify', NInWires: 19, NOutWires: 2 }],
        ]
      : [
          ['MULMODPrepare', { id: 8, name: 'MULMODPrepare', NInWires: 6, NOutWires: 18 }],
          ['MULMODCandidate', { id: 9, name: 'MULMODCandidate', NInWires: 6, NOutWires: 12 }],
          ['MULMODVerify', { id: 10, name: 'MULMODVerify', NInWires: 24, NOutWires: 2 }],
        ]),
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
    loadArbitraryStatic: vi.fn((value: bigint, dataPtType = EVM_WORD_DATA_PT_TYPE) => {
      const point = dataPt(value, 5, placements[5]!.outPts.length, dataPtType);
      placements[5]!.outPts.push(point);
      return point;
    }),
    place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
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
  const checkBus = operation === 'ADDMOD' ? placements[7]! : undefined;
  const modular = operation === 'ADDMOD' ? placements[8]! : placements[7]!;

  if (checkBus !== undefined) {
    expect(checkBus.name).toBe('CheckBus256');
    expect(checkBus.inPts).toHaveLength(2);
  }
  expect(modular.name).toBe(operation === 'ADDMOD' ? 'ADDMODPrepare' : 'MULMODPrepare');
  expect(modular.inPts).toHaveLength(operation === 'ADDMOD' ? 7 : 6);
  for (let limb = 0; limb < 2; limb++) {
    if (checkBus !== undefined) {
      expect(checkBus.inPts[limb]).toBe(privateInput.outPts[limb]);
    }
    expect(modular.inPts[(operation === 'ADDMOD' ? 1 : 0) + limb]).toBe(privateInput.outPts[limb]);
    expect(privateInput.outPts[limb]).toMatchObject({
      source: 6,
      wireIndex: limb,
      dataPtType: EVM_WORD_DATA_PT_TYPE,
    });
  }
  if (operation === 'ADDMOD') {
    const prepare = placements[8]!;
    const verify = placements[9]!;
    expect(verify.inPts).toEqual(prepare.outPts);
  } else {
    const prepare = placements[7]!;
    const candidate = placements[8]!;
    const verify = placements[9]!;
    expect(candidate.name).toBe('MULMODCandidate');
    expect(candidate.inPts).toEqual(prepare.outPts.slice(12, 18));
    expect(verify.name).toBe('MULMODVerify');
    expect(verify.inPts).toEqual([
      ...prepare.outPts.slice(0, 12),
      ...candidate.outPts,
    ]);
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
    ...(operation === 'ADDMOD'
      ? [
          { name: 'ADDMODPrepare' as const, NInWires: 7, NOutWires: 19 },
          { name: 'ADDMODVerify' as const, NInWires: 19, NOutWires: 2 },
        ]
      : [
          { name: 'MULMODPrepare' as const, NInWires: 6, NOutWires: 18 },
          { name: 'MULMODCandidate' as const, NInWires: 6, NOutWires: 12 },
          { name: 'MULMODVerify' as const, NInWires: 24, NOutWires: 2 },
        ]),
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

describe('modular arithmetic physical permutation', () => {
  it.each(['ADDMOD', 'MULMOD'] as const)(
    'connects both limbs of the %s first operand through its required permutation group',
    operation => {
      const placements = createLogicalPlacements(operation);
      convertToCircuitWires(placements);
      assertExactModularInputs(placements, operation);

      const { permutation, subcircuitInfoByName } = createPermutation(placements, operation);
      const privateInfo = subcircuitInfoByName.get('bufferPrvIn')!;
      const modularInfo = subcircuitInfoByName.get(
        operation === 'ADDMOD' ? 'ADDMODPrepare' : 'MULMODPrepare',
      )!;
      for (let limb = 0; limb < 2; limb++) {
        const producerWire = privateInfo.flattenMap[privateInfo.outWireIndex + limb];
        const modularWire = modularInfo.flattenMap[
          modularInfo.inWireIndex + (operation === 'ADDMOD' ? 1 : 0) + limb
        ];
        if (operation === 'ADDMOD') {
          const checkInfo = subcircuitInfoByName.get('CheckBus256')!;
          const checkWire = checkInfo.flattenMap[checkInfo.inWireIndex + limb];
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
        } else {
          expect(permutation).toContainEqual({
            row: producerWire,
            col: 6,
            X: modularWire,
            Y: 7,
          });
          expect(permutation).toContainEqual({
            row: modularWire,
            col: 7,
            X: producerWire,
            Y: 6,
          });
        }
      }
    },
  );

  it('connects every ADDMOD preparation wire to ADDMODVerify', () => {
    const placements = createLogicalPlacements('ADDMOD');
    convertToCircuitWires(placements);
    assertExactModularInputs(placements, 'ADDMOD');

    const { permutation, subcircuitInfoByName } = createPermutation(placements, 'ADDMOD');
    const prepareInfo = subcircuitInfoByName.get('ADDMODPrepare')!;
    const verifyInfo = subcircuitInfoByName.get('ADDMODVerify')!;

    for (let index = 0; index < 19; index++) {
      const prepareWire = prepareInfo.flattenMap[prepareInfo.outWireIndex + index];
      const verifyWire = verifyInfo.flattenMap[verifyInfo.inWireIndex + index];
      expect(permutation).toContainEqual({
        row: prepareWire,
        col: 8,
        X: verifyWire,
        Y: 9,
      });
      expect(permutation).toContainEqual({
        row: verifyWire,
        col: 9,
        X: prepareWire,
        Y: 8,
      });
    }
  });

  it('connects all 30 MULMOD intermediate wires in exact order', () => {
    const placements = createLogicalPlacements('MULMOD');
    convertToCircuitWires(placements);
    assertExactModularInputs(placements, 'MULMOD');

    const { permutation, subcircuitInfoByName } = createPermutation(placements, 'MULMOD');
    const prepareInfo = subcircuitInfoByName.get('MULMODPrepare')!;
    const candidateInfo = subcircuitInfoByName.get('MULMODCandidate')!;
    const verifyInfo = subcircuitInfoByName.get('MULMODVerify')!;

    for (let index = 0; index < 6; index++) {
      const prepareWire = prepareInfo.flattenMap[prepareInfo.outWireIndex + 12 + index];
      const candidateWire = candidateInfo.flattenMap[candidateInfo.inWireIndex + index];
      expect(permutation).toContainEqual({
        row: prepareWire,
        col: 7,
        X: candidateWire,
        Y: 8,
      });
      expect(permutation).toContainEqual({
        row: candidateWire,
        col: 8,
        X: prepareWire,
        Y: 7,
      });
    }
    for (let index = 0; index < 12; index++) {
      const prepareWire = prepareInfo.flattenMap[prepareInfo.outWireIndex + index];
      const verifyWire = verifyInfo.flattenMap[verifyInfo.inWireIndex + index];
      expect(permutation).toContainEqual({
        row: prepareWire,
        col: 7,
        X: verifyWire,
        Y: 9,
      });
      expect(permutation).toContainEqual({
        row: verifyWire,
        col: 9,
        X: prepareWire,
        Y: 7,
      });
    }
    for (let index = 0; index < 12; index++) {
      const candidateWire = candidateInfo.flattenMap[candidateInfo.outWireIndex + index];
      const verifyWire = verifyInfo.flattenMap[verifyInfo.inWireIndex + 12 + index];
      expect(permutation).toContainEqual({
        row: candidateWire,
        col: 8,
        X: verifyWire,
        Y: 9,
      });
      expect(permutation).toContainEqual({
        row: verifyWire,
        col: 9,
        X: candidateWire,
        Y: 8,
      });
    }
  });

  it.each([
    ['ADDMOD', 'source'],
    ['ADDMOD', 'wireIndex'],
    ['ADDMOD', 'dataPtType'],
    ['MULMOD', 'source'],
    ['MULMOD', 'wireIndex'],
    ['MULMOD', 'dataPtType'],
  ] as const)('detects a %s first-operand %s mutation after physical conversion', (operation, mutation) => {
    const placements = createLogicalPlacements(operation);
    const modular = operation === 'ADDMOD' ? placements[8]! : placements[7]!;
    if (mutation === 'source') {
      modular.inPts[operation === 'ADDMOD' ? 1 : 0] = placements[3]!.outPts[0]!;
    } else if (mutation === 'wireIndex') {
      modular.inPts[operation === 'ADDMOD' ? 1 : 0] = placements[6]!.outPts[3]!;
    } else {
      placements[6]!.outPts[0]!.dataPtType = UINT64_LIMB_DATA_PT_TYPE;
    }

    convertToCircuitWires(placements);
    expect(() => assertExactModularInputs(placements, operation)).toThrow();
  });
});
