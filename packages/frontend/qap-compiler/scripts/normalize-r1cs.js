const fs = require('node:fs')

function readU32(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error('Unexpected end of R1CS data.')
  return buffer.readUInt32LE(offset)
}

function readU64(buffer, offset) {
  if (offset + 8 > buffer.length) throw new Error('Unexpected end of R1CS data.')
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('R1CS section is too large.')
  return Number(value)
}

function writeU32(value) {
  const out = Buffer.allocUnsafe(4)
  out.writeUInt32LE(value)
  return out
}

function writeU64(value) {
  const out = Buffer.allocUnsafe(8)
  out.writeBigUInt64LE(BigInt(value))
  return out
}

function parseR1csSections(buffer) {
  if (buffer.subarray(0, 4).toString('ascii') !== 'r1cs') throw new Error('Invalid R1CS magic.')
  if (readU32(buffer, 4) !== 1) throw new Error('Unsupported R1CS version.')
  const sectionCount = readU32(buffer, 8)
  const sections = new Map()
  let offset = 12
  for (let i = 0; i < sectionCount; i++) {
    const kind = readU32(buffer, offset)
    const size = readU64(buffer, offset + 4)
    const start = offset + 12
    const end = start + size
    if (end > buffer.length || sections.has(kind)) throw new Error('Invalid R1CS section table.')
    sections.set(kind, buffer.subarray(start, end))
    offset = end
  }
  if (offset !== buffer.length || !sections.has(1) || !sections.has(2)) {
    throw new Error('R1CS must contain readable header and constraint sections.')
  }
  for (const kind of sections.keys()) {
    if (kind !== 1 && kind !== 2 && kind !== 3) {
      throw new Error(`Unsupported R1CS section ${kind}; refusing to discard it.`)
    }
  }
  return sections
}

function wireRemap(compiledWire, wiringCount, m_b, realWireCount, m) {
  if (!Number.isSafeInteger(compiledWire) || compiledWire < 0 || compiledWire >= realWireCount) {
    throw new Error(`R1CS wire ${compiledWire} is outside the compiled wire range.`)
  }
  const normalizedWire = compiledWire < wiringCount
    ? compiledWire
    : m_b + compiledWire - wiringCount
  if (normalizedWire >= m) throw new Error('Normalized R1CS wire exceeds m.')
  return normalizedWire
}

function normalizeHeader(header, { m, realWireCount }) {
  const out = Buffer.from(header)
  const fieldSize = readU32(out, 0)
  const wireCountOffset = 4 + fieldSize
  const labelCountOffset = wireCountOffset + 16
  const constraintCountOffset = labelCountOffset + 8
  if (constraintCountOffset + 4 > out.length) throw new Error('Invalid R1CS header.')
  if (readU32(out, wireCountOffset) !== realWireCount) {
    throw new Error('R1CS wire count does not match producer metadata.')
  }
  out.writeUInt32LE(m, wireCountOffset)
  out.writeBigUInt64LE(BigInt(m), labelCountOffset)
  return { fieldSize, header: out, nConstraints: readU32(out, constraintCountOffset) }
}

function normalizeConstraints(constraints, nConstraints, fieldSize, layout) {
  const chunks = []
  let offset = 0
  for (let row = 0; row < nConstraints; row++) {
    for (let matrix = 0; matrix < 3; matrix++) {
      const entryCount = readU32(constraints, offset)
      chunks.push(constraints.subarray(offset, offset + 4))
      offset += 4
      for (let entry = 0; entry < entryCount; entry++) {
        const wire = readU32(constraints, offset)
        chunks.push(writeU32(wireRemap(
          wire,
          layout.wiringCount,
          layout.m_b,
          layout.realWireCount,
          layout.m,
        )))
        offset += 4
        const coefficientEnd = offset + fieldSize
        if (coefficientEnd > constraints.length) throw new Error('Unexpected end of R1CS coefficient.')
        chunks.push(constraints.subarray(offset, coefficientEnd))
        offset = coefficientEnd
      }
    }
  }
  if (offset !== constraints.length) throw new Error('R1CS constraint section has trailing bytes.')
  return Buffer.concat(chunks)
}

function encodeR1cs(header, constraints) {
  return Buffer.concat([
    Buffer.from('r1cs'),
    writeU32(1),
    writeU32(2),
    writeU32(1),
    writeU64(header.length),
    header,
    writeU32(2),
    writeU64(constraints.length),
    constraints,
  ])
}

function normalizeR1csBuffer(buffer, layout) {
  const sections = parseR1csSections(buffer)
  const { fieldSize, header, nConstraints } = normalizeHeader(sections.get(1), layout)
  const constraints = normalizeConstraints(sections.get(2), nConstraints, fieldSize, layout)
  return encodeR1cs(header, constraints)
}

function normalizeR1csFile(filePath, layout) {
  fs.writeFileSync(filePath, normalizeR1csBuffer(fs.readFileSync(filePath), layout))
}

function normalizeConstraintJsonFile(filePath, layout) {
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!Array.isArray(document.constraints)) throw new Error(`${filePath}: Missing constraints array.`)
  for (const constraint of document.constraints) {
    if (!Array.isArray(constraint) || constraint.length !== 3) {
      throw new Error(`${filePath}: Invalid JSON R1CS constraint.`)
    }
    for (let matrix = 0; matrix < 3; matrix++) {
      const normalized = {}
      for (const [wireText, coefficient] of Object.entries(constraint[matrix])) {
        const normalizedWire = wireRemap(
          Number(wireText),
          layout.wiringCount,
          layout.m_b,
          layout.realWireCount,
          layout.m,
        )
        normalized[normalizedWire] = coefficient
      }
      constraint[matrix] = normalized
    }
  }
  const source = `{
"constraints": [
${document.constraints.map((constraint) => JSON.stringify(constraint)).join(',\n')}
]
}`
  fs.writeFileSync(filePath, source, 'utf8')
}

module.exports = {
  normalizeConstraintJsonFile,
  normalizeR1csBuffer,
  normalizeR1csFile,
  wireRemap,
}
