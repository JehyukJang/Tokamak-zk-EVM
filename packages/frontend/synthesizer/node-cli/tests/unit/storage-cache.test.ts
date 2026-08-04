import { createAddressFromBigInt, bigIntToBytes, setLengthLeft } from '@ethereumjs/util';
import { describe, expect, it, vi } from 'vitest';

import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import { DataPtFactory, StackPt } from '../../../core/src/synthesizer/dataStructure/index.ts';
import { StateManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import { VARIABLE_DESCRIPTION } from '../../../core/src/synthesizer/types/buffers.ts';
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

const logOutInfo = {
  id: 0,
  name: 'bufferLogOut' as const,
  NWires: 129,
  NInWires: 64,
  NOutWires: 64,
  inWireIndex: 65,
  outWireIndex: 1,
  flattenMap: [],
};

const createState = (): StateManager => {
  const parent = {
    subcircuitLibrary: {
      subcircuitInfoByName: new Map([
        ['bufferLogOut', logOutInfo],
        ['EqualBatch', equalBatchInfo],
      ]),
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
    placeArithComposition: vi.fn(() => []),
    addReservedVariableToBufferIn: vi.fn((_name: string, value: bigint) =>
      dataPt(value, nextSource++),
    ),
    addReservedVariableToBufferOut: vi.fn((_name: string, valuePt: DataPt) =>
      dataPt(valuePt.value, nextSource++),
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
  it('accepts a full 256-bit initial storage value', () => {
    const value = (1n << 256n) - 1n;

    expect(DataPtFactory.create(VARIABLE_DESCRIPTION.STORAGE_READ, value)).toMatchObject({
      sourceBitSize: 256,
      value,
    });
  });

  it('exposes only dirty entries for final storage output', () => {
    const state = createState();
    state.storageCache.set(1n, 2n, {
      canonicalAddressPt: dataPt(1n, 1),
      canonicalKeyPt: dataPt(2n, 2),
      latestValuePt: dataPt(3n, 3),
      dirty: false,
    });
    state.storageCache.set(4n, 5n, {
      canonicalAddressPt: dataPt(4n, 4),
      canonicalKeyPt: dataPt(5n, 5),
      latestValuePt: dataPt(6n, 6),
      dirty: true,
    });

    expect(state.storageCache.dirtyEntries.map((entry) => [
      entry.canonicalAddressPt.value,
      entry.canonicalKeyPt.value,
      entry.latestValuePt.value,
    ])).toEqual([[4n, 5n, 6n]]);
  });

  it('coordinates nested storage-cache and LOG_OUT frame rollback', () => {
    const state = createState();
    const baseEntry: StorageCacheEntry = {
      canonicalAddressPt: dataPt(1n, 1),
      canonicalKeyPt: dataPt(2n, 2),
      latestValuePt: dataPt(3n, 3),
      dirty: false,
    };
    state.place('bufferLogOut', [], [], 'test LOG_OUT');
    state.storageCache.set(1n, 2n, baseEntry);

    state.beginFrame(0);
    state.storageCache.set(1n, 2n, {
      ...baseEntry,
      latestValuePt: dataPt(4n, 4),
      dirty: true,
    });
    state.addWirePairToBufferIn(dataPt(10n, 10), dataPt(10n, 0, 0), true);

    state.beginFrame(1);
    state.storageCache.set(1n, 2n, {
      ...baseEntry,
      latestValuePt: dataPt(5n, 5),
      dirty: true,
    });
    state.addWirePairToBufferIn(dataPt(11n, 11), dataPt(11n, 0, 1), true);

    state.completeFrame(1, true);
    expect(state.placements[0]).toMatchObject({
      inPts: [{ value: 10n }, { value: 11n }],
      outPts: [{ value: 10n }, { value: 11n }],
    });
    expect(state.storageCache.get(1n, 2n)?.latestValuePt.value).toBe(5n);

    state.completeFrame(0, false);
    expect(state.placements).toHaveLength(1);
    expect(state.placements[0]).toMatchObject({ inPts: [], outPts: [] });
    expect(state.storageCache.get(1n, 2n)).toMatchObject({
      latestValuePt: { value: 3n },
      dirty: false,
    });
  });

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

describe('InstructionHandler opcode registration', () => {
  it('registers the existing REVERT handler at opcode 0xfd', () => {
    const { handler } = createStorageHarness(0n);

    expect(handler.synthesizerHandlers.get(0xfd)).toBeTypeOf('function');
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
    expect(parent.addReservedVariableToBufferIn.mock.calls.map(
      ([name]: [string]) => name,
    )).toEqual(['STORAGE_READ']);
    expect(parent.addReservedVariableToBufferOut.mock.calls.map(
      ([name, valuePt]: [string, DataPt]) => [name, valuePt.source, valuePt.value],
    )).toEqual([
      ['SLOAD_ADDRESS', 30, addressValue],
      ['SLOAD_KEY', 31, 9n],
      ['SLOAD_VALUE', 100, 5n],
    ]);
    expect(parent.state.initialStorageReads.entries[0]).toMatchObject({
      addressPt: { source: 30, value: addressValue },
      keyPt: { source: 31, value: 9n },
      valuePt: { source: 100, value: 5n },
    });
    expect(secondValuePt).toMatchObject({
      source: firstValuePt.source,
      wireIndex: firstValuePt.wireIndex,
      value: firstValuePt.value,
    });
    const equalBatchCalls = parent.placeArithComposition.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    );
    expect(equalBatchCalls).toHaveLength(1);
    expect(equalBatchCalls[0]).toEqual([
      'EqualBatch',
      [
        expect.objectContaining({ source: 40, value: addressValue }),
        expect.objectContaining({ source: 41, value: 9n }),
        expect.objectContaining({ source: 30, value: addressValue }),
        expect.objectContaining({ source: 31, value: 9n }),
      ],
    ]);
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
    expect(parent.addReservedVariableToBufferOut).toHaveBeenCalledTimes(3);
    expect(secondValuePt).toMatchObject({
      source: firstValuePt.source,
      wireIndex: firstValuePt.wireIndex,
      value: 6n,
    });
    expect(parent.placeArithComposition.mock.calls.filter(
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
    expect(parent.addReservedVariableToBufferOut).not.toHaveBeenCalled();
    expect(parent.state.storageCache.get(addressValue, 7n)).toMatchObject({
      latestValuePt: { source: 51, value: 11n },
      dirty: true,
    });
    expect(loadedPt).toMatchObject({ source: 51, value: 11n });
    expect(parent.placeArithComposition.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    )).toHaveLength(1);
  });

  it('keeps only the latest value DataPt across repeated SSTORE operations', async () => {
    const { addressValue, handler, parent, setStorageValue } = createStorageHarness(10n);

    await handler.storeStorage(
      dataPt(addressValue, 70),
      dataPt(8n, 71),
      dataPt(10n, 72),
    );
    setStorageValue(20n);
    await handler.storeStorage(
      dataPt(addressValue, 73),
      dataPt(8n, 74),
      dataPt(20n, 75),
    );
    setStorageValue(30n);
    await handler.storeStorage(
      dataPt(addressValue, 76),
      dataPt(8n, 77),
      dataPt(30n, 78),
    );

    expect(parent.state.storageCache.dirtyEntries).toEqual([
      expect.objectContaining({
        canonicalAddressPt: expect.objectContaining({ source: 70, value: addressValue }),
        canonicalKeyPt: expect.objectContaining({ source: 71, value: 8n }),
        latestValuePt: expect.objectContaining({ source: 78, value: 30n }),
        dirty: true,
      }),
    ]);
    const equalBatchCalls = parent.placeArithComposition.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    );
    expect(equalBatchCalls.map(([, inPts]: [string, DataPt[]]) =>
      inPts.map((pt) => pt.source)
    )).toEqual([
      [73, 74, 70, 71],
      [76, 77, 70, 71],
    ]);
    expect(parent.addReservedVariableToBufferOut).not.toHaveBeenCalled();
  });

  it('keeps the initial SLOAD record while replacing the cached value on SSTORE', async () => {
    const { addressValue, handler, parent, setStorageValue } = createStorageHarness(12n);
    const initialValuePt = await handler.loadStorage(
      dataPt(addressValue, 80),
      dataPt(9n, 81),
      12n,
    );

    setStorageValue(22n);
    await handler.storeStorage(
      dataPt(addressValue, 82),
      dataPt(9n, 83),
      dataPt(22n, 84),
    );

    expect(parent.state.initialStorageReads.entries).toEqual([
      expect.objectContaining({
        addressPt: expect.objectContaining({ source: 80, value: addressValue }),
        keyPt: expect.objectContaining({ source: 81, value: 9n }),
        valuePt: expect.objectContaining({
          source: initialValuePt.source,
          value: 12n,
        }),
      }),
    ]);
    expect(parent.state.storageCache.dirtyEntries).toEqual([
      expect.objectContaining({
        canonicalAddressPt: expect.objectContaining({ source: 80, value: addressValue }),
        canonicalKeyPt: expect.objectContaining({ source: 81, value: 9n }),
        latestValuePt: expect.objectContaining({ source: 84, value: 22n }),
        dirty: true,
      }),
    ]);
    expect(parent.placeArithComposition.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    )[0]?.[1].map((pt: DataPt) => pt.source)).toEqual([82, 83, 80, 81]);
    expect(parent.addReservedVariableToBufferOut).toHaveBeenCalledTimes(3);
  });

  it('tracks distinct address and key pairs independently', async () => {
    const { addressValue, handler, parent, setStorageValue } = createStorageHarness(1n);
    await handler.loadStorage(dataPt(addressValue, 90), dataPt(1n, 91), 1n);

    setStorageValue(2n);
    await handler.loadStorage(dataPt(addressValue + 1n, 92), dataPt(1n, 93), 2n);

    setStorageValue(3n);
    await handler.storeStorage(
      dataPt(addressValue, 94),
      dataPt(1n, 95),
      dataPt(3n, 96),
    );

    setStorageValue(4n);
    await handler.storeStorage(
      dataPt(addressValue, 97),
      dataPt(2n, 98),
      dataPt(4n, 99),
    );

    expect(parent.state.initialStorageReads.entries.map((entry: InitialStorageRead) => [
      entry.addressPt.value,
      entry.keyPt.value,
      entry.valuePt.value,
    ])).toEqual([
      [addressValue, 1n, 1n],
      [addressValue + 1n, 1n, 2n],
    ]);
    expect(parent.state.storageCache.dirtyEntries.map((entry: StorageCacheEntry) => [
      entry.canonicalAddressPt.value,
      entry.canonicalKeyPt.value,
      entry.latestValuePt.value,
    ])).toEqual([
      [addressValue, 1n, 3n],
      [addressValue, 2n, 4n],
    ]);
    expect(parent.placeArithComposition.mock.calls.filter(
      (call: any[]) => call[0] === 'EqualBatch',
    )).toHaveLength(1);
    expect(parent.addReservedVariableToBufferOut).toHaveBeenCalledTimes(6);
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
