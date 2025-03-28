import { Common, Mainnet } from '@ethereumjs/common/dist/esm/index.js'
import { bytesToHex, hexToBytes } from "@synthesizer-libs/util"
import { assert, beforeAll, describe, it } from 'vitest'

import { createEVM, getActivePrecompiles } from '../../src/index.js'

import { testData } from './modexp-testdata.js'

import type { EVM } from '../../src/index.js'
import type { PrecompileFunc } from '../../src/precompiles/types.js'
import type { PrefixedHexString } from "@synthesizer-libs/util"

const fuzzerTests = testData.data as PrefixedHexString[][]
describe('Precompiles: MODEXP', () => {
  let common: Common
  let evm: EVM
  let addressStr: string
  let MODEXP: PrecompileFunc
  beforeAll(async () => {
    common = new Common({ chain: Mainnet })
    evm = await createEVM({
      common,
    })
    addressStr = '0000000000000000000000000000000000000005'
    MODEXP = getActivePrecompiles(common).get(addressStr)!
  })

  let n = 0
  for (const [input, expect] of fuzzerTests) {
    n++
    it(`MODEXP edge cases (issue 3168) - case ${n}`, async () => {
      const result = await MODEXP({
        data: hexToBytes(input),
        gasLimit: BigInt(0xffff),
        common,
        _EVM: evm,
      })
      const output = bytesToHex(result.returnValue)
      assert.equal(output, expect)
    })
  }

  it('should correctly right-pad data if input length is too short', async () => {
    const gas = BigInt(0xffff)
    const result = await MODEXP({
      data: hexToBytes('0x41'),
      gasLimit: gas,
      common,
      _EVM: evm,
    })
    assert.ok(result.executionGasUsed === gas)
  })
})
