import { createAddressFromBigInt, bigIntToBytes, setLengthLeft } from '@ethereumjs/util';
import { describe, expect, it, vi } from 'vitest';

import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import { StackPt } from '../../../core/src/synthesizer/dataStructure/index.ts';
import { StateManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import type {
  InitialStorageRead,
  StorageCacheEntry,
} from '../../../core/src/synthesizer/handlers/storageAccess.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/index.ts';

const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
  sourceBitSize = 256,
): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const equalBatchInfo = {
  id: 14,
  name: 'EqualBatch' as const,
  NWires: 9,
  NInWires: 8,
  NOutWires: 0,
  inWireIndex: 1,
  outWireIndex: 1,
  flattenMap: [],
};

const createState = (): StateManager => {
  const parent = {
    subcircuitLibrary: {
      subcircuitInfoByName: new Map([['EqualBatch', equalBatchInfo]]),
    },
  } as any;
  return new StateManager(parent);
};

const createStorageHarness = (initialValue: bigint) => {
  let storageValue = initialValue;
  let nextSource = 100;
  const addressValue = 0x1234n;
  const address = createAddressFromBigInt(addressValue);

  const stateManager = {
    getStorage: vi.fn(async () => setLengthLeft(bigIntToBytes(storageValue), 32)),
  };
  const parent: any = {
    cachedOpts: { stateManager },
    subcircuitLibrary: {
      subcircuitInfoByName: new Map([['EqualBatch', equalBatchInfo]]),
    },
    place: vi.fn(),
    placeArith: vi.fn(() => []),
    addReservedVariableToBufferIn: vi.fn((_name: string, value: bigint) =>
      dataPt(value, nextSource++, 0, 255),
    ),
  };
  parent.state = new StateManager(parent);

  return {
    address,
    addressValue,
    handler: new InstructionHandler(parent),
    parent,
    setStorageValue: (value: bigint) => {
      storageValue = value;
    },
  };
};

describe('StateManager storage tracking', () => {
  it('restores only the storage cache and retains initial SLOAD records on frame failure', () => {
    const state = createState();
    const parentEntry: StorageCacheEntry = {
      canonicalAddressPt: dataPt(1n, 1),
      canonicalKeyPt: dataPt(2n, 2),
      latestValuePt: dataPt(3n, 3),
      dirty: false,
    };
    state.storageCache.set(1n, 2n, parentEntry);
    state.storageCache.beginFrame(1);

    state.storageCache.set(1n, 2n, {
      ...parentEntry,
      latestValuePt: dataPt(4n, 4),
      dirty: true,
    });
    const childRead: InitialStorageRead = {
      addressPt: dataPt(1n, 5),
      keyPt: dataPt(6n, 6),
      valuePt: dataPt(7n, 7),
    };
    state.initialStorageReads.add(1n, 6n, childRead);
    state.storageCache.set(1n, 6n, {
      canonicalAddressPt: childRead.addressPt,
      canonicalKeyPt: childRead.keyPt,
      latestValuePt: childRead.valuePt,
      dirty: false,
    });

    state.storageCache.completeFrame(1, false);

    expect(state.storageCache.get(1n, 2n)).toMatchObject({
      latestValuePt: { value: 3n, source: 3 },
      dirty: false,
    });
    expect(state.storageCache.get(1n, 6n)).toBeUndefined();
    expect(state.initialStorageReads.get(1n, 6n)).toMatchObject({
      valuePt: { value: 7n, source: 7 },
    });
    expect(state.initialStorageReads.entries).toHaveLength(1);
  });

  it('keeps a successful child update until an enclosing frame rolls back', () => {
    const state = createState();
    const baseEntry: StorageCacheEntry = {
      canonicalAddressPt: dataPt(1n, 1),
      canonicalKeyPt: dataPt(2n, 2),
      latestValuePt: dataPt(3n, 3),
      dirty: false,
    };
    state.storageCache.set(1n, 2n, baseEntry);
    state.storageCache.beginFrame(0);
    state.storageCache.beginFrame(1);
    state.storageCache.set(1n, 2n, {
      ...baseEntry,
      latestValuePt: dataPt(8n, 8),
      dirty: true,
    });

    state.storageCache.completeFrame(1, true);
    expect(state.storageCache.get(1n, 2n)).toMatchObject({
      latestValuePt: { value: 8n },
      dirty: true,
    });

    state.storageCache.completeFrame(0, false);
    expect(state.storageCache.get(1n, 2n)).toMatchObject({
      latestValuePt: { value: 3n },
      dirty: false,
    });
  });
});

describe('InstructionHandler storage cache', () => {
  it('registers one initial SLOAD and reuses its value DataPt on repeated reads', async () => {
    const { addressValue, handler, parent } = createStorageHarness(5n);
    const firstAddressPt = dataPt(addressValue, 30);
    const firstKeyPt = dataPt(9n, 31);

    const firstValuePt = await handler.loadStorage(firstAddressPt, firstKeyPt, 5n);
    const secondValuePt = await handler.loadStorage(
      dataPt(addressValue, 40),
      dataPt(9n, 41),
      5n,
    );

    expect(parent.state.initialStorageReads.entries).toHaveLength(1);
    expect(parent.addReservedVariableToBufferIn).toHaveBeenCalledTimes(1);
    expect(secondValuePt).toMatchObject({
      source: firstValuePt.source,
      wireIndex: firstValuePt.wireIndex,
      value: firstValuePt.value,
    });
    const equalBatchCalls = parent.placeArith.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    );
    expect(equalBatchCalls).toHaveLength(1);
    expect(parent.placeArith).toHaveBeenCalledWith(
      'EqualBatch',
      [
        expect.objectContaining({ source: 40, value: addressValue }),
        expect.objectContaining({ source: 41, value: 9n }),
        expect.objectContaining({ source: 30, value: addressValue }),
        expect.objectContaining({ source: 31, value: 9n }),
      ],
    );
  });

  it('reuses a retained initial SLOAD after its frame is rolled back', async () => {
    const { addressValue, handler, parent } = createStorageHarness(6n);
    parent.state.storageCache.beginFrame(1);
    const firstValuePt = await handler.loadStorage(
      dataPt(addressValue, 42),
      dataPt(10n, 43),
      6n,
    );

    parent.state.storageCache.completeFrame(1, false);
    expect(parent.state.storageCache.get(addressValue, 10n)).toBeUndefined();

    const secondValuePt = await handler.loadStorage(
      dataPt(addressValue, 44),
      dataPt(10n, 45),
      6n,
    );

    expect(parent.state.initialStorageReads.entries).toHaveLength(1);
    expect(parent.addReservedVariableToBufferIn).toHaveBeenCalledTimes(1);
    expect(secondValuePt).toMatchObject({
      source: firstValuePt.source,
      wireIndex: firstValuePt.wireIndex,
      value: 6n,
    });
    expect(parent.placeArith.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    )).toHaveLength(1);
  });

  it('updates the cached value on SSTORE and does not add an initial SLOAD afterward', async () => {
    const { addressValue, handler, parent, setStorageValue } = createStorageHarness(11n);
    const keyPt = dataPt(7n, 50);
    const writePt = dataPt(11n, 51);

    await handler.storeStorage(dataPt(addressValue, 53), keyPt, writePt);
    setStorageValue(11n);
    const loadedPt = await handler.loadStorage(
      dataPt(addressValue, 54),
      dataPt(7n, 55),
      11n,
    );

    expect(parent.state.initialStorageReads.entries).toHaveLength(0);
    expect(parent.addReservedVariableToBufferIn).not.toHaveBeenCalled();
    expect(parent.state.storageCache.get(addressValue, 7n)).toMatchObject({
      latestValuePt: { source: 51, value: 11n },
      dirty: true,
    });
    expect(loadedPt).toMatchObject({ source: 51, value: 11n });
    expect(parent.placeArith.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    )).toHaveLength(1);
  });

  it('rejects a storageAddressPt that does not match the EVM storage address', async () => {
    const { address, handler, parent } = createStorageHarness(5n);
    const stackPt = new StackPt();
    stackPt.push(dataPt(1n, 61));

    await expect(handler.handleSysFlow([1n], 5n, {
      op: 'SLOAD',
      stackPt,
      thisAddress: address,
      thisContext: { storageAddressPt: dataPt(0x9999n, 60) },
    } as any)).rejects.toThrow('Storage address mismatch');

    expect(parent.cachedOpts.stateManager.getStorage).not.toHaveBeenCalled();
    expect(parent.state.initialStorageReads.entries).toHaveLength(0);
  });
});
