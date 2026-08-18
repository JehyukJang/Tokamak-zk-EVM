import { describe, expect, it } from 'vitest';

import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import { MemoryPt } from '../../../core/src/synthesizer/dataStructure/memoryPt.ts';
import {
  ContextManager,
  OBSERVATION_DEFINITIONS,
  type MessageContext,
} from '../../../core/src/synthesizer/handlers/contextManager.ts';
import { UINT256_DATA_PT_TYPE } from '../../../core/src/synthesizer/types/dataStructure.ts';

const word = (value: bigint, source: number, wireIndex: number) => DataPtFactory.create({
  source,
  wireIndex,
  dataPtType: UINT256_DATA_PT_TYPE,
}, value);

const context = (): MessageContext => ({
  messageContextIdentity: 3,
  codeContextIdentity: 7,
  returnDataRevision: 11,
  stackPt: {} as never,
  memoryPt: new MemoryPt(),
  callerPt: word(0n, 0, 0),
  codeAddressPt: word(0n, 0, 0),
  storageAddressPt: word(0n, 0, 0),
  returnDataMemoryPts: [],
  returnDataByteLength: 0,
  callDataMemoryPts: [],
  callDataByteLength: 0,
  prevInterpreterStep: null,
  resultMemoryPts: [],
  resultDataByteLength: 0,
});

describe('semantic observation policy materialization', () => {
  it('uses the declared dependency order and exact operand wire identities', () => {
    const contextManager = new ContextManager({} as never);
    const messageContext = context();
    const targetPt = word(123n, 17, 2);

    const policy = contextManager.createObservationCachePolicy(
      OBSERVATION_DEFINITIONS.balance,
      messageContext,
      [targetPt],
    );

    expect(policy).toMatchObject({
      kind: 'semantic-observation',
      key: {
        observation: OBSERVATION_DEFINITIONS.balance.id,
        parts: [
          { dependency: 'balance-revision', value: 0 },
          {
            dependency: 'operand-wire',
            source: 17,
            wireIndex: 2,
            dataPtType: UINT256_DATA_PT_TYPE,
          },
        ],
      },
    });
  });

  it('rejects a request whose operand count differs from its definition', () => {
    const contextManager = new ContextManager({} as never);

    expect(() => contextManager.createObservationCachePolicy(
      OBSERVATION_DEFINITIONS.balance,
      context(),
    )).toThrow('BALANCE expects 1 observation operands, but got 0');
  });
});
