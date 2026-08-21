module.exports.S_MAX = 512

const BASE_SUBCIRCUIT_NAMES = Object.freeze([
  'bufferLogOut', 'bufferStorageStore', 'bufferStorageLoad', 'bufferTxIn',
  'bufferBlockIn', 'bufferEVMIn', 'bufferPrvIn', 'ALU3', 'ALU4A', 'ALU4B',
  'SHL', 'ADDMODPrepare', 'ADDMODVerify', 'MULMODPrepare', 'MULMODCandidate',
  'MULMODVerify', 'AssertZeroWord', 'SubExp', 'CheckBus256', 'MemoryViewStep',
  'Poseidon', 'FrToLimbsPair', 'TransactionSignaturePoseidonBatch4',
  'TransactionSignaturePointPolicy', 'TransactionSignatureFixedPrefix70',
  'TransactionSignatureChallengeChunks', 'TransactionSignatureVariableFirstBatch32',
  'TransactionSignatureVariableBatch32', 'TransactionSignatureFinal', 'StorageAccess',
  'EQ', 'ISZERO', 'ADD', 'MUL', 'SUB', 'NOT', 'LT', 'GT', 'SLT', 'SGT',
  'AND', 'OR', 'XOR', 'SHR',
])

const CONDITIONAL_SUBCIRCUIT_NAMES = Object.freeze([
  'TransactionSignaturePointPolicy',
  'TransactionSignaturePoseidonTail1',
  'TransactionSignaturePoseidonTail2',
  'TransactionSignaturePointPolicyWithHash',
])

function getTransactionSignaturePoseidonTailLength(numberOfPrivateMessageInputs) {
  if (!Number.isSafeInteger(numberOfPrivateMessageInputs) || numberOfPrivateMessageInputs < 0) {
    throw new Error('nPrivateMessageInputs must be a non-negative safe integer.')
  }
  const remainder = (numberOfPrivateMessageInputs + 2) % 4
  return remainder === 0 ? 4 : remainder
}

function getSubcircuitNames(numberOfPrivateMessageInputs) {
  const names = [...BASE_SUBCIRCUIT_NAMES]
  const tailLength = getTransactionSignaturePoseidonTailLength(numberOfPrivateMessageInputs)
  if (tailLength === 1) {
    names.splice(names.indexOf('TransactionSignaturePointPolicy') + 1, 0, 'TransactionSignaturePoseidonTail1')
  } else if (tailLength === 2) {
    names.splice(names.indexOf('TransactionSignaturePointPolicy') + 1, 0, 'TransactionSignaturePoseidonTail2')
  } else if (tailLength === 4) {
    names[names.indexOf('TransactionSignaturePointPolicy')] = 'TransactionSignaturePointPolicyWithHash'
  }
  return Object.freeze(names)
}

const bufferDeclarations = [
  {
    name: 'bufferLogOut',
    direction: 'out',
    publicPhase: 'user-output',
    boundary: 'l_log_out',
    capacityConstant: 'nLogOut',
  },
  {
    name: 'bufferStorageStore',
    direction: 'out',
    publicPhase: 'user-output',
    boundary: 'l_storage_store',
    capacityConstant: 'nStorageStore',
  },
  {
    name: 'bufferStorageLoad',
    direction: 'out',
    publicPhase: 'user-output',
    boundary: 'l_storage_load',
    capacityConstant: 'nStorageLoad',
  },
  {
    name: 'bufferTxIn',
    direction: 'in',
    publicPhase: 'user-input',
    boundary: 'l_tx_in',
    capacityConstant: 'nTxIn',
  },
  {
    name: 'bufferBlockIn',
    direction: 'in',
    publicPhase: 'block-input',
    boundary: 'l_block_in',
    capacityConstant: 'nBlockIn',
  },
  {
    name: 'bufferEVMIn',
    direction: 'in',
    publicPhase: 'function-input',
    boundary: 'l_evm_in',
    capacityConstant: 'nEVMIn',
  },
  {
    name: 'bufferPrvIn',
    direction: 'in',
    capacityConstant: 'nPrvIn',
  },
]

const publicWirePhases = [
  {
    name: 'user-output',
    region: 'free',
    genericBoundary: 'l_user_out',
    terminalBoundary: 'l_storage_load',
    includeGenericBoundaryInSetup: true,
  },
  {
    name: 'user-input',
    region: 'free',
    genericBoundary: 'l_user',
    terminalBoundary: 'l_tx_in',
    includeGenericBoundaryInSetup: true,
  },
  {
    name: 'block-input',
    region: 'free',
    genericBoundary: 'l_free_actual',
    terminalBoundary: 'l_block_in',
    includeGenericBoundaryInSetup: false,
  },
  {
    name: 'function-input',
    region: 'fixed',
    genericBoundary: 'l',
    terminalBoundary: 'l_evm_in',
    includeGenericBoundaryInSetup: true,
  },
]

const publicWireSegments = bufferDeclarations
  .filter(({ publicPhase }) => publicPhase !== undefined)
  .map(({ name, direction, publicPhase, boundary }) => ({
    name,
    direction,
    phase: publicPhase,
    boundary,
  }))

const setupWireParameterKeys = [
  ...publicWireSegments.map(({ boundary }) => boundary),
  'l_free',
  ...publicWirePhases
    .filter(({ includeGenericBoundaryInSetup }) => includeGenericBoundaryInSetup)
    .map(({ genericBoundary }) => genericBoundary),
  'l_D',
  'm_D',
]

const libraryLayout = Object.freeze({
  bufferDeclarations: Object.freeze(bufferDeclarations.map(Object.freeze)),
  publicWirePhases: Object.freeze(publicWirePhases.map(Object.freeze)),
  publicWireSegments: Object.freeze(publicWireSegments.map(Object.freeze)),
  setupWireParameterKeys: Object.freeze(setupWireParameterKeys),
})

module.exports.LIBRARY_LAYOUT = libraryLayout
module.exports.getSubcircuitNames = getSubcircuitNames
module.exports.CONDITIONAL_SUBCIRCUIT_NAMES = CONDITIONAL_SUBCIRCUIT_NAMES
