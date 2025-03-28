import { bytesToHex } from "@synthesizer-libs/util"

import { EvmErrorResult, OOGResult } from '../evm.js'
import { ERROR, EvmError } from '../exceptions.js'

import { leading16ZeroBytesCheck } from './bls12_381/index.js'
import { equalityLengthCheck, gasLimitCheck } from './util.js'

import { getPrecompileName } from './index.js'

import type { EVMBLSInterface, ExecResult } from '../types.js'
import type { PrecompileInput } from './types.js'

export async function precompile0e(opts: PrecompileInput): Promise<ExecResult> {
  const pName = getPrecompileName('0e')
  const bls = (<any>opts._EVM)._bls! as EVMBLSInterface

  // note: the gas used is constant; even if the input is incorrect.
  const gasUsed = opts.common.paramByEIP('bls12381G2AddGas', 2537) ?? BigInt(0)
  if (!gasLimitCheck(opts, gasUsed, pName)) {
    return OOGResult(opts.gasLimit)
  }

  if (!equalityLengthCheck(opts, 512, pName)) {
    return EvmErrorResult(new EvmError(ERROR.BLS_12_381_INVALID_INPUT_LENGTH), opts.gasLimit)
  }

  // check if some parts of input are zero bytes.
  const zeroByteRanges = [
    [0, 16],
    [64, 80],
    [128, 144],
    [192, 208],
    [256, 272],
    [320, 336],
    [384, 400],
    [448, 464],
  ]
  if (!leading16ZeroBytesCheck(opts, zeroByteRanges, pName)) {
    return EvmErrorResult(new EvmError(ERROR.BLS_12_381_POINT_NOT_ON_CURVE), opts.gasLimit)
  }

  // TODO: verify that point is on G2

  let returnValue
  try {
    returnValue = bls.addG2(opts.data)
  } catch (e: any) {
    return EvmErrorResult(e, opts.gasLimit)
  }

  if (opts._debug !== undefined) {
    opts._debug(`${pName} return value=${bytesToHex(returnValue)}`)
  }

  return {
    executionGasUsed: gasUsed,
    returnValue,
  }
}
