import { createBlockchain } from '@ethereumjs/blockchain'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common/dist/esm/index.js'
import { createEVM } from '@ethereumjs/evm'
import { bytesToHex, hexToBytes } from "@ethereumjs/util/index.js"

import type { PrefixedHexString } from "@ethereumjs/util/index.js"

const main = async () => {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.London })
  const blockchain = await createBlockchain()

  const evm = await createEVM({
    common,
    blockchain,
  })

  const STOP = '00'
  const ADD = '01'
  const PUSH1 = '60'

  // Note that numbers added are hex values, so '20' would be '32' as decimal e.g.
  const code = [PUSH1, '03', PUSH1, '05', ADD, STOP]

  evm.events.on('step', function (data) {
    // Note that data.stack is not immutable, i.e. it is a reference to the vm's internal stack object
    console.log(`Opcode: ${data.opcode.name}\tStack: ${data.stack}`)
  })

  evm
    .runCode({
      code: hexToBytes(('0x' + code.join('')) as PrefixedHexString),
      gasLimit: BigInt(0xffff),
    })
    .then((results) => {
      console.log(`Returned: ${bytesToHex(results.returnValue)}`)
      console.log(`gasUsed: ${results.executionGasUsed.toString()}`)
    })
    .catch(console.error)
}

void main()
