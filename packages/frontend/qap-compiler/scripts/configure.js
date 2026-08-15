module.exports.S_MAX = 512

const bufferDeclarations = [
  { name: 'bufferLogOut', direction: 'out', publicType: 'outUser', boundary: 'l_log_out' },
  { name: 'bufferStorageStore', direction: 'out', publicType: 'outUser', boundary: 'l_storage_store' },
  { name: 'bufferStorageLoad', direction: 'out', publicType: 'outUser', boundary: 'l_storage_load' },
  { name: 'bufferTxIn', direction: 'in', publicType: 'inUser', boundary: 'l_tx_in' },
  { name: 'bufferBlockIn', direction: 'in', publicType: 'inBlock', boundary: 'l_block_in' },
  { name: 'bufferEVMIn', direction: 'in', publicType: 'inFunction', boundary: 'l_evm_in' },
  { name: 'bufferPrvIn', direction: 'in' },
]

const publicWireSegments = bufferDeclarations
  .filter(({ publicType }) => publicType !== undefined)
  .map(({ name, publicType: type, boundary }) => ({ name, type, boundary }))

const listPublic = new Map(
  publicWireSegments.map(({ name, type }) => [name, type]),
)

module.exports.LIST_PUBLIC = listPublic
module.exports.PUBLIC_WIRE_SEGMENTS = publicWireSegments
module.exports.BUFFER_DECLARATIONS = bufferDeclarations
