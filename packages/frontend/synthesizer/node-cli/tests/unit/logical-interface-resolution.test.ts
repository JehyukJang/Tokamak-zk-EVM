import { describe, expect, it } from 'vitest';

import { resolveSubcircuitLibraryData } from '../../../core/src/app/subcircuitLibrary.ts';
import type { SubcircuitLibraryData } from '../../../core/src/subcircuit/libraryTypes.ts';

const frontendCfg = {
  nTxIn: 3,
  nStorageLoad: 40,
  nLogOut: 50,
  nStorageStore: 30,
  nBlockIn: 24,
  nPrvIn: 80,
  nEVMIn: 500,
  nPrivateMessageInputs: 29,
  nPoseidonInputs: 2,
  nPoseidonBatch: 1,
  nPrevBlockHashes: 4,
} as const;

const setupParams = {
  l_log_out: 0,
  l_storage_store: 0,
  l_storage_load: 0,
  l_tx_in: 0,
  l_block_in: 0,
  l_evm_in: 0,
  l_free: 0,
  l_user_out: 0,
  l_user: 0,
  l: 0,
  l_D: 0,
  m_D: 0,
  n: 0,
  s_D: 0,
  s_max: 0,
} as const;

function createLibraryData(
  inputWireCount = 5,
  outputWireCount = 2,
): SubcircuitLibraryData {
  return {
    setupParams,
    globalWireList: [],
    frontendCfg: { ...frontendCfg },
    subcircuitInfo: [{
      id: 0,
      name: 'ALU3',
      Nwires: 8,
      Nconsts: 0,
      In_idx: [3, inputWireCount],
      Out_idx: [1, outputWireCount],
      flattenMap: [],
      logicalInterface: {
        inputs: [
          { name: 'selector', logicalType: { kind: 'uint', bits: 32 } },
          { name: 'lhs', logicalType: { kind: 'uint', bits: 256 } },
          { name: 'rhs', logicalType: { kind: 'uint', bits: 256 } },
        ],
        outputs: [
          { name: 'result', logicalType: { kind: 'uint', bits: 256 } },
        ],
      },
    }],
  };
}

describe('logical-interface resolution', () => {
  it('rejects a private-message input count that differs from the reserved input boundary', () => {
    const data = createLibraryData();
    data.frontendCfg.nPrivateMessageInputs = 28;
    expect(() => resolveSubcircuitLibraryData(data)).toThrow(
      'qap-compiler declares 28 private message inputs, but Synthesizer reserves 29',
    );
  });

  it('rejects qap metadata whose input wire count disagrees with its interface', () => {
    expect(() => resolveSubcircuitLibraryData(createLibraryData(4))).toThrow(
      'ALU3 logical interface declares 5 input wires, but qap-compiler provides 4',
    );
  });

  it('treats uint160 as one native field wire', () => {
    const data = createLibraryData(5, 2);
    data.subcircuitInfo[0]!.logicalInterface = {
      inputs: [
        { name: 'contractAddress', logicalType: { kind: 'uint', bits: 160 } },
        { name: 'lhs', logicalType: { kind: 'uint', bits: 256 } },
        { name: 'rhs', logicalType: { kind: 'uint', bits: 256 } },
      ],
      outputs: [
        { name: 'contractAddress', logicalType: { kind: 'uint', bits: 160 } },
      ],
    };
    expect(() => resolveSubcircuitLibraryData(data)).toThrow(
      'ALU3 logical interface declares 1 output wires, but qap-compiler provides 2',
    );
  });
});
