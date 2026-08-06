import { describe, expect, it } from 'vitest';

import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import type { DataPt, DataPtType } from '../../../core/src/synthesizer/types/dataStructure.ts';

const expand = (generator: VariableGenerator, dataPt: DataPt): DataPt[] =>
  (
    generator as unknown as {
      _expandDataPtIntoCircomWires(dataPt: DataPt): DataPt[];
    }
  )._expandDataPtIntoCircomWires(dataPt);

const dataPt = (value: bigint, dataPtType: DataPtType, source = 0, wireIndex = 0): DataPt =>
  DataPtFactory.create({ source, wireIndex, dataPtType }, value);

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
