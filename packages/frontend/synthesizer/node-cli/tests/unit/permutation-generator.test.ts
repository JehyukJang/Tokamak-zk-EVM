import { describe, expect, it } from 'vitest';

import { PermutationGenerator } from '../../../core/src/circuitGenerator/generators/permutationGenerator.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { BIT_DATA_PT_TYPE, type DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { Placements, PlacementVariables } from '../../../core/src/synthesizer/types/placements.ts';
import { BUFFER_LIST } from '../../../core/src/subcircuit/configuredTypes.ts';

const point = (source: number): DataPt =>
  DataPtFactory.create(
    {
      source,
      wireIndex: 0,
      dataPtType: BIT_DATA_PT_TYPE,
    },
    1n,
  );

const subcircuit = (id: number, name: string, base: number, bufferDirection: 'in' | 'out') => ({
  id,
  name,
  NWires: 3,
  NInWires: 1,
  NOutWires: 1,
  inWireIndex: 2,
  outWireIndex: 1,
  flattenMap: [base, base + 1, base + 2],
  bufferDirection,
});

const privateInfo = subcircuit(0, 'bufferPrvIn', 0, 'in');
const storageLoadInfo = subcircuit(1, 'bufferStorageLoad', 3, 'out');
const evmInfo = subcircuit(2, 'bufferEVMIn', 6, 'in');

const createLibrary = () => {
  const subcircuitInfoByName = new Map([
    [privateInfo.name, privateInfo],
    [storageLoadInfo.name, storageLoadInfo],
    [evmInfo.name, evmInfo],
  ]);
  const subcircuitBufferMapping = Object.fromEntries(
    BUFFER_LIST.map(buffer => {
      switch (buffer) {
        case 'PRIVATE_IN':
          return [buffer, privateInfo];
        case 'STORAGE_LOAD':
          return [buffer, storageLoadInfo];
        case 'EVM_IN':
          return [buffer, evmInfo];
        default:
          return [buffer, undefined];
      }
    }),
  );
  return {
    data: { setupParams: { l: 0, l_D: 9, s_max: 16 } },
    subcircuitInfoByName,
    subcircuitBufferMapping,
  } as never;
};

const privatePlacement = (placementId: number) => ({
  name: 'bufferPrvIn' as const,
  usage: 'PRIVATE_IN',
  subcircuitId: privateInfo.id,
  inPts: [point(placementId)],
  outPts: [point(placementId)],
});

const evmPlacement = (placementId: number) => ({
  name: 'bufferEVMIn' as const,
  usage: 'EVM_IN',
  subcircuitId: evmInfo.id,
  inPts: [point(placementId)],
  outPts: [point(placementId)],
});

const successfulPlacements = (): Placements => [
  privatePlacement(0),
  privatePlacement(1),
  privatePlacement(2),
  privatePlacement(3),
  privatePlacement(4),
  evmPlacement(5),
];

const variablesFor = (placements: Placements): PlacementVariables =>
  placements.map(placement => ({
    subcircuitId: placement.subcircuitId,
    variables: ['0x01', '0x01', '0x01'],
    instanceList: ['', '', ''],
  }));

const createPermutationGenerator = (
  placements: Placements,
  placementVariables = variablesFor(placements),
): PermutationGenerator =>
  new PermutationGenerator(placements, placementVariables, createLibrary());

describe('PermutationGenerator structural hardening', () => {
  it('permits an internal no-parent root from an input buffer', () => {
    const placements = successfulPlacements();

    expect(
      () =>
        createPermutationGenerator(placements),
    ).not.toThrow();
  });

  it('rejects an unparented internal input of an output buffer', () => {
    const placements: Placements = [
      {
        name: 'bufferStorageLoad',
        usage: 'STORAGE_LOAD',
        subcircuitId: storageLoadInfo.id,
        inPts: [point(0)],
        outPts: [point(0)],
      },
      ...successfulPlacements().slice(1),
    ];

    expect(
      () =>
        createPermutationGenerator(placements),
    ).toThrow('although it is not qualified');
  });

  it('rejects a mapped interface cell that belongs to two groups', () => {
    const placements = successfulPlacements();
    const generator = createPermutationGenerator(placements);
    const privateGenerator = generator as unknown as {
      permGroup: Set<string>[];
      _validatePermGroupOwnership(): Set<string>;
    };
    privateGenerator.permGroup.push(new Set(privateGenerator.permGroup[0]));

    expect(() => privateGenerator._validatePermGroupOwnership()).toThrow('belongs to multiple groups');
  });

  it('rejects placement variables that do not match placement order', () => {
    const placements = successfulPlacements();
    const variables = variablesFor(placements);
    variables[0] = { ...variables[0]!, subcircuitId: evmInfo.id };

    expect(() => createPermutationGenerator(placements, variables)).toThrow(
      'does not match its variable entry subcircuit ID',
    );
  });
});
