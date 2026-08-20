const assert = require('node:assert/strict')
const test = require('node:test')

const {
  BUFFER_DECLARATIONS,
  LIBRARY_LAYOUT,
} = require('../configure.js')
const {
  _assertInternalInterfacePortPrefixes,
  _validateBufferDeclarations,
  buildGlobalWireLayout,
  buildSetupParams,
} = require('../build-wire-layout.js')

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

function createRawBufferCatalog(capacity = 2) {
  return BUFFER_DECLARATIONS.map((declaration, id) => ({
    id,
    name: declaration.name,
    Nwires: capacity * 2 + 1,
    Out_idx: [1, capacity],
    In_idx: [capacity + 1, capacity],
  }))
}

test('assigns declared directions to all generic buffer entries', () => {
  const catalog = createBufferCatalog()

  const { directionByName: directions } = _validateBufferDeclarations(
    catalog,
    createCatalogByName(catalog),
    LIBRARY_LAYOUT,
  )

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
  const bufferDeclarations = LIBRARY_LAYOUT.bufferDeclarations.map((declaration) =>
    declaration.name === 'bufferLogOut'
      ? { ...declaration, direction: 'in' }
      : declaration,
  )
  const invalidLayout = {
    ...LIBRARY_LAYOUT,
    bufferDeclarations,
  }

  assert.throws(
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog), invalidLayout),
    /direction does not match its public segment/,
  )
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
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog), LIBRARY_LAYOUT),
    /missing direction metadata/,
  )
})

test('rejects a declared buffer name that resolves to a logical interface', () => {
  const catalog = createBufferCatalog()
  catalog[0].logicalInterface = { inputs: [], outputs: [] }

  assert.throws(
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog), LIBRARY_LAYOUT),
    /refers to a non-buffer subcircuit/,
  )
})

test('rejects a declared buffer with an invalid compiled port range', () => {
  const catalog = createBufferCatalog()
  catalog[0].NInWires = catalog[0].NWires
  catalog[0].inWireIndex = 2

  assert.throws(
    () => _validateBufferDeclarations(catalog, createCatalogByName(catalog), LIBRARY_LAYOUT),
    /invalid compiled in port range/,
  )
})

test('derives public wire layout and boundary aliases from configuration', () => {
  const wireInfo = buildGlobalWireLayout(createRawBufferCatalog(), LIBRARY_LAYOUT)

  assert.deepEqual(
    {
      l_log_out: wireInfo.l_log_out,
      l_storage_store: wireInfo.l_storage_store,
      l_storage_load: wireInfo.l_storage_load,
      l_tx_in: wireInfo.l_tx_in,
      l_block_in: wireInfo.l_block_in,
      l_evm_in: wireInfo.l_evm_in,
      l_user_out: wireInfo.l_user_out,
      l_user: wireInfo.l_user,
      l_free: wireInfo.l_free,
      l: wireInfo.l,
      l_D: wireInfo.l_D,
      m_D: wireInfo.m_D,
    },
    {
      l_log_out: 2,
      l_storage_store: 4,
      l_storage_load: 6,
      l_tx_in: 8,
      l_block_in: 10,
      l_evm_in: 18,
      l_user_out: 6,
      l_user: 8,
      l_free: 16,
      l: 18,
      l_D: 50,
      m_D: 50,
    },
  )
})

test('builds setup parameters from the wire layout and compiled constraints', () => {
  const subcircuits = createRawBufferCatalog().map((subcircuit, index) => ({
    ...subcircuit,
    Nconsts: index === 0 ? 17 : 1,
  }))
  const setupParams = buildSetupParams(
    buildGlobalWireLayout(subcircuits, LIBRARY_LAYOUT),
    subcircuits,
    LIBRARY_LAYOUT,
    512,
  )

  assert.deepEqual(setupParams, {
    l_log_out: 2,
    l_storage_store: 4,
    l_storage_load: 6,
    l_tx_in: 8,
    l_block_in: 10,
    l_evm_in: 18,
    l_free: 16,
    l_user_out: 6,
    l_user: 8,
    l: 18,
    l_D: 50,
    m_D: 50,
    n: 32,
    s_D: 7,
    s_max: 512,
  })
})

test('rejects a public phase whose terminal boundary does not match its configured alias', () => {
  const publicWirePhases = LIBRARY_LAYOUT.publicWirePhases.map((phase) =>
    phase.name === 'user-output'
      ? { ...phase, terminalBoundary: 'l_log_out' }
      : phase,
  )
  const invalidLayout = {
    ...LIBRARY_LAYOUT,
    publicWirePhases,
  }

  assert.throws(
    () => buildGlobalWireLayout(createRawBufferCatalog(), invalidLayout),
    /does not end at its configured terminal boundary/,
  )
})

test('accepts a port whose internal-interface wires form a prefix', () => {
  const subcircuit = {
    name: 'testCircuit',
    Out_idx: [1, 2],
    In_idx: [3, 2],
    flattenMap: [0, 10, 11, 2, 3],
  }

  _assertInternalInterfacePortPrefixes([subcircuit], 10, 12)
})

test('rejects an internal-interface wire after a non-interface port wire', () => {
  const subcircuit = {
    name: 'testCircuit',
    Out_idx: [1, 2],
    In_idx: [3, 2],
    flattenMap: [0, 2, 10, 3, 4],
  }

  assert.throws(
    () => _assertInternalInterfacePortPrefixes([subcircuit], 10, 12),
    /internal-interface wire after a non-interface wire/,
  )
})
