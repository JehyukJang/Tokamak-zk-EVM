const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  countPhysicalWires,
  loadLogicalInterfaces,
  parseCircomConstants,
  parseLogicalInterface,
  validateBufferCapacities,
} = require('../parse-interfaces.js')

const UINT256 = {
  valueDomain: { kind: 'uint', bits: 256 },
  wireLayout: { kind: 'limbs-128', count: 2 },
}

const BIT = {
  valueDomain: { kind: 'uint', bits: 1 },
  wireLayout: { kind: 'limbs-128', count: 1 },
}

const BUFFER_CAPACITIES = new Map([
  ['nLogOut', 5],
  ['nStorageStore', 6],
  ['nStorageLoad', 7],
  ['nTxIn', 8],
  ['nBlockIn', 9],
  ['nEVMIn', 10],
  ['nPrvIn', 11],
])

const BUFFER_SUBCIRCUITS = [
  ['bufferLogOut', 5],
  ['bufferStorageStore', 6],
  ['bufferStorageLoad', 7],
  ['bufferTxIn', 8],
  ['bufferBlockIn', 9],
  ['bufferEVMIn', 10],
  ['bufferPrvIn', 11],
].map(([name, capacity]) => ({
  name,
  In_idx: [capacity + 1, capacity],
  Out_idx: [1, capacity],
}))

test('expands fixed and Circom-constant logical port lengths', () => {
  const constants = parseCircomConstants([
    'function nBatch() {return 2;}',
    'function ignored() {return 7;}',
  ].join('\n'))
  const logicalInterface = parseLogicalInterface(JSON.stringify({
    inputs: [
      { name: 'word', logicalType: UINT256 },
      {
        name: 'bit',
        length: { constant: 'nBatch', offset: 1 },
        logicalType: BIT,
      },
    ],
    outputs: [],
  }), constants)

  assert.deepEqual(logicalInterface.inputs.map(({ name }) => name), [
    'word',
    'bit[0]',
    'bit[1]',
    'bit[2]',
  ])
  assert.equal(countPhysicalWires(logicalInterface.inputs), 5)
})

test('rejects invalid domain and layout combinations', () => {
  assert.throws(
    () => parseLogicalInterface(JSON.stringify({
      inputs: [{
        name: 'word',
        logicalType: {
          valueDomain: { kind: 'uint', bits: 256 },
          wireLayout: { kind: 'limbs-128', count: 1 },
        },
      }],
      outputs: [],
    }), new Map()),
    /cannot encode uint\(256\) in one 128-bit limb/,
  )
})

test('requires exactly one JSON declaration for every non-buffer target', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qap-interface-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const interfaceDir = path.join(root, 'interface')
  fs.mkdirSync(interfaceDir)
  const constantsPath = path.join(root, 'constants.circom')
  fs.writeFileSync(constantsPath, '')
  fs.writeFileSync(path.join(interfaceDir, 'Example.json'), JSON.stringify({
    inputs: [{ name: 'word', logicalType: UINT256 }],
    outputs: [],
  }))

  const subcircuits = [
    { name: 'bufferTxIn', In_idx: [1, 6], Out_idx: [1, 0] },
    { name: 'Example', In_idx: [1, 2], Out_idx: [1, 0] },
  ]
  assert.equal(loadLogicalInterfaces(subcircuits, interfaceDir, constantsPath).size, 1)

  fs.rmSync(path.join(interfaceDir, 'Example.json'))
  assert.throws(
    () => loadLogicalInterfaces(subcircuits, interfaceDir, constantsPath),
    /interface file is missing for subcircuit 'Example'/,
  )

  fs.writeFileSync(path.join(interfaceDir, 'Example.json'), JSON.stringify({
    inputs: [{ name: 'word', logicalType: UINT256 }],
    outputs: [],
  }))
  fs.writeFileSync(path.join(interfaceDir, 'Extra.json'), JSON.stringify({ inputs: [], outputs: [] }))
  assert.throws(
    () => loadLogicalInterfaces(subcircuits, interfaceDir, constantsPath),
    /Extra\.json.*no compiled non-buffer subcircuit/,
  )
})

test('rejects logical wire counts that disagree with compiled interfaces', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qap-interface-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const interfaceDir = path.join(root, 'interface')
  fs.mkdirSync(interfaceDir)
  const constantsPath = path.join(root, 'constants.circom')
  fs.writeFileSync(constantsPath, '')
  fs.writeFileSync(path.join(interfaceDir, 'Example.json'), JSON.stringify({
    inputs: [{ name: 'word', logicalType: UINT256 }],
    outputs: [],
  }))

  assert.throws(
    () => loadLogicalInterfaces(
      [{ name: 'Example', In_idx: [1, 3], Out_idx: [1, 0] }],
      interfaceDir,
      constantsPath,
    ),
    /Logical inputs expand to 2 wires, but Example has 3 compiled input wires/,
  )
})

test('validates buffer input and output wire counts independently', () => {
  assert.doesNotThrow(() => validateBufferCapacities(BUFFER_SUBCIRCUITS, BUFFER_CAPACITIES))

  const wrongInput = BUFFER_SUBCIRCUITS.map((subcircuit) => ({
    ...subcircuit,
    In_idx: [...subcircuit.In_idx],
    Out_idx: [...subcircuit.Out_idx],
  }))
  wrongInput[3].In_idx[1] += 1
  assert.throws(
    () => validateBufferCapacities(wrongInput, BUFFER_CAPACITIES),
    /bufferTxIn has 9 compiled input wires, but nTxIn is 8/,
  )

  const wrongOutput = BUFFER_SUBCIRCUITS.map((subcircuit) => ({
    ...subcircuit,
    In_idx: [...subcircuit.In_idx],
    Out_idx: [...subcircuit.Out_idx],
  }))
  wrongOutput[3].Out_idx[1] += 1
  assert.throws(
    () => validateBufferCapacities(wrongOutput, BUFFER_CAPACITIES),
    /bufferTxIn has 9 compiled output wires, but nTxIn is 8/,
  )
})

test('requires every buffer capacity constant and compiled buffer', () => {
  const missingConstant = new Map(BUFFER_CAPACITIES)
  missingConstant.delete('nBlockIn')
  assert.throws(
    () => validateBufferCapacities(BUFFER_SUBCIRCUITS, missingConstant),
    /nBlockIn.*positive safe integer/,
  )

  assert.throws(
    () => validateBufferCapacities(
      BUFFER_SUBCIRCUITS.filter(({ name }) => name !== 'bufferBlockIn'),
      BUFFER_CAPACITIES,
    ),
    /missing compiled subcircuit 'bufferBlockIn'/,
  )
})
