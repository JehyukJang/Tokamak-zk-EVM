import { short } from "@synthesizer-libs/util"

import { OOGResult } from '../evm.js'

import { gasLimitCheck } from './util.js'

import { getPrecompileName } from './index.js'

import type { ExecResult } from '../types.js'
import type { PrecompileInput } from './types.js'

export function precompile04(opts: PrecompileInput): ExecResult {
  const pName = getPrecompileName('04')
  const data = opts.data

  let gasUsed = opts.common.param('identityGas')
  gasUsed += opts.common.param('identityWordGas') * BigInt(Math.ceil(data.length / 32))
  if (!gasLimitCheck(opts, gasUsed, pName)) {
    return OOGResult(opts.gasLimit)
  }

  if (opts._debug !== undefined) {
    opts._debug(`${pName} return data=${short(opts.data)}`)
  }

  return {
    executionGasUsed: gasUsed,
    returnValue: Uint8Array.from(data), // Copy the memory (`Uint8Array.from()`)
  }
}
