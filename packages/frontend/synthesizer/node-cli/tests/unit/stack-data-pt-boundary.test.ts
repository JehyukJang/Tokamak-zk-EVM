import { describe, expect, it } from 'vitest';

import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { StackPt } from '../../../core/src/synthesizer/dataStructure/stackPt.ts';
import {
  BIT_LIMB_DATA_PT_TYPE,
  BLS12_381_FR_NATIVE_DATA_PT_TYPE,
  EVM_WORD_DATA_PT_TYPE,
  UINT64_LIMB_DATA_PT_TYPE,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';

const dataPt = (value: bigint, dataPtType: DataPtType, source = 7, wireIndex = 3) =>
  DataPtFactory.create(
    {
      source,
      wireIndex,
      dataPtType,
      extSource: 'test source',
      extDest: 'test destination',
    },
    value,
  );

describe('EVM stack DataPt boundary', () => {
  it('exports deeply frozen canonical DataPt types', () => {
    for (const dataPtType of [
      EVM_WORD_DATA_PT_TYPE,
      UINT64_LIMB_DATA_PT_TYPE,
      BIT_LIMB_DATA_PT_TYPE,
      BLS12_381_FR_NATIVE_DATA_PT_TYPE,
    ]) {
      expect(Object.isFrozen(dataPtType)).toBe(true);
      expect(Object.isFrozen(dataPtType.valueDomain)).toBe(true);
      expect(Object.isFrozen(dataPtType.wireLayout)).toBe(true);
    }
  });

  it('widens a two-limb address view without changing its source or value', () => {
    const addressPt = dataPt(0x1234n, {
      valueDomain: { kind: 'uint', bits: 160 },
      wireLayout: { kind: 'limbs-128', count: 2 },
    });

    const wordPt = DataPtFactory.createEVMWordView(addressPt);

    expect(wordPt).toMatchObject({
      source: addressPt.source,
      wireIndex: addressPt.wireIndex,
      value: addressPt.value,
      extSource: addressPt.extSource,
      extDest: addressPt.extDest,
      dataPtType: {
        valueDomain: { kind: 'uint', bits: 256 },
        wireLayout: { kind: 'limbs-128', count: 2 },
      },
    });
    expect(wordPt).not.toBe(addressPt);
    expect(wordPt.dataPtType).not.toBe(EVM_WORD_DATA_PT_TYPE);
    expect(wordPt.dataPtType.valueDomain).not.toBe(EVM_WORD_DATA_PT_TYPE.valueDomain);
    expect(wordPt.dataPtType.wireLayout).not.toBe(EVM_WORD_DATA_PT_TYPE.wireLayout);
  });

  it('widens a two-limb field value to an EVM word view', () => {
    const fieldPt = dataPt(123n, {
      valueDomain: { kind: 'bls12-381-fr' },
      wireLayout: { kind: 'limbs-128', count: 2 },
    });

    expect(DataPtFactory.createEVMWordView(fieldPt).dataPtType).toEqual({
      valueDomain: { kind: 'uint', bits: 256 },
      wireLayout: { kind: 'limbs-128', count: 2 },
    });
  });

  it.each([
    [
      'one-limb integer',
      {
        valueDomain: { kind: 'uint', bits: 1 },
        wireLayout: { kind: 'limbs-128', count: 1 },
      },
    ],
    [
      'native field value',
      {
        valueDomain: { kind: 'bls12-381-fr' },
        wireLayout: { kind: 'native-fr' },
      },
    ],
  ] as const)('rejects a %s at the EVM-word boundary', (_label, dataPtType) => {
    expect(() => DataPtFactory.createEVMWordView(dataPt(1n, dataPtType))).toThrow(
      'EVM word views require the limbs-128(2) layout',
    );
  });

  it('stores only EVM-word views and routes dup through push', () => {
    const stack = new StackPt();
    const addressPt = dataPt(
      0x5678n,
      {
        valueDomain: { kind: 'uint', bits: 160 },
        wireLayout: { kind: 'limbs-128', count: 2 },
      },
      9,
      4,
    );

    stack.push(addressPt);
    stack.dup(1);

    const [duplicate, original] = stack.peek(2);
    expect(duplicate).toEqual(original);
    expect(duplicate).not.toBe(original);
    expect(original).not.toBe(addressPt);
    expect(duplicate.dataPtType).toEqual({
      valueDomain: { kind: 'uint', bits: 256 },
      wireLayout: { kind: 'limbs-128', count: 2 },
    });
  });

  it('rejects native and one-limb values through StackPt.push', () => {
    const stack = new StackPt();
    const nativePt = dataPt(1n, {
      valueDomain: { kind: 'bls12-381-fr' },
      wireLayout: { kind: 'native-fr' },
    });
    const oneLimbPt = dataPt(1n, {
      valueDomain: { kind: 'uint', bits: 1 },
      wireLayout: { kind: 'limbs-128', count: 1 },
    });

    expect(() => stack.push(nativePt)).toThrow('EVM word views require the limbs-128(2) layout');
    expect(() => stack.push(oneLimbPt)).toThrow('EVM word views require the limbs-128(2) layout');
    expect(stack.length).toBe(0);
  });
});
