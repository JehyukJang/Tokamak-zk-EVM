import { describe, expect, it } from 'vitest';

import { VariableGenerator } from '../../../core/src/circuitGenerator/handlers/variableGenerator.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

describe('VariableGenerator word encoding', () => {
  it('emits the lower 128-bit limb before the upper 128-bit limb', () => {
    const lower = 0x0123456789abcdef0123456789abcdefn;
    const upper = 0xfedcba9876543210fedcba9876543210n;
    const word: DataPt = {
      source: 0,
      wireIndex: 0,
      sourceBitSize: 256,
      extSource: 'word source',
      extDest: 'word destination',
      value: (upper << 128n) | lower,
      valueHex: `0x${((upper << 128n) | lower).toString(16)}`,
    };
    const generator = new VariableGenerator({} as never);

    const limbs = (
      generator as unknown as {
        _halveWordSizeOfWires(dataPt: DataPt): DataPt[];
      }
    )._halveWordSizeOfWires(word);

    expect(limbs.map(limb => limb.value)).toEqual([lower, upper]);
    expect(limbs.map(limb => limb.extSource)).toEqual(['word source (lower 16 bytes)', 'word source (upper 16 bytes)']);
    expect(limbs.map(limb => limb.extDest)).toEqual([
      'word destination (lower 16 bytes)',
      'word destination (upper 16 bytes)',
    ]);
  });
});
