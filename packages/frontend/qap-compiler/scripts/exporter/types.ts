
// Required Circom constants from subcircuits/circom/constants.circom.
export const REQUIRED_CIRCOM_KEYS = [
  'nTxIn',
  'nStorageLoad',
  'nLogOut',
  'nStorageStore',
  'nBlockIn',
  'nEVMIn',
  'nPrvIn',
  'nPrivateMessageInputs',
  'nPoseidonInputs',
  'nPoseidonBatch',
  'nPrevBlockHashes',
] as const;
export type CircomKey = typeof REQUIRED_CIRCOM_KEYS[number];

export type CircomConstMap = Record<CircomKey, number>;
