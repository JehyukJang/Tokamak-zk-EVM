const assert = require('node:assert/strict')
const test = require('node:test')

const { normalizeR1csBuffer, wireRemap } = require('../normalize-r1cs.js')

function u32(value) {
  const out = Buffer.alloc(4)
  out.writeUInt32LE(value)
  return out
}

function u64(value) {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(BigInt(value))
  return out
}

function section(kind, data) {
  return Buffer.concat([u32(kind), u64(data.length), data])
}

function fixtureR1cs() {
  const fieldSize = 8
  const header = Buffer.concat([
    u32(fieldSize),
    Buffer.alloc(fieldSize),
    u32(6),
    u32(2),
    u32(1),
    u32(0),
    u64(6),
    u32(1),
  ])
  const coefficient = value => {
    const out = Buffer.alloc(fieldSize)
    out.writeBigUInt64LE(BigInt(value))
    return out
  }
  const linearCombination = entries => Buffer.concat([
    u32(entries.length),
    ...entries.flatMap(([wire, value]) => [u32(wire), coefficient(value)]),
  ])
  const constraints = Buffer.concat([
    linearCombination([[0, 1], [4, 2]]),
    linearCombination([[3, 3]]),
    linearCombination([[5, 4]]),
  ])
  return Buffer.concat([
    Buffer.from('r1cs'), u32(1), u32(2), section(1, header), section(2, constraints),
  ])
}

function readConstraintWires(buffer) {
  let offset = 12
  const sections = new Map()
  for (let i = 0; i < buffer.readUInt32LE(8); i++) {
    const kind = buffer.readUInt32LE(offset)
    const size = Number(buffer.readBigUInt64LE(offset + 4))
    sections.set(kind, buffer.subarray(offset + 12, offset + 12 + size))
    offset += 12 + size
  }
  const header = sections.get(1)
  const fieldSize = header.readUInt32LE(0)
  const constraints = sections.get(2)
  offset = 0
  const wires = []
  for (let matrix = 0; matrix < 3; matrix++) {
    const count = constraints.readUInt32LE(offset)
    offset += 4
    const matrixWires = []
    for (let entry = 0; entry < count; entry++) {
      matrixWires.push(constraints.readUInt32LE(offset))
      offset += 4 + fieldSize
    }
    wires.push(matrixWires)
  }
  return { header, wires }
}

test('moves only internal R1CS columns behind m_b', () => {
  const normalized = normalizeR1csBuffer(fixtureR1cs(), {
    m: 16,
    m_b: 8,
    realWireCount: 6,
    wiringCount: 4,
  })
  const { header, wires } = readConstraintWires(normalized)

  assert.equal(header.readUInt32LE(12), 16)
  assert.deepEqual(wires, [[0, 8], [3], [9]])
  assert.equal(normalized.readUInt32LE(8), 2)
})

test('rejects wire coordinates outside the compiled and normalized ranges', () => {
  assert.equal(wireRemap(3, 4, 8, 6, 16), 3)
  assert.equal(wireRemap(4, 4, 8, 6, 16), 8)
  assert.throws(() => wireRemap(6, 4, 8, 6, 16), /outside the compiled wire range/)
  assert.throws(() => wireRemap(5, 4, 8, 6, 9), /exceeds m/)
})
