module.exports.S_MAX = 256

const publicWireSegments = [
  { name: 'bufferLogOut', type: 'outUser', boundary: 'l_log_out' },
  { name: 'bufferStorageStore', type: 'outUser', boundary: 'l_storage_store' },
  { name: 'bufferStorageLoad', type: 'outUser', boundary: 'l_storage_load' },
  { name: 'bufferTxIn', type: 'inUser', boundary: 'l_tx_in' },
  { name: 'bufferBlockIn', type: 'inBlock', boundary: 'l_block_in' },
  { name: 'bufferEVMIn', type: 'inFunction', boundary: 'l_evm_in' },
]

const listPublic = new Map(
  publicWireSegments.map(({ name, type }) => [name, type]),
)

module.exports.LIST_PUBLIC = listPublic
module.exports.PUBLIC_WIRE_SEGMENTS = publicWireSegments
