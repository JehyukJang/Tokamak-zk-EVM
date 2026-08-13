import { afterEach, describe, expect, it, vi } from 'vitest';

import { Synthesizer } from '../../../core/src/synthesizer/synthesizer.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { ContextManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import { UINT256_DATA_PT_TYPE } from '../../../core/src/synthesizer/types/dataStructure.ts';

type EventListener = (data: any, resolve?: () => void) => void;

class TestEventEmitter {
  private listeners = new Map<string, EventListener>();

  on(event: string, listener: EventListener): this {
    this.listeners.set(event, listener);
    return this;
  }

  async emit(event: string, data: any): Promise<void> {
    const listener = this.listeners.get(event);
    if (listener === undefined) {
      throw new Error(`Missing listener for ${event}`);
    }
    await new Promise<void>((resolve, reject) => {
      try {
        listener(data, resolve);
      } catch (err) {
        reject(err);
      }
    });
  }
}

const createBareSynthesizer = (): Synthesizer => {
  const synthesizer = Object.create(Synthesizer.prototype) as Synthesizer;
  Object.defineProperty(synthesizer, 'cachedOpts', {
    value: {
      signedTransaction: {},
      stateManager: {},
    },
  });
  vi.spyOn(synthesizer, 'getReservedVariableFromBuffer').mockReturnValue({ value: 1n } as any);
  return synthesizer;
};

const dataPt = (value: bigint, source: number) => DataPtFactory.create({
  source,
  wireIndex: 0,
  dataPtType: UINT256_DATA_PT_TYPE,
}, value);

const createContext = () => new ContextManager({
  callerPt: dataPt(1n, 1),
  codeAddressPt: dataPt(2n, 2),
  storageAddressPt: dataPt(3n, 3),
  callDataMemoryPts: [],
  callDataByteLength: 0,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Synthesizer VM lifecycle', () => {
  it('emits final dirty storage triples during successful transaction finalization', () => {
    const vmEvents = new TestEventEmitter();
    const evmEvents = new TestEventEmitter();

    const synthesizer = createBareSynthesizer();
    const addressPt = { source: 1, wireIndex: 0, sourceBitSize: 256, value: 1n };
    const keyPt = { source: 2, wireIndex: 0, sourceBitSize: 256, value: 2n };
    const valuePt = { source: 3, wireIndex: 0, sourceBitSize: 256, value: 3n };
    Object.defineProperty(synthesizer, '_state', {
      value: {
        storageCache: {
          dirtyEntries: [{
            canonicalAddressPt: addressPt,
            canonicalKeyPt: keyPt,
            latestValuePt: valuePt,
            dirty: true,
          }],
        },
      },
    });
    const addStorageOutput = vi.spyOn(synthesizer, 'addReservedVariableToBufferOut')
      .mockReturnValue({} as any);
    ;(synthesizer as any)._finalizeStorageStore()

    expect(addStorageOutput.mock.calls).toEqual([
      ['SSTORE_ADDRESS', addressPt, true],
      ['SSTORE_KEY', keyPt, true],
      ['SSTORE_VALUE', valuePt, true],
    ]);
  });

  it('records the first step-handler error and skips later handlers', async () => {
    const vmEvents = new TestEventEmitter();
    const evmEvents = new TestEventEmitter();

    const synthesizer = createBareSynthesizer();
    const firstError = new Error('first Synthesizer failure');
    const applyHandler = vi.fn().mockRejectedValue(firstError);
    (synthesizer as any)._applySynthesizerHandler = applyHandler;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    ;(synthesizer as any)._attachSynthesizerToVM({ events: vmEvents, evm: { events: evmEvents } })
    const step = { opcode: { name: 'ADD' } };
    await evmEvents.emit('step', step);
    await evmEvents.emit('step', step);

    expect((synthesizer as any)._eventHandlerError).toBe(firstError)
    expect(applyHandler).toHaveBeenCalledTimes(1);
  });

  it('records an afterMessage handler error', async () => {
    const vmEvents = new TestEventEmitter();
    const evmEvents = new TestEventEmitter();

    const synthesizer = createBareSynthesizer();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ;(synthesizer as any)._attachSynthesizerToVM({ events: vmEvents, evm: { events: evmEvents } })
    await evmEvents.emit('afterMessage', { execResult: { runState: undefined } });

    expect((synthesizer as any)._eventHandlerError).toEqual(
      expect.objectContaining({ message: 'Failed to capture the final state' }),
    )
  });

  it('copies a child result into its parent returndata boundary', () => {
    const synthesizer = createBareSynthesizer();
    const parentContext = createContext();
    const childContext = createContext();
    const childResultPt = dataPt(0x11223344n, 9);
    childContext.resultMemoryPts = [{
      memByteOffset: 0,
      containerByteSize: 4,
      dataPt: childResultPt,
    }];
    childContext.resultDataByteLength = 4;
    Object.defineProperty(synthesizer, '_state', {
      value: { contextByDepth: [parentContext, childContext] },
    });

    ;(synthesizer as any)._returnMessageCall(1)

    expect(parentContext.returnDataByteLength).toBe(4);
    expect(parentContext.returnDataMemoryPts).toEqual(childContext.resultMemoryPts);
    expect(parentContext.returnDataMemoryPts[0]!.dataPt).not.toBe(childResultPt);
  });
});
