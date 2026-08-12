import { jubjub } from '@noble/curves/misc.js'
import { poseidon_raw } from 'tokamak-l2js'

type Affine = readonly [bigint, bigint]
type Extended = readonly [bigint, bigint, bigint, bigint]

const Q = jubjub.Point.Fp.ORDER
const D = 19257038036680949359750312669786877991949435402254120286184196891950884077233n
const G8: Affine = [
  52363696936650001301287582521711853146588465673974699354184720335305084401224n,
  12024993157431732930272824407495979791132374572895036891122288541794509830761n,
]

const mod = (value: bigint): bigint => {
  const remainder = value % Q
  return remainder < 0n ? remainder + Q : remainder
}

const mul = (left: bigint, right: bigint): bigint => mod(left * right)

const inverse = (value: bigint, description: string): bigint => {
  let base = mod(value)
  if (base === 0n) throw new Error(`TransactionSignature: ${description} is zero`)
  let exponent = Q - 2n
  let result = 1n
  while (exponent > 0n) {
    if ((exponent & 1n) === 1n) result = mul(result, base)
    base = mul(base, base)
    exponent >>= 1n
  }
  return result
}

const expectLength = (values: readonly bigint[], expected: number, name: string): void => {
  if (values.length !== expected) {
    throw new Error(`TransactionSignature: ${name} expected ${expected} inputs, but got ${values.length}`)
  }
}

const expectBit = (value: bigint, description: string): void => {
  if (value !== 0n && value !== 1n) throw new Error(`TransactionSignature: ${description} is not a bit`)
}

const expectFr = (value: bigint, description: string): void => {
  if (value < 0n || value >= Q) {
    throw new Error(`TransactionSignature: ${description} is not a canonical BLS12-381 Fr value`)
  }
}

const toBits = (value: bigint, width: number, description: string): bigint[] => {
  if (value < 0n || value >= (1n << BigInt(width))) {
    throw new Error(`TransactionSignature: ${description} does not fit in ${width} bits`)
  }
  return Array.from({ length: width }, (_, index) => (value >> BigInt(index)) & 1n)
}

const expectPoint = (point: Affine, description: string): void => {
  expectFr(point[0], `${description}.x`)
  expectFr(point[1], `${description}.y`)
  const x2 = mul(point[0], point[0])
  const y2 = mul(point[1], point[1])
  if (mod(-x2 + y2) !== mod(1n + mul(D, mul(x2, y2)))) {
    throw new Error(`TransactionSignature: ${description} is not a Jubjub point`)
  }
}

const affineAdd = (left: Affine, right: Affine): Affine => {
  const xProduct = mul(left[0], right[0])
  const yProduct = mul(left[1], right[1])
  const denominatorTerm = mul(D, mul(xProduct, yProduct))
  const numeratorX = mod(mul(left[0] + left[1], right[0] + right[1]) - xProduct - yProduct)
  return [
    mul(numeratorX, inverse(1n + denominatorTerm, 'affine x denominator')),
    mul(yProduct + xProduct, inverse(1n - denominatorTerm, 'affine y denominator')),
  ]
}

const double = (
  point: readonly [bigint, bigint, bigint],
  includeT: boolean,
): readonly bigint[] => {
  const a = mul(point[0], point[0])
  const b = mul(point[1], point[1])
  const c = mul(2n, mul(point[2], point[2]))
  const e = mod(mul(point[0] + point[1], point[0] + point[1]) - a - b)
  const xFactor = mod(-a + b - c)
  const yFactor = mod(-a + b)
  const result = [mul(e, xFactor), mul(yFactor, -a - b), mul(xFactor, yFactor)]
  if (includeT) result.push(mul(e, -a - b))
  return result
}

const addAffineWithT = (
  point: Extended,
  affine: readonly [bigint, bigint, bigint],
  includeT: boolean,
): readonly bigint[] => {
  const a = mul(point[1] - point[0], affine[1] - affine[0])
  const b = mul(point[1] + point[0], affine[1] + affine[0])
  const c = mul(2n * D, mul(point[3], affine[2]))
  const xFactor = mod(2n * point[2] - c)
  const yFactor = mod(2n * point[2] + c)
  const result = [mul(b - a, xFactor), mul(yFactor, b + a), mul(xFactor, yFactor)]
  if (includeT) result.push(mul(b - a, b + a))
  return result
}

const addAffine = (point: Extended, affine: Affine): Extended => addAffineWithT(
  point,
  [affine[0], affine[1], mul(affine[0], affine[1])],
  true,
) as Extended

const addExtended = (
  left: Extended,
  right: Extended,
): readonly [bigint, bigint, bigint] => {
  const a = mul(left[1] - left[0], right[1] - right[0])
  const b = mul(left[1] + left[0], right[1] + right[0])
  const c = mul(2n * D, mul(left[3], right[3]))
  const d = mul(2n, mul(left[2], right[2]))
  return [mul(b - a, d - c), mul(d + c, b + a), mul(d - c, d + c)]
}

const toAffine = (point: readonly [bigint, bigint, bigint]): Affine => [
  mul(point[0], inverse(point[2], 'extended point z coordinate')),
  mul(point[1], inverse(point[2], 'extended point z coordinate')),
]

const cofactorEight = (point: Affine, includeT: boolean): readonly bigint[] => {
  const point2 = double([point[0], point[1], 1n], false) as readonly [bigint, bigint, bigint]
  const point4 = double(point2, false) as readonly [bigint, bigint, bigint]
  return double(point4, includeT)
}

const fixedBatch = (
  scalarBits: readonly bigint[],
  previous: Extended,
  startWindow: number,
  includeT: boolean,
): readonly bigint[] => {
  if (scalarBits.length % 3 !== 0) throw new Error('TransactionSignature: fixed-window bit count is invalid')
  scalarBits.forEach((bit, index) => expectBit(bit, `fixed-window bit ${index}`))
  let base = G8
  for (let bit = 0; bit < startWindow * 3; bit++) base = affineAdd(base, base)
  let accumulator = previous
  const numWindows = scalarBits.length / 3
  for (let window = 0; window < numWindows; window++) {
    const table: Affine[] = [[0n, 1n]]
    for (let digit = 1; digit < 8; digit++) table.push(affineAdd(table[digit - 1]!, base))
    const digit = Number(scalarBits[3 * window]! + 2n * scalarBits[3 * window + 1]! + 4n * scalarBits[3 * window + 2]!)
    accumulator = addAffineWithT(
      accumulator,
      [table[digit]![0], table[digit]![1], mul(table[digit]![0], table[digit]![1])],
      window + 1 === numWindows ? includeT : true,
    ) as Extended
    for (let bit = 0; bit < 3; bit++) base = affineAdd(base, base)
  }
  return accumulator
}

const variableBatch = (
  scalarBits: readonly bigint[],
  table: readonly Affine[],
  previous: Extended,
  topPadding: boolean,
  first: boolean,
): Extended => {
  if (table.length !== 4) throw new Error('TransactionSignature: variable-window table must contain four points')
  scalarBits.forEach((bit, index) => expectBit(bit, `variable-window bit ${index}`))
  const windows = topPadding ? (scalarBits.length + 1) / 2 : scalarBits.length / 2
  if (!Number.isInteger(windows) || windows <= 0) throw new Error('TransactionSignature: variable-window bit count is invalid')
  let accumulator = previous
  for (let step = 0; step < windows; step++) {
    const start = scalarBits.length - 2 * (step + 1) + (topPadding ? 1 : 0)
    const low = topPadding && step === 0 ? scalarBits[scalarBits.length - 1]! : scalarBits[start]!
    const high = topPadding && step === 0 ? 0n : scalarBits[start + 1]!
    if (!(first && step === 0)) {
      const firstDouble = double([accumulator[0], accumulator[1], accumulator[2]], false) as readonly [bigint, bigint, bigint]
      accumulator = double(firstDouble, true) as Extended
    }
    accumulator = addAffine(accumulator, table[Number(low + 2n * high)]!)
  }
  return accumulator
}

const expectExtendedEqual = (
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint],
): void => {
  const scale = mul(left[2], inverse(right[2], 'extended equality right z coordinate'))
  for (let coordinate = 0; coordinate < 3; coordinate++) {
    if (left[coordinate] !== mul(scale, right[coordinate])) {
      throw new Error('TransactionSignature: terminal extended points are not equal')
    }
  }
}

/** Host output calculations for the production transaction-signature subcircuits. */
export class TransactionSignatureOperations {
  static poseidonBatch4(values: readonly bigint[]): bigint[] {
    expectLength(values, 7, 'TransactionSignaturePoseidonBatch4')
    const [mode, firstLeft, firstRight, independentLeft, secondRight, thirdRight, fourthRight] = values
    expectBit(mode!, 'Poseidon batch mode')
    const firstHash = poseidon_raw([firstLeft!, firstRight!])
    const secondHash = poseidon_raw([mode === 1n ? firstHash : independentLeft!, secondRight!])
    const thirdHash = poseidon_raw([secondHash, thirdRight!])
    return [firstHash, poseidon_raw([thirdHash, fourthRight!])]
  }

  static pointPolicy(values: readonly bigint[]): bigint[] {
    expectLength(values, 8, 'TransactionSignaturePointPolicy')
    const randomizer: Affine = [values[0]!, values[1]!]
    const publicKey: Affine = [values[2]!, values[3]!]
    const identity: Affine = [values[6]!, values[7]!]
    if (values[4]! < 0n || values[4]! >= (1n << 160n)) throw new Error('TransactionSignature: contract address does not fit in 160 bits')
    if (values[5]! < 0n || values[5]! >= (1n << 32n)) throw new Error('TransactionSignature: function selector does not fit in 32 bits')
    expectPoint(randomizer, 'randomizer')
    expectPoint(publicKey, 'public key')
    const cofactoredPublicKey = cofactorEight(publicKey, false) as readonly [bigint, bigint, bigint]
    const publicKeyAffine = toAffine(cofactoredPublicKey)
    if (publicKeyAffine[1] === 1n) throw new Error('TransactionSignature: public key is the identity')
    if (randomizer[1] === 1n) throw new Error('TransactionSignature: randomizer is the identity')
    const table: Affine[] = [identity, publicKeyAffine]
    table.push(affineAdd(table[1]!, publicKeyAffine))
    table.push(affineAdd(table[2]!, publicKeyAffine))
    return [values[4]!, values[5]!, ...table.flat(), ...cofactorEight(randomizer, true)]
  }

  static fixedPrefix70(values: readonly bigint[]): bigint[] {
    expectLength(values, 1, 'TransactionSignatureFixedPrefix70')
    const signatureBits = toBits(values[0]!, 252, 'response scalar')
    return [...signatureBits.slice(210), ...fixedBatch(signatureBits.slice(0, 210), [0n, 1n, 1n, 0n], 0, true)]
  }

  static challengeVariablePrefix(values: readonly bigint[]): bigint[] {
    expectLength(values, 9, 'TransactionSignatureChallengeVariablePrefix')
    expectFr(values[0]!, 'challenge hash')
    const challengeBits = toBits(values[0]!, 255, 'challenge hash')
    const table = Array.from({ length: 4 }, (_, index): Affine => [values[1 + 2 * index]!, values[2 + 2 * index]!])
    return [...challengeBits.slice(0, 222), ...variableBatch(challengeBits.slice(222), table, [table[0]![0], table[0]![1], 1n, 0n], true, true)]
  }

  static variableBatch(values: readonly bigint[]): bigint[] {
    expectLength(values, 80, 'TransactionSignatureVariableBatch')
    const table = Array.from({ length: 4 }, (_, index): Affine => [values[68 + 2 * index]!, values[69 + 2 * index]!])
    return [...variableBatch(values.slice(0, 68), table, [values[76]!, values[77]!, values[78]!, values[79]!], false, false)]
  }

  static final(values: readonly bigint[]): bigint[] {
    expectLength(values, 81, 'TransactionSignatureFinal')
    const fixedTail = fixedBatch(values.slice(0, 42), [values[42]!, values[43]!, values[44]!, values[45]!], 70, false) as readonly [bigint, bigint, bigint]
    const table = Array.from({ length: 4 }, (_, index): Affine => [values[68 + 2 * index]!, values[69 + 2 * index]!])
    const variableTail = variableBatch(values.slice(46, 64), table, [values[64]!, values[65]!, values[66]!, values[67]!], false, false)
    expectExtendedEqual(fixedTail, addExtended(variableTail, [values[76]!, values[77]!, values[78]!, values[79]!]))
    expectFr(values[80]!, 'public key hash')
    return [values[80]! & ((1n << 160n) - 1n)]
  }
}
