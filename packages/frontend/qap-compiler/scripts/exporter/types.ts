
// Required Circom constants (qap-compiler/scripts/constants.circom)
export const REQUIRED_CIRCOM_KEYS = [
  'nTxIn',
  'nStorageLoad',
  'nLogOut',
  'nStorageStore',
  'nBlockIn',
  'nPrvIn',
  'nEVMIn',
  'nPrivateMessageInputs',
  'nPoseidonInputs',
  'nPoseidonBatch',
  'nAccumulation',
  'nPrevBlockHashes',
  'nSubExpBatch',
  'nEqualBatch',
] as const;
export type CircomKey = typeof REQUIRED_CIRCOM_KEYS[number];

export type CircomConstMap = Record<CircomKey, number>;
