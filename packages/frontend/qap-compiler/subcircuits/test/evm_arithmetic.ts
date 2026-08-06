const WORD_BITS = 256
const MAX_UINT256 = (1n << 256n) - 1n

const requireInputs = (inputs: bigint[], count: number, operation: string): void => {
  if (inputs.length !== count) {
    throw new Error(`${operation} expected ${count} inputs`)
  }
}

const binary = (
  operation: string,
  calculate: (lhs: bigint, rhs: bigint) => bigint,
) => (inputs: bigint[]): bigint => {
  requireInputs(inputs, 2, operation)
  return calculate(inputs[0], inputs[1])
}

const ternary = (
  operation: string,
  calculate: (lhs: bigint, rhs: bigint, modulus: bigint) => bigint,
) => (inputs: bigint[]): bigint => {
  requireInputs(inputs, 3, operation)
  return calculate(inputs[0], inputs[1], inputs[2])
}

const asSigned = (value: bigint): bigint => BigInt.asIntN(WORD_BITS, value)
const asWord = (value: bigint): bigint => BigInt.asUintN(WORD_BITS, value)

export const EvmArithmetic = Object.freeze({
  add: binary('add', (lhs, rhs) => asWord(lhs + rhs)),
  mul: binary('mul', (lhs, rhs) => asWord(lhs * rhs)),
  sub: binary('sub', (lhs, rhs) => asWord(lhs - rhs)),
  div: binary('div', (lhs, rhs) => rhs === 0n ? 0n : lhs / rhs),
  sdiv: binary('sdiv', (lhs, rhs) =>
    rhs === 0n ? 0n : asWord(asSigned(lhs) / asSigned(rhs))),
  mod: binary('mod', (lhs, rhs) => rhs === 0n ? 0n : lhs % rhs),
  smod: binary('smod', (lhs, rhs) =>
    rhs === 0n ? 0n : asWord(asSigned(lhs) % asSigned(rhs))),
  addmod: ternary('addmod', (lhs, rhs, modulus) =>
    modulus === 0n ? 0n : (lhs + rhs) % modulus),
  mulmod: ternary('mulmod', (lhs, rhs, modulus) =>
    modulus === 0n ? 0n : (lhs * rhs) % modulus),
  lt: binary('lt', (lhs, rhs) => lhs < rhs ? 1n : 0n),
  gt: binary('gt', (lhs, rhs) => lhs > rhs ? 1n : 0n),
  slt: binary('slt', (lhs, rhs) => asSigned(lhs) < asSigned(rhs) ? 1n : 0n),
  sgt: binary('sgt', (lhs, rhs) => asSigned(lhs) > asSigned(rhs) ? 1n : 0n),
  eq: binary('eq', (lhs, rhs) => lhs === rhs ? 1n : 0n),
  iszero: (inputs: bigint[]): bigint => {
    requireInputs(inputs, 1, 'iszero')
    return inputs[0] === 0n ? 1n : 0n
  },
  and: binary('and', (lhs, rhs) => lhs & rhs),
  or: binary('or', (lhs, rhs) => lhs | rhs),
  xor: binary('xor', (lhs, rhs) => lhs ^ rhs),
  not: (inputs: bigint[]): bigint => {
    requireInputs(inputs, 1, 'not')
    return asWord(~inputs[0])
  },
  signextend: binary('signextend', (index, value) => {
    if (index >= 32n) {
      return value
    }
    const signBit = index * 8n + 7n
    const lowMask = (1n << (signBit + 1n)) - 1n
    return (value & (1n << signBit)) === 0n
      ? value & lowMask
      : value | (MAX_UINT256 ^ lowMask)
  }),
  byte: binary('byte', (index, value) =>
    index >= 32n ? 0n : (value >> ((31n - index) * 8n)) & 0xffn),
  shl: binary('shl', (shift, value) =>
    shift >= 256n ? 0n : asWord(value << shift)),
  shr: binary('shr', (shift, value) =>
    shift >= 256n ? 0n : value >> shift),
  sar: binary('sar', (shift, value) => {
    if (shift >= 256n) {
      return asSigned(value) < 0n ? MAX_UINT256 : 0n
    }
    return asWord(asSigned(value) >> shift)
  }),
})
