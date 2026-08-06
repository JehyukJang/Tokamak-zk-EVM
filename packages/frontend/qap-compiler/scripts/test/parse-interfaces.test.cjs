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
} = require('../parse-interfaces.js')

const UINT256 = {
  valueDomain: { kind: 'uint', bits: 256 },
  wireLayout: { kind: 'limbs-128', count: 2 },
}

const BIT = {
  valueDomain: { kind: 'uint', bits: 1 },
  wireLayout: { kind: 'limbs-128', count: 1 },
}

test('expands fixed and Circom-constant logical port lengths', () => {
  const constants = parseCircomConstants([
    'function nBatch() {return 2;}',
    'function ignored() {return 7;}',
  ].join('\n'))
  const logicalInterface = parseLogicalInterface(JSON.stringify({
    inputs: [
      { name: 'word', dataPtType: UINT256 },
      {
        name: 'bit',
        length: { constant: 'nBatch', offset: 1 },
        dataPtType: BIT,
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
        dataPtType: {
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
    inputs: [{ name: 'word', dataPtType: UINT256 }],
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
    inputs: [{ name: 'word', dataPtType: UINT256 }],
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
    inputs: [{ name: 'word', dataPtType: UINT256 }],
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
