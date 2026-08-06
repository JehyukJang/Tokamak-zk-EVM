const fs = require('node:fs')
const path = require('node:path')

const CIRCOM_CONSTANT_PATTERN = /function\s+([A-Za-z_]\w*)\s*\(\)\s*{\s*return\s+(\d+)\s*;\s*}/g
const PORT_KEYS = new Set(['name', 'logicalType', 'length'])

function assertObject(value, description) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`)
  }
}

function assertOnlyKeys(value, allowedKeys, description) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${description} has unsupported field '${key}'.`)
    }
  }
}

function parseCircomConstants(sourceText, source = 'constants.circom') {
  const constants = new Map()
  const text = sourceText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '')

  for (const match of text.matchAll(CIRCOM_CONSTANT_PATTERN)) {
    const [, name, valueText] = match
    if (constants.has(name)) {
      throw new Error(`${source}: Duplicate Circom constant '${name}'.`)
    }
    constants.set(name, Number(valueText))
  }

  return constants
}

function validateLogicalType(value, description) {
  assertObject(value, description)
  assertOnlyKeys(value, new Set(['valueDomain', 'wireLayout']), description)
  if (!Object.hasOwn(value, 'valueDomain') || !Object.hasOwn(value, 'wireLayout')) {
    throw new Error(`${description} must define valueDomain and wireLayout.`)
  }

  const { valueDomain, wireLayout } = value
  assertObject(valueDomain, `${description}.valueDomain`)
  assertObject(wireLayout, `${description}.wireLayout`)

  if (valueDomain.kind === 'uint') {
    assertOnlyKeys(valueDomain, new Set(['kind', 'bits']), `${description}.valueDomain`)
    if (!Number.isInteger(valueDomain.bits) || valueDomain.bits < 1 || valueDomain.bits > 256) {
      throw new Error(`${description}.valueDomain.bits must be an integer between 1 and 256.`)
    }
  } else if (valueDomain.kind === 'bls12-381-fr' || valueDomain.kind === 'jubjub-scalar') {
    assertOnlyKeys(valueDomain, new Set(['kind']), `${description}.valueDomain`)
  } else {
    throw new Error(`${description}.valueDomain.kind is unsupported.`)
  }

  if (wireLayout.kind === 'limbs-128') {
    assertOnlyKeys(wireLayout, new Set(['kind', 'count']), `${description}.wireLayout`)
    if (wireLayout.count !== 1 && wireLayout.count !== 2) {
      throw new Error(`${description}.wireLayout.count must be 1 or 2.`)
    }
    if (valueDomain.kind === 'uint') {
      if (wireLayout.count === 1 && valueDomain.bits > 128) {
        throw new Error(`${description} cannot encode uint(${valueDomain.bits}) in one 128-bit limb.`)
      }
    } else if (wireLayout.count !== 2) {
      throw new Error(`${description} must encode a split field or scalar in two 128-bit limbs.`)
    }
  } else if (wireLayout.kind === 'native-fr') {
    assertOnlyKeys(wireLayout, new Set(['kind']), `${description}.wireLayout`)
    if (valueDomain.kind === 'uint') {
      throw new Error(`${description} cannot encode an integer as native-fr.`)
    }
  } else {
    throw new Error(`${description}.wireLayout.kind is unsupported.`)
  }

  return {
    valueDomain: { ...valueDomain },
    wireLayout: { ...wireLayout },
  }
}

function resolveLength(value, constants, description) {
  if (value === undefined) {
    return 1
  }
  if (Number.isInteger(value)) {
    if (value < 1) {
      throw new Error(`${description} must be positive.`)
    }
    return value
  }

  assertObject(value, description)
  assertOnlyKeys(value, new Set(['constant', 'offset']), description)
  if (typeof value.constant !== 'string' || value.constant.length === 0) {
    throw new Error(`${description}.constant must be a non-empty string.`)
  }
  const constant = constants.get(value.constant)
  if (constant === undefined) {
    throw new Error(`${description} references unknown Circom constant '${value.constant}'.`)
  }
  const offset = value.offset ?? 0
  if (!Number.isInteger(offset)) {
    throw new Error(`${description}.offset must be an integer.`)
  }
  const length = constant + offset
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error(`${description} resolves to invalid length ${length}.`)
  }
  return length
}

function expandPorts(ports, constants, description) {
  if (!Array.isArray(ports)) {
    throw new Error(`${description} must be an array.`)
  }

  const expanded = []
  const names = new Set()
  for (const [index, port] of ports.entries()) {
    const portDescription = `${description}[${index}]`
    assertObject(port, portDescription)
    assertOnlyKeys(port, PORT_KEYS, portDescription)
    if (typeof port.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(port.name)) {
      throw new Error(`${portDescription}.name must be an alphanumeric identifier.`)
    }
    if (!Object.hasOwn(port, 'logicalType')) {
      throw new Error(`${portDescription} must define logicalType.`)
    }

    const logicalType = validateLogicalType(port.logicalType, `${portDescription}.logicalType`)
    const length = resolveLength(port.length, constants, `${portDescription}.length`)
    for (let repeatedIndex = 0; repeatedIndex < length; repeatedIndex++) {
      const name = length === 1 ? port.name : `${port.name}[${repeatedIndex}]`
      if (names.has(name)) {
        throw new Error(`${description} has duplicate expanded port name '${name}'.`)
      }
      names.add(name)
      expanded.push({ name, logicalType })
    }
  }
  return expanded
}

function countPhysicalWires(ports) {
  return ports.reduce((count, { logicalType: { wireLayout } }) =>
    count + (wireLayout.kind === 'native-fr' ? 1 : wireLayout.count), 0)
}

function parseLogicalInterface(sourceText, constants, source = 'logical interface') {
  let value
  try {
    value = JSON.parse(sourceText)
  } catch (error) {
    throw new Error(`${source}: Invalid JSON: ${error.message}`)
  }

  assertObject(value, source)
  assertOnlyKeys(value, new Set(['inputs', 'outputs']), source)
  if (!Object.hasOwn(value, 'inputs') || !Object.hasOwn(value, 'outputs')) {
    throw new Error(`${source} must define inputs and outputs.`)
  }

  return {
    inputs: expandPorts(value.inputs, constants, `${source}.inputs`),
    outputs: expandPorts(value.outputs, constants, `${source}.outputs`),
  }
}

function loadLogicalInterfaces(subcircuits, interfaceDir, constantsPath) {
  const constants = parseCircomConstants(
    fs.readFileSync(constantsPath, 'utf8'),
    constantsPath,
  )
  const expectedNames = new Set(
    subcircuits
      .map(({ name }) => name)
      .filter((name) => !name.startsWith('buffer')),
  )
  const entries = fs.readdirSync(interfaceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      throw new Error(`Logical interface directory has unsupported entry '${entry.name}'.`)
    }
  }
  const actualNames = new Set(
    entries.map((entry) => entry.name.slice(0, -'.json'.length)),
  )

  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      throw new Error(`Logical interface file is missing for subcircuit '${name}'.`)
    }
  }
  for (const name of actualNames) {
    if (!expectedNames.has(name)) {
      throw new Error(`Logical interface file '${name}.json' has no compiled non-buffer subcircuit.`)
    }
  }

  const interfaces = new Map()
  for (const subcircuit of subcircuits) {
    if (!expectedNames.has(subcircuit.name)) {
      continue
    }
    const source = path.join(interfaceDir, `${subcircuit.name}.json`)
    const logicalInterface = parseLogicalInterface(
      fs.readFileSync(source, 'utf8'),
      constants,
      source,
    )
    const inputWires = countPhysicalWires(logicalInterface.inputs)
    const outputWires = countPhysicalWires(logicalInterface.outputs)
    if (inputWires !== subcircuit.In_idx[1]) {
      throw new Error(
        `${source}: Logical inputs expand to ${inputWires} wires, but ${subcircuit.name} has ${subcircuit.In_idx[1]} compiled input wires.`,
      )
    }
    if (outputWires !== subcircuit.Out_idx[1]) {
      throw new Error(
        `${source}: Logical outputs expand to ${outputWires} wires, but ${subcircuit.name} has ${subcircuit.Out_idx[1]} compiled output wires.`,
      )
    }
    interfaces.set(subcircuit.name, logicalInterface)
  }

  return interfaces
}

module.exports = {
  countPhysicalWires,
  loadLogicalInterfaces,
  parseCircomConstants,
  parseLogicalInterface,
}
