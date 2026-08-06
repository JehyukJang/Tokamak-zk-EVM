import { describe, expect, it, vi } from 'vitest';

import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { BUFFER_LIST } from '../../../core/src/subcircuit/configuredTypes.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import type { DataPt, DataPtType } from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { Placements } from '../../../core/src/synthesizer/types/placements.ts';

const expand = (generator: VariableGenerator, dataPt: DataPt): DataPt[] =>
  (
    generator as unknown as {
      _expandDataPtIntoCircomWires(dataPt: DataPt): DataPt[];
    }
  )._expandDataPtIntoCircomWires(dataPt);

const dataPt = (value: bigint, dataPtType: DataPtType, source = 0, wireIndex = 0): DataPt =>
  DataPtFactory.create({ source, wireIndex, dataPtType }, value);

const BUFFER_SUBCIRCUITS = [
  'bufferLogOut',
  'bufferStorageStore',
  'bufferStorageLoad',
  'bufferTxIn',
  'bufferBlockIn',
  'bufferEVMIn',
  'bufferPrvIn',
] as const;

const privateBufferIndex = BUFFER_LIST.indexOf('PRIVATE_IN');

const createBufferPlacements = (): Placements => BUFFER_SUBCIRCUITS.map((name, subcircuitId) => ({
  name,
  usage: BUFFER_LIST[subcircuitId],
  subcircuitId,
  inPts: [],
  outPts: [],
}));

const addPrivateBufferValue = (
  placements: Placements,
  value: bigint,
  dataPtType: DataPtType,
): void => {
  const placement = placements[privateBufferIndex];
  const inPt = dataPt(value, dataPtType, privateBufferIndex, placement.inPts.length);
  placement.inPts.push(inPt);
  placement.outPts.push(DataPtFactory.createBufferTwin(inPt));
};

const createBufferGenerator = (privateBufferCapacity: number): VariableGenerator => {
  const subcircuitBufferMapping = Object.fromEntries(BUFFER_LIST.map((buffer, index) => [
    buffer,
    {
      name: BUFFER_SUBCIRCUITS[index],
      NInWires: buffer === 'PRIVATE_IN' ? privateBufferCapacity : 1024,
    },
  ]));

  return new VariableGenerator({
    subcircuitLibrary: {
      subcircuitBufferMapping,
      data: { setupParams: { s_max: 256 } },
    },
  } as never);
};

const convertAndValidateBuffers = (
  generator: VariableGenerator,
  placements: Placements,
): void => {
  const privateGenerator = generator as unknown as {
    _convertEVMWiresIntoCircomWires(placements: Placements): void;
    _validateBufferSizes(placements: Placements): void;
  };
  privateGenerator._convertEVMWiresIntoCircomWires(placements);
  privateGenerator._validateBufferSizes(placements);
};

describe('VariableGenerator word encoding', () => {
  it('emits the lower 128-bit limb before the upper 128-bit limb', () => {
    const lower = 0x0123456789abcdef0123456789abcdefn;
    const upper = 0xfedcba9876543210fedcba9876543210n;
    const word = DataPtFactory.create(
      {
        source: 0,
        wireIndex: 0,
        dataPtType: {
          valueDomain: { kind: 'uint', bits: 256 },
          wireLayout: { kind: 'limbs-128', count: 2 },
        },
        extSource: 'word source',
        extDest: 'word destination',
      },
      (upper << 128n) | lower,
    );
    const generator = new VariableGenerator({} as never);

    const limbs = expand(generator, word);

    expect(limbs.map(limb => limb.value)).toEqual([lower, upper]);
    expect(limbs.map(limb => limb.extSource)).toEqual(['word source (lower 16 bytes)', 'word source (upper 16 bytes)']);
    expect(limbs.map(limb => limb.extDest)).toEqual([
      'word destination (lower 16 bytes)',
      'word destination (upper 16 bytes)',
    ]);
  });

  it('keeps a one-limb integer as one physical wire', () => {
    const generator = new VariableGenerator({} as never);
    const original = dataPt(
      1n,
      {
        valueDomain: { kind: 'uint', bits: 1 },
        wireLayout: { kind: 'limbs-128', count: 1 },
      },
      7,
      3,
    );

    const wires = expand(generator, original);

    expect(wires).toHaveLength(1);
    expect(wires[0]).toEqual(original);
    expect(wires[0]).not.toBe(original);
  });

  it('keeps a native field value as one physical wire', () => {
    const generator = new VariableGenerator({} as never);
    const original = dataPt(
      123n,
      {
        valueDomain: { kind: 'bls12-381-fr' },
        wireLayout: { kind: 'native-fr' },
      },
      8,
      5,
    );

    const wires = expand(generator, original);

    expect(wires).toHaveLength(1);
    expect(wires[0]).toEqual(original);
    expect(wires[0]).not.toBe(original);
  });
});

describe('VariableGenerator buffer wire capacity', () => {
  it('preserves a buffer twin data type', () => {
    const original = dataPt(
      123n,
      {
        valueDomain: { kind: 'bls12-381-fr' },
        wireLayout: { kind: 'native-fr' },
      },
      privateBufferIndex,
      0,
    );

    const twin = DataPtFactory.createBufferTwin(original);

    expect(twin.dataPtType).toEqual(original.dataPtType);
    expect(twin.dataPtType).not.toBe(original.dataPtType);
  });

  it('accepts mixed layouts that exactly fill the input-wire capacity', () => {
    const placements = createBufferPlacements();
    addPrivateBufferValue(placements, 1n, {
      valueDomain: { kind: 'uint', bits: 1 },
      wireLayout: { kind: 'limbs-128', count: 1 },
    });
    addPrivateBufferValue(placements, 123n, {
      valueDomain: { kind: 'bls12-381-fr' },
      wireLayout: { kind: 'native-fr' },
    });
    addPrivateBufferValue(placements, (1n << 255n) + 7n, {
      valueDomain: { kind: 'uint', bits: 256 },
      wireLayout: { kind: 'limbs-128', count: 2 },
    });

    convertAndValidateBuffers(createBufferGenerator(4), placements);

    expect(placements[privateBufferIndex].inPts).toHaveLength(4);
    expect(placements[privateBufferIndex].outPts).toHaveLength(4);
  });

  it('rejects one physical input wire beyond capacity without counting outputs', () => {
    const placements = createBufferPlacements();
    addPrivateBufferValue(placements, 1n, {
      valueDomain: { kind: 'uint', bits: 1 },
      wireLayout: { kind: 'limbs-128', count: 1 },
    });
    addPrivateBufferValue(placements, 123n, {
      valueDomain: { kind: 'bls12-381-fr' },
      wireLayout: { kind: 'native-fr' },
    });
    addPrivateBufferValue(placements, (1n << 255n) + 7n, {
      valueDomain: { kind: 'uint', bits: 256 },
      wireLayout: { kind: 'limbs-128', count: 2 },
    });
    addPrivateBufferValue(placements, 0n, {
      valueDomain: { kind: 'uint', bits: 1 },
      wireLayout: { kind: 'limbs-128', count: 1 },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(() => convertAndValidateBuffers(createBufferGenerator(4), placements)).toThrow(
      'Resolve above errors.',
    );
    expect(placements[privateBufferIndex].inPts).toHaveLength(5);
    expect(placements[privateBufferIndex].outPts).toHaveLength(5);
    log.mockRestore();
  });
});
