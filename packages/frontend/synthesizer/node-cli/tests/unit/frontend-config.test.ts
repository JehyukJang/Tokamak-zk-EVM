import { describe, expect, it } from 'vitest';

import { parseFrontendConfig } from '../../../core/src/subcircuit/utils.ts';

const validConfig = {
  nTxIn: 6,
  nStorageLoad: 40,
  nLogOut: 50,
  nStorageStore: 30,
  nBlockIn: 24,
  nPrvIn: 80,
  nEVMIn: 530,
  nPoseidonInputs: 2,
  nPoseidonBatch: 1,
  nAccumulation: 32,
  nPrevBlockHashes: 4,
  nJubjubExpBatch: 37,
  nSubExpBatch: 8,
  nEqualBatch: 2,
};

describe('frontend configuration parsing', () => {
  it('preserves input-wire buffer capacities without conversion', () => {
    expect(parseFrontendConfig(validConfig)).toEqual(validConfig);
  });

  it('requires nBlockIn', () => {
    const { nBlockIn: _nBlockIn, ...missingBlockCapacity } = validConfig;

    expect(() => parseFrontendConfig(missingBlockCapacity)).toThrow(
      'Invalid values in frontendCfg.json: all keys must be finite numbers',
    );
  });
});
