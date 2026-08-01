
// Required Circom constants (qap-compiler/scripts/constants.circom)
export const REQUIRED_CIRCOM_KEYS = [
  'nPubIn',
  'nLogOut',
  'nStorageOut',
  'nPrvIn',
  'nEVMIn',
  'nPoseidonInputs',
  'nMtDepth',
  'nAccumulation',
  'nPrevBlockHashes',
  'nJubjubExpBatch',
  'nSubExpBatch',
  'nEqualBatch',
] as const;
export type CircomKey = typeof REQUIRED_CIRCOM_KEYS[number];

export type CircomConstMap = Record<CircomKey, number>;
