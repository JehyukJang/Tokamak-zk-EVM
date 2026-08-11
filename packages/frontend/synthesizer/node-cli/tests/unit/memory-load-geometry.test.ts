import { describe, expect, it } from 'vitest';

import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { MemoryPt } from '../../../core/src/synthesizer/dataStructure/memoryPt.ts';
import { UINT256_DATA_PT_TYPE } from '../../../core/src/synthesizer/types/dataStructure.ts';

const wordPt = (value: bigint) => DataPtFactory.create({
  source: 7,
  wireIndex: 0,
  dataPtType: UINT256_DATA_PT_TYPE,
}, value);

describe('MemoryPt MemoryLoad geometry', () => {
  it('derives the right-shifted partial-view contribution once', () => {
    const memoryPt = new MemoryPt();
    memoryPt.write(4, 4, wordPt(0x11223344n));

    const [geometry] = memoryPt.getDataAlias(5, 2);

    expect(geometry).toMatchObject({
      shiftMagnitude: 1,
      direction: 1,
      ownershipMask: 0b11n,
      maskedFragmentValue: 0x2233n,
    });
  });

  it('preserves an unshifted complete view as one owned word fragment', () => {
    const memoryPt = new MemoryPt();
    memoryPt.write(0, 4, wordPt(0x11223344n));

    const [geometry] = memoryPt.getDataAlias(0, 4);

    expect(geometry).toMatchObject({
      shiftMagnitude: 0,
      direction: 0,
      ownershipMask: 0b1111n,
      maskedFragmentValue: 0x11223344n,
    });
  });
});
