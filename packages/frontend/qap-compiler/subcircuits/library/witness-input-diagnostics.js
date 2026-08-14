'use strict'

const BLS12_381_FR_MODULUS = 52435875175126190479447740508185965837690552500527637822603658699938581184513n
const JUBJUB_SCALAR_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n
const WARNING_CODE = 'QAP_INPUT_OUT_OF_SPEC'

function parseOriginalScalar(value, description) {
  if (typeof value === 'bigint') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${description} must be a safe integer, bigint, or lossless integer string.`)
    }
    return BigInt(value)
  }
  if (typeof value === 'string' && value.length > 0 && value.trim() === value) {
    try {
      return BigInt(value)
    } catch {
      // Fall through to the stable input error below.
    }
  }
  throw new TypeError(`${description} must be a safe integer, bigint, or lossless integer string.`)
}

function splitPortName(name) {
  const match = /^(.*)\[(\d+)]$/.exec(name)
  return match === null
    ? { portName: name }
    : { portName: match[1], repetitionIndex: Number(match[2]) }
}

function buildPhysicalInputDescriptors(target) {
  const physicalInputCount = target?.In_idx?.[1]
  if (!Number.isSafeInteger(physicalInputCount) || physicalInputCount < 0) {
    throw new TypeError(`Target '${target?.name ?? '<unknown>'}' has an invalid physical input count.`)
  }

  if (target.logicalInterface === undefined) {
    return Array.from({ length: physicalInputCount }, (_, physicalInputIndex) => ({
      expectedDomain: '0 <= x < BLS12-381 Fr',
      limit: BLS12_381_FR_MODULUS,
      physicalInputIndex,
    }))
  }
  if (!Array.isArray(target.logicalInterface.inputs)) {
    throw new TypeError(`Target '${target.name}' has an invalid logical input interface.`)
  }

  const descriptors = []
  for (const port of target.logicalInterface.inputs) {
    if (typeof port?.name !== 'string' || port.name.length === 0) {
      throw new TypeError(`Target '${target.name}' has a logical input without a valid name.`)
    }
    const logicalType = port.logicalType
    const portIdentity = splitPortName(port.name)

    if (logicalType?.kind === 'uint') {
      if (!Number.isInteger(logicalType.bits) || logicalType.bits < 1 || logicalType.bits > 256) {
        throw new TypeError(`Target '${target.name}' input '${port.name}' has an invalid uint width.`)
      }
      if (logicalType.bits <= 160) {
        descriptors.push({
          ...portIdentity,
          expectedDomain: `0 <= x < 2^${logicalType.bits}`,
          limit: 1n << BigInt(logicalType.bits),
          physicalInputIndex: descriptors.length,
        })
      } else {
        descriptors.push({
          ...portIdentity,
          limb: 'low',
          expectedDomain: '0 <= low limb < 2^128',
          limit: 1n << 128n,
          physicalInputIndex: descriptors.length,
        })
        descriptors.push({
          ...portIdentity,
          limb: 'high',
          expectedDomain: `0 <= high limb < 2^${logicalType.bits - 128}`,
          limit: 1n << BigInt(logicalType.bits - 128),
          physicalInputIndex: descriptors.length,
        })
      }
    } else if (logicalType?.kind === 'bls12-381-fr') {
      descriptors.push({
        ...portIdentity,
        expectedDomain: '0 <= x < BLS12-381 Fr',
        limit: BLS12_381_FR_MODULUS,
        physicalInputIndex: descriptors.length,
      })
    } else if (logicalType?.kind === 'jubjub-scalar') {
      descriptors.push({
        ...portIdentity,
        expectedDomain: '0 <= x < Jubjub scalar order',
        limit: JUBJUB_SCALAR_ORDER,
        physicalInputIndex: descriptors.length,
      })
    } else {
      throw new TypeError(
        `Target '${target.name}' input '${port.name}' has unsupported logical type '${logicalType?.kind}'.`,
      )
    }
  }

  if (descriptors.length !== physicalInputCount) {
    throw new Error(
      `Target '${target.name}' logical inputs expand to ${descriptors.length} wires, but its compiled interface has ${physicalInputCount}.`,
    )
  }
  return descriptors
}

function validateInputShape(target, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`Target '${target.name}' input must be an object with exactly one 'in' array.`)
  }
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'in' || !Array.isArray(input.in)) {
    throw new TypeError(`Target '${target.name}' input must be an object with exactly one 'in' array.`)
  }
  if (input.in.length !== target.In_idx[1]) {
    throw new RangeError(
      `Target '${target.name}' expects ${target.In_idx[1]} physical input values, but received ${input.in.length}.`,
    )
  }
}

function diagnoseWitnessInput(target, input, warningSink = defaultWarningSink) {
  validateInputShape(target, input)
  const descriptors = buildPhysicalInputDescriptors(target)

  for (const descriptor of descriptors) {
    const value = parseOriginalScalar(
      input.in[descriptor.physicalInputIndex],
      `Target '${target.name}' physical input ${descriptor.physicalInputIndex}`,
    )
    if (value < 0n || value >= descriptor.limit) {
      const { limit, ...publicDescriptor } = descriptor
      warningSink(Object.freeze({
        code: WARNING_CODE,
        target: target.name,
        ...publicDescriptor,
      }))
    }
  }
}

function defaultWarningSink(warning) {
  console.warn(`[${warning.code}] ${JSON.stringify(warning)}`)
}

function wrapWitnessCalculator(target, witnessCalculator, warningSink = defaultWarningSink) {
  const wrapped = Object.create(witnessCalculator)
  for (const methodName of ['calculateWitness', 'calculateBinWitness', 'calculateWTNSBin']) {
    if (typeof witnessCalculator[methodName] !== 'function') {
      continue
    }
    wrapped[methodName] = function diagnosticWitnessMethod(input, ...args) {
      diagnoseWitnessInput(target, input, warningSink)
      return witnessCalculator[methodName](input, ...args)
    }
  }
  return wrapped
}

module.exports = {
  BLS12_381_FR_MODULUS,
  JUBJUB_SCALAR_ORDER,
  WARNING_CODE,
  buildPhysicalInputDescriptors,
  diagnoseWitnessInput,
  wrapWitnessCalculator,
}
