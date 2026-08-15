const assert = require('node:assert/strict')
const test = require('node:test')

const { BUFFER_DECLARATIONS } = require('../configure.js')
const { _validateBufferDeclarations } = require('../parse.js')

function createBufferCatalog() {
  return BUFFER_DECLARATIONS.map((declaration, id) => ({
    id,
    name: declaration.name,
    NWires: 5,
    NInWires: 2,
    NOutWires: 2,
    inWireIndex: 1,
    outWireIndex: 3,
  }))
}

function createCatalogByName(catalog) {
  return new Map(catalog.map((subcircuit) => [subcircuit.name, subcircuit]))
}

test('assigns declared directions to all generic buffer entries', () => {
  const catalog = createBufferCatalog()

  const directions = _validateBufferDeclarations(catalog, createCatalogByName(catalog))

  for (const declaration of BUFFER_DECLARATIONS) {
    assert.equal(directions.get(declaration.name), declaration.direction)
    assert.equal(
      catalog.find(({ name }) => name === declaration.name).bufferDirection,
      declaration.direction,
    )
  }
})

test('rejects a direction that conflicts with its public segment', () => {
  const catalog = createBufferCatalog()
  const declaration = BUFFER_DECLARATIONS.find(({ name }) => name === 'bufferLogOut')
  const originalDirection = declaration.direction
  declaration.direction = 'in'

  try {
    assert.throws(
      () => _validateBufferDeclarations(catalog, createCatalogByName(catalog)),
      /direction does not match its public wire type/,
    )
  } finally {
    declaration.direction = originalDirection
  }
})

test('rejects a generic buffer without a declared direction', () => {
  const catalog = [
    ...createBufferCatalog(),
    {
      id: BUFFER_DECLARATIONS.length,
      name: 'bufferUndeclared',
      NWires: 5,
      NInWires: 2,
      NOutWires: 2,
      inWireIndex: 1,
      outWireIndex: 3,
    },
  ]

  assert.throws(
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog)),
    /missing direction metadata/,
  )
})

test('rejects a declared buffer name that resolves to a logical interface', () => {
  const catalog = createBufferCatalog()
  catalog[0].logicalInterface = { inputs: [], outputs: [] }

  assert.throws(
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog)),
    /refers to a non-buffer subcircuit/,
  )
})

test('rejects a declared buffer with an invalid compiled port range', () => {
  const catalog = createBufferCatalog()
  catalog[0].NInWires = catalog[0].NWires
  catalog[0].inWireIndex = 2

  assert.throws(
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog)),
    /invalid compiled in port range/,
  )
})
