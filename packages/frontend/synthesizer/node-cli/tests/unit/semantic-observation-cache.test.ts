import { describe, expect, it } from 'vitest';

import { DataPtFactory } from '../../../core/src/synthesizer/dataStructure/dataPt.ts';
import {
  ContextManager,
  OBSERVATION_DEFINITIONS,
  type MessageContext,
} from '../../../core/src/synthesizer/handlers/contextManager.ts';
import {
  PlacementManager,
  type ObservationDefinition,
} from '../../../core/src/synthesizer/handlers/placementManager.ts';
import {
  UINT32_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
  type DataPt,
} from '../../../core/src/synthesizer/types/dataStructure.ts';

const word = (value: bigint, source: number, wireIndex: number): DataPt => DataPtFactory.create({
  source,
  wireIndex,
  dataPtType: UINT256_DATA_PT_TYPE,
}, value);

const context = (): MessageContext => ({
  messageContextIdentity: 3,
  codeContextIdentity: 7,
  returnDataRevision: 11,
  stackPt: {} as never,
  memoryPt: {} as never,
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

const createPlacementManager = (): PlacementManager => Object.assign(
  Object.create(PlacementManager.prototype),
  {
    _placements: Array.from({ length: 7 }, () => ({
      name: 'bufferEVMIn', usage: 'test', subcircuitId: 0, inPts: [], outPts: [],
    })),
    _cachedSemanticEVMIn: new Map(),
  },
) as PlacementManager;

describe('semantic observation cache', () => {
  it('materializes declared numeric arguments and exact operand wire identities', () => {
    const contextManager = new ContextManager({} as never);
    const targetPt = word(123n, 17, 2);
    const codeOffsetPt = word(32n, 18, 4);

    const policy = contextManager.createObservationCachePolicy(
      OBSERVATION_DEFINITIONS.extCodeCopyChunk,
      context(),
      [targetPt, codeOffsetPt],
      [1],
    );

    expect(policy).toMatchObject({
      kind: 'semantic-observation',
      key: {
        definition: OBSERVATION_DEFINITIONS.extCodeCopyChunk,
        numericValues: [1],
        operandWires: [
          { source: 17, wireIndex: 2, dataPtType: UINT256_DATA_PT_TYPE },
          { source: 18, wireIndex: 4, dataPtType: UINT256_DATA_PT_TYPE },
        ],
      },
    });
  });

  it('reuses an exact semantic key and rejects a mismatched observation', () => {
    const placementManager = createPlacementManager();
    const definition: ObservationDefinition = {
      id: Symbol('test-observation'),
      name: 'test observation',
      contextDependencies: [],
      operandCount: 0,
      numericArgumentCount: 0,
    };
    const policy = {
      kind: 'semantic-observation' as const,
      key: { definition, numericValues: [], operandWires: [] },
    };

    const first = placementManager.loadArbitraryStatic(
      9n,
      UINT256_DATA_PT_TYPE,
      'Test observation',
      policy,
    );
    const reused = placementManager.loadArbitraryStatic(
      9n,
      UINT256_DATA_PT_TYPE,
      'Test observation',
      policy,
    );

    expect(reused).toMatchObject({ source: first.source, wireIndex: first.wireIndex });
    expect(() => placementManager.loadArbitraryStatic(
      10n,
      UINT256_DATA_PT_TYPE,
      'Test observation',
      policy,
    )).toThrow('test observation observation disagrees with its cached value or type');
    expect(() => placementManager.loadArbitraryStatic(
      9n,
      UINT32_DATA_PT_TYPE,
      'Test observation',
      policy,
    )).toThrow('test observation observation disagrees with its cached value or type');
  });
});
