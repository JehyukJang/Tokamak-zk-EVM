import { createAddressFromBigInt } from '@ethereumjs/util';
import type { InterpreterStep, Message } from '@ethereumjs/evm';
import { describe, expect, it, vi } from 'vitest';

import type { Operator } from '../../../core/src/subcircuit/configuredTypes.ts';
import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import { ContextManager } from '../../../core/src/synthesizer/handlers/stateManager.ts';
import {
  UINT256_DATA_PT_TYPE,
  type DataPt,
  type DataPtType,
} from '../../../core/src/synthesizer/types/dataStructure.ts';
import type { PreparedComposition } from '../../../core/src/synthesizer/types/placements.ts';

const ADDRESS_MASK = (1n << 160n) - 1n;
const CALL_OPCODES = ['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL'] as const;

type CallOpcode = typeof CALL_OPCODES[number];
type ArithmeticCall = {
  name: Operator;
  inPts: DataPt[];
};
const dataPt = (
  value: bigint,
  source: number,
  wireIndex = 0,
  dataPtType: DataPtType = UINT256_DATA_PT_TYPE,
): DataPt => DataPtFactory.create({ source, wireIndex, dataPtType }, value);

const callOperands = (opcode: CallOpcode, target: bigint): bigint[] =>
  opcode === 'CALL' || opcode === 'CALLCODE'
    ? [100_000n, target, 0n, 0n, 0n, 0n, 0n]
    : [100_000n, target, 0n, 0n, 0n, 0n];

const createHarness = (
  opcode: CallOpcode,
  rawTarget: bigint,
  options: {
    stackTarget?: bigint;
    maskedResults?: DataPt[];
  } = {},
) => {
  const parentContext = new ContextManager({
    callerPt: dataPt(0x1111n, 1),
    codeAddressPt: dataPt(0x2222n, 2),
    storageAddressPt: dataPt(0x3333n, 3),
    callDataMemoryPts: [],
    callDataByteLength: 0,
  });
  const interpreterOperands = callOperands(opcode, rawTarget);
  const symbolicOperands = callOperands(opcode, options.stackTarget ?? rawTarget);
  for (const [wireIndex, value] of symbolicOperands.slice().reverse().entries()) {
    parentContext.stackPt.push(dataPt(value, 10, wireIndex));
  }
  parentContext.prevInterpreterStep = {
    opcode: { name: opcode },
    stack: interpreterOperands,
    memory: new Uint8Array(0),
  } as InterpreterStep;

  const maskPt = dataPt(ADDRESS_MASK, 5, 7, UINT256_DATA_PT_TYPE);
  const normalizedTarget = rawTarget & ADDRESS_MASK;
  const maskedResults = options.maskedResults ?? [dataPt(normalizedTarget, 99, 0)];
  const arithmeticCalls: ArithmeticCall[] = [];
  const prepareSingleStepArithmeticComposition = vi.fn((name: Operator, inPts: DataPt[]) => {
    arithmeticCalls.push({ name, inPts });
    return {
      operation: name,
      operands: inPts,
      resultPts: maskedResults,
      steps: [{ inPts, outPts: maskedResults }],
    } satisfies PreparedComposition;
  });
  const beginFrame = vi.fn();
  const recordMessageCodeAddress = vi.fn();
  const getReservedVariableFromBuffer = vi.fn(() => maskPt);
  const state = {
    contextByDepth: [parentContext] as ContextManager[],
    beginFrame,
    recordMessageCodeAddress,
  };
  const parent = {
    placements: [],
    getReservedVariableFromBuffer,
    placeComposition: vi.fn(),
  };
  const handler = new InstructionHandler(parent as never, state as never, {} as never);
  vi.spyOn(handler as never, '_prepareSingleStepArithmeticComposition' as never)
    .mockImplementation(prepareSingleStepArithmeticComposition as never);
  const message = {
    depth: 1,
    codeAddress: createAddressFromBigInt(normalizedTarget),
    isCreate: false,
    isCompiled: false,
  } as Message;

  return {
    arithmeticCalls,
    beginFrame,
    getReservedVariableFromBuffer,
    maskPt,
    maskedResults,
    message,
    parentContext,
    prepareSingleStepArithmeticComposition,
    recordMessageCodeAddress,
    state,
    handler,
  };
};

describe('CALL-family target-mask topology', () => {
  it.each(CALL_OPCODES)('routes the masked %s target into the child context', (opcode) => {
    const rawTarget = (1n << 200n) | 0x1234n;
    const harness = createHarness(opcode, rawTarget);

    harness.handler.initializeMessageContext(harness.message);

    expect(harness.arithmeticCalls).toHaveLength(1);
    expect(harness.arithmeticCalls[0]).toMatchObject({ name: 'AND' });
    expect(harness.arithmeticCalls[0].inPts[0]).toMatchObject({
      value: rawTarget,
      source: 10,
      wireIndex: opcode === 'CALL' || opcode === 'CALLCODE' ? 5 : 4,
    });
    expect(harness.arithmeticCalls[0].inPts[1]).toEqual(harness.maskPt);
    expect(harness.getReservedVariableFromBuffer).toHaveBeenCalledOnce();
    expect(harness.getReservedVariableFromBuffer).toHaveBeenCalledWith('ADDRESS_MASK');
    expect(harness.beginFrame).toHaveBeenCalledOnce();
    expect(harness.beginFrame).toHaveBeenCalledWith(1);
    expect(harness.recordMessageCodeAddress).toHaveBeenCalledOnce();
    expect(harness.recordMessageCodeAddress).toHaveBeenCalledWith(
      harness.message.codeAddress.toString(),
    );

    const childContext = harness.state.contextByDepth[1];
    expect(childContext.codeAddressPt).toBe(harness.maskedResults[0]);
    expect(childContext.codeAddressPt).toMatchObject({
      value: 0x1234n,
      source: 99,
      wireIndex: 0,
    });
    if (opcode === 'CALL' || opcode === 'STATICCALL') {
      expect(childContext.storageAddressPt).toMatchObject({ source: 99, wireIndex: 0 });
    } else {
      expect(childContext.storageAddressPt).toMatchObject({
        source: harness.parentContext.storageAddressPt.source,
        wireIndex: harness.parentContext.storageAddressPt.wireIndex,
      });
    }
  });

  it('uses the same single-placement shape with and without discarded high bits', () => {
    const shape = (rawTarget: bigint) => {
      const harness = createHarness('CALL', rawTarget);
      harness.handler.initializeMessageContext(harness.message);
      return harness.arithmeticCalls.map(({ name, inPts }) => ({
        name,
        inputs: inPts.map(({ source, wireIndex, dataPtType }) => ({ source, wireIndex, dataPtType })),
      }));
    };

    expect(shape(0x1234n)).toEqual(shape((1n << 200n) | 0x1234n));
  });

  it('rejects a substituted raw target before placing the mask', () => {
    const harness = createHarness('CALL', 0x1234n, { stackTarget: 0x5678n });

    expect(() => harness.handler.initializeMessageContext(harness.message)).toThrow(
      'Raw address to call mismatch',
    );
    expect(harness.prepareSingleStepArithmeticComposition).not.toHaveBeenCalled();
    expect(harness.beginFrame).not.toHaveBeenCalled();
  });

  it('rejects an omitted mask output', () => {
    const harness = createHarness('CALL', 0x1234n, { maskedResults: [] });

    expect(() => harness.handler.initializeMessageContext(harness.message)).toThrow(
      'CALL target mask produced no address',
    );
    expect(harness.prepareSingleStepArithmeticComposition).toHaveBeenCalledOnce();
    expect(harness.beginFrame).not.toHaveBeenCalled();
  });

  it('rejects a masked output that differs from the EthereumJS child address', () => {
    const harness = createHarness('CALL', 0x1234n, {
      maskedResults: [dataPt(0x5678n, 99)],
    });

    expect(() => harness.handler.initializeMessageContext(harness.message)).toThrow(
      'Address to call mismatch between EVM and Synthesizer',
    );
    expect(harness.prepareSingleStepArithmeticComposition).toHaveBeenCalledOnce();
    expect(harness.beginFrame).not.toHaveBeenCalled();
  });
});
