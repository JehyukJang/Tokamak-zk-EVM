import { afterEach, describe, expect, it, vi } from 'vitest';

import { Synthesizer } from '../../../core/src/synthesizer/synthesizer.ts';

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
});
