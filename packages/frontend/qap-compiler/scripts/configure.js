module.exports.S_MAX = 256

const listPublic = new Map()
listPublic.set('bufferLogOut', 'outUser')
listPublic.set('bufferStorageOut', 'outUser')
listPublic.set('bufferPubIn', 'inUser')
listPublic.set('bufferBlockIn', 'inBlock')
listPublic.set('bufferEVMIn', 'inFunction')

module.exports.LIST_PUBLIC = listPublic
