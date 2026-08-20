const { S_MAX, LIBRARY_LAYOUT } = require('./configure.js')

const fs = require('fs')
const path = require('path')
const {
  loadLogicalInterfaces,
  parseCircomConstants,
  validateBufferCapacities,
} = require('./parse-interfaces.js')
const { collectInterfaceSignals, parseSymbolTable } = require('./parse-symbols.js')

const outputDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../subcircuits/library')
const compilerOutputPath = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname, 'temp.txt')
const interfaceDir = path.resolve(__dirname, '../subcircuits/interface')
const constantsPath = path.resolve(__dirname, '../subcircuits/circom/constants.circom')
const ansiEscapePattern = /\u001b\[[0-9;]*m/g

function _buildWireFlattenMap(globalWireList, subcircuitInfos, globalWireIndex, subcircuitId, subcircuitWireId) {
  if (subcircuitId >= 0 ){
    if ( globalWireList[globalWireIndex] !== undefined ) {
      throw new Error(`parseWireList: The same mapping occurs twice.`)
    }
    if ( subcircuitInfos[subcircuitId].flattenMap !== undefined ) {
      if ( subcircuitInfos[subcircuitId].flattenMap[subcircuitWireId] !== undefined ){
        throw new Error(`parseWireList: The same mapping occurs twice.`)
      }
    }

    if ( subcircuitInfos[subcircuitId].flattenMap === undefined ){
      const newSubcircuitInfo = {...subcircuitInfos[subcircuitId], flattenMap: []}
      newSubcircuitInfo.flattenMap[subcircuitWireId] = globalWireIndex
      subcircuitInfos[subcircuitId] = newSubcircuitInfo
    } else {
      subcircuitInfos[subcircuitId].flattenMap[subcircuitWireId] = globalWireIndex
    }
  }

  globalWireList[globalWireIndex] = [
    subcircuitId,
    subcircuitWireId,
  ]
}

function _getPortRange(targetSubcircuit, direction) {
  if (direction === 'in') {
    return [targetSubcircuit.inWireIndex, targetSubcircuit.NInWires]
  }
  if (direction === 'out') {
    return [targetSubcircuit.outWireIndex, targetSubcircuit.NOutWires]
  }
  throw new Error(`parseWireList: Unsupported port direction '${direction}'.`)
}

function _getOppositePortDirection(direction) {
  if (direction === 'in') return 'out'
  if (direction === 'out') return 'in'
  throw new Error(`parseWireList: Unsupported port direction '${direction}'.`)
}

function _appendPublicWireSegment(globalWireList, subcircuitInfos, globalWireIndex, targetSubcircuit, direction) {
  const [localWireIndex, numWires] = _getPortRange(targetSubcircuit, direction)
  let ind = globalWireIndex
  for (let i = 0; i < numWires; i++) {
    _buildWireFlattenMap(
      globalWireList,
      subcircuitInfos,
      ind++,
      targetSubcircuit.id,
      localWireIndex + i,
    )
  }
  return ind
}

function _recordPublicWireBoundary(boundaries, boundary, globalWireIndex) {
  if (boundaries[boundary] !== undefined) {
    throw new Error(`parseWireList: Duplicate public wire boundary '${boundary}'.`)
  }
  boundaries[boundary] = globalWireIndex
}

function _assertCompiledPortRange(targetSubcircuit, name, direction) {
  const wireIndex = direction === 'in'
    ? targetSubcircuit.inWireIndex
    : targetSubcircuit.outWireIndex
  const wireCount = direction === 'in'
    ? targetSubcircuit.NInWires
    : targetSubcircuit.NOutWires

  if (!Number.isInteger(wireIndex) || !Number.isInteger(wireCount)
    || wireIndex < 1 || wireCount < 0
    || wireIndex + wireCount > targetSubcircuit.NWires + 1) {
    throw new Error(`parseWireList: Buffer '${name}' has an invalid compiled ${direction} port range.`)
  }
}

function _validateBufferDeclarations(subcircuitInfos, subcircuitInfoByName, libraryLayout) {
  const {
    bufferDeclarations,
    publicWirePhases,
    publicWireSegments,
  } = libraryLayout
  const directionByName = new Map()
  const publicSegmentByName = new Map(publicWireSegments.map((segment) => [segment.name, segment]))
  const phaseByName = new Map()
  let hasFixedPhase = false

  for (const phase of publicWirePhases) {
    const {
      name,
      region,
      genericBoundary,
      terminalBoundary,
      includeGenericBoundaryInSetup,
    } = phase
    if (typeof name !== 'string' || name.length === 0 || phaseByName.has(name)) {
      throw new Error('parseWireList: Public wire phase names must be unique non-empty strings.')
    }
    if (region !== 'free' && region !== 'fixed') {
      throw new Error(`parseWireList: Public wire phase '${name}' has an invalid region.`)
    }
    if (hasFixedPhase && region === 'free') {
      throw new Error(`parseWireList: Public wire phase '${name}' cannot follow a fixed phase.`)
    }
    hasFixedPhase ||= region === 'fixed'
    if (typeof genericBoundary !== 'string' || genericBoundary.length === 0
      || typeof terminalBoundary !== 'string' || terminalBoundary.length === 0
      || typeof includeGenericBoundaryInSetup !== 'boolean') {
      throw new Error(`parseWireList: Public wire phase '${name}' has incomplete boundary metadata.`)
    }
    phaseByName.set(name, phase)
  }

  for (const segment of publicWireSegments) {
    const { name, direction, phase, boundary } = segment
    if (typeof name !== 'string' || name.length === 0
      || (direction !== 'in' && direction !== 'out')
      || typeof boundary !== 'string' || boundary.length === 0
      || !phaseByName.has(phase)) {
      throw new Error('parseWireList: Public wire segment has incomplete layout metadata.')
    }
  }

  for (const declaration of bufferDeclarations) {
    const { name, direction } = declaration
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('parseWireList: Buffer declaration has an invalid name.')
    }
    if (direction !== 'in' && direction !== 'out') {
      throw new Error(`parseWireList: Buffer '${name}' has an invalid direction.`)
    }
    if (directionByName.has(name)) {
      throw new Error(`parseWireList: Duplicate buffer declaration '${name}'.`)
    }

    const targetSubcircuit = subcircuitInfoByName.get(name)
    if (targetSubcircuit === undefined) {
      throw new Error(`parseWireList: Missing declared buffer '${name}'.`)
    }
    if (targetSubcircuit.logicalInterface !== undefined) {
      throw new Error(`parseWireList: Buffer declaration '${name}' refers to a non-buffer subcircuit.`)
    }
    _assertCompiledPortRange(targetSubcircuit, name, 'in')
    _assertCompiledPortRange(targetSubcircuit, name, 'out')

    const publicSegment = publicSegmentByName.get(name)
    if (publicSegment === undefined) {
      if (direction !== 'in') {
        throw new Error(`parseWireList: Private-only buffer '${name}' must have input direction.`)
      }
    } else {
      const [actualWireIndex, actualWireCount] = _getPortRange(
        targetSubcircuit,
        publicSegment.direction,
      )
      const [expectedWireIndex, expectedWireCount] = direction === 'in'
        ? [targetSubcircuit.inWireIndex, targetSubcircuit.NInWires]
        : [targetSubcircuit.outWireIndex, targetSubcircuit.NOutWires]
      if (publicSegment.direction !== direction) {
        throw new Error(`parseWireList: Buffer '${name}' direction does not match its public segment.`)
      }
      if (actualWireIndex !== expectedWireIndex || actualWireCount !== expectedWireCount) {
        throw new Error(`parseWireList: Buffer '${name}' public wire range does not match its direction.`)
      }
    }

    directionByName.set(name, direction)
  }

  for (const subcircuit of subcircuitInfos) {
    if (subcircuit.logicalInterface !== undefined) continue
    const direction = directionByName.get(subcircuit.name)
    if (direction === undefined) {
      throw new Error(`parseWireList: Buffer '${subcircuit.name}' is missing direction metadata.`)
    }
    subcircuit.bufferDirection = direction
  }

  return {
    directionByName,
    publicSegmentByName,
  }
}

function _assertInternalInterfacePortPrefixes(subcircuitInfos, l, l_D) {
  for (const subcircuit of subcircuitInfos) {
    const ports = [
      ['output', subcircuit.Out_idx[0], subcircuit.Out_idx[1]],
      ['input', subcircuit.In_idx[0], subcircuit.In_idx[1]],
    ]

    for (const [portName, start, count] of ports) {
      let reachedNonInterfaceWire = false
      for (let offset = 0; offset < count; offset++) {
        const localWireIndex = start + offset
        const globalWireIndex = subcircuit.flattenMap?.[localWireIndex]
        if (globalWireIndex === undefined) {
          throw new Error(
            `parseWireList: Missing flattened ${portName} port wire ${localWireIndex} for '${subcircuit.name}'.`,
          )
        }

        const isInternalInterfaceWire = globalWireIndex >= l && globalWireIndex < l_D
        if (isInternalInterfaceWire) {
          if (reachedNonInterfaceWire) {
            throw new Error(
              `parseWireList: '${subcircuit.name}' ${portName} port has an internal-interface wire after a non-interface wire.`,
            )
          }
        } else {
          reachedNonInterfaceWire = true
        }
      }
    }
  }
}

function parseWireList(subcircuitInfos, libraryLayout) {
  const {
    publicWirePhases,
    publicWireSegments,
  } = libraryLayout
  let numTotalWires = 0
  let numInterfaceWires = 0
  const subcircuitInfoByName = new Map()
  for (const subcircuit of subcircuitInfos) {
    numTotalWires += subcircuit.Nwires

    if (subcircuitInfoByName.has(subcircuit.name)) {
      throw new Error(`parseWireList: Duplicate subcircuit name '${subcircuit.name}'.`)
    }

    const entryObject = {
      id: subcircuit.id,
      NWires: subcircuit.Nwires,
      NInWires: subcircuit.In_idx[1],
      NOutWires: subcircuit.Out_idx[1],
      inWireIndex: subcircuit.In_idx[0],
      outWireIndex: subcircuit.Out_idx[0],
      logicalInterface: subcircuit.logicalInterface,
    }
    subcircuitInfoByName.set(subcircuit.name, entryObject)
  }

  const { publicSegmentByName } = _validateBufferDeclarations(
    subcircuitInfos,
    subcircuitInfoByName,
    libraryLayout,
  )
  const publicWireCountByPhase = new Map(
    publicWirePhases.map(({ name }) => [name, 0]),
  )

  for (const [subcircuitName, targetSubcircuit] of subcircuitInfoByName) {
    const publicSegment = publicSegmentByName.get(subcircuitName)
    if (publicSegment === undefined) {
      numInterfaceWires += targetSubcircuit.NOutWires + targetSubcircuit.NInWires + 1
      continue
    }

    const [, publicWireCount] = _getPortRange(targetSubcircuit, publicSegment.direction)
    const [, internalWireCount] = _getPortRange(
      targetSubcircuit,
      _getOppositePortDirection(publicSegment.direction),
    )
    publicWireCountByPhase.set(
      publicSegment.phase,
      publicWireCountByPhase.get(publicSegment.phase) + publicWireCount,
    )
    numInterfaceWires += internalWireCount + 1
  }

  const configuredPublicNames = new Set()
  for (const { name } of publicWireSegments) {
    if (configuredPublicNames.has(name)) {
      throw new Error(`parseWireList: Duplicate configured public subcircuit '${name}'.`)
    }
    configuredPublicNames.add(name)
    if (!subcircuitInfoByName.has(name)) {
      throw new Error(`parseWireList: Missing configured public subcircuit '${name}'.`)
    }
  }

  let freePublicWireCount = 0
  let fixedPublicWireCount = 0
  for (const phase of publicWirePhases) {
    const wireCount = publicWireCountByPhase.get(phase.name)
    if (phase.region === 'free') {
      freePublicWireCount += wireCount
    } else {
      fixedPublicWireCount += wireCount
    }
  }

  const l_free_actual = freePublicWireCount
  let twosPower = 1
  while (twosPower < l_free_actual) {
    twosPower <<= 1
  }
  const numDiff_l_free = twosPower - l_free_actual
  const l_free = l_free_actual + numDiff_l_free
  const l = l_free + fixedPublicWireCount

  twosPower = 1
  while (twosPower < numInterfaceWires) {
    twosPower <<= 1
  }

  // twosPower >= numInterfaceWires
  const numDiff_m_I = twosPower - numInterfaceWires
  const l_D = l + numInterfaceWires + numDiff_m_I
  const m_D = numTotalWires + numDiff_l_free + numDiff_m_I
  // numDiff_m_I makes the parameter m_I = l_D - l_free to be power of two.

  const globalWireList = []
  const publicWireBoundaries = {}
  const genericBoundaries = {}
  const segmentsByPhase = new Map(
    publicWirePhases.map(({ name }) => [name, []]),
  )
  for (const segment of publicWireSegments) {
    segmentsByPhase.get(segment.phase).push(segment)
  }

  const appendPhase = (phase, globalWireIndex) => {
    let ind = globalWireIndex
    for (const { name, direction, boundary } of segmentsByPhase.get(phase.name)) {
      ind = _appendPublicWireSegment(
        globalWireList,
        subcircuitInfos,
        ind,
        subcircuitInfoByName.get(name),
        direction,
      )
      _recordPublicWireBoundary(publicWireBoundaries, boundary, ind)
    }
    genericBoundaries[phase.genericBoundary] = ind
    if (publicWireBoundaries[phase.terminalBoundary] !== ind) {
      throw new Error(
        `parseWireList: Phase '${phase.name}' does not end at its configured terminal boundary.`,
      )
    }
    return ind
  }

  let ind = 0
  for (const phase of publicWirePhases) {
    if (phase.region === 'free') {
      ind = appendPhase(phase, ind)
    }
  }

  if (ind !== l_free_actual) {
    throw new Error(`parseWireList: Free public wire count does not match flattened wire count.`)
  }

  for (let i = 0; i < numDiff_l_free; i++) {
    _buildWireFlattenMap(
      globalWireList,
      subcircuitInfos,
      ind++,
      -1,
      -1,
    )
  }

  if (ind !== l_free) {
    throw new Error(`parseWireList: Public-wire padding does not reach the configured free boundary.`)
  }

  for (const phase of publicWirePhases) {
    if (phase.region === 'fixed') {
      ind = appendPhase(phase, ind)
    }
  }

  if (ind !== l) {
    throw new Error(`parseWireList: Fixed public wire count does not match flattened wire count.`)
  }

  // Processing internal interface wires
  for (const [subcircuitName, targetSubcircuit] of subcircuitInfoByName) {
    // Include the Circom constant wire in the interface wire list.
    _buildWireFlattenMap(
      globalWireList,
      subcircuitInfos,
      ind++,
      targetSubcircuit.id,
      0,
    )
    const publicSegment = publicSegmentByName.get(subcircuitName)
    if (publicSegment !== undefined) {
      const [internalWireIndex, internalWireCount] = _getPortRange(
        targetSubcircuit,
        _getOppositePortDirection(publicSegment.direction),
      )
      for (let i = 0; i < internalWireCount; i++) {
        _buildWireFlattenMap(
          globalWireList,
          subcircuitInfos,
          ind++,
          targetSubcircuit.id,
          internalWireIndex + i,
        )
      }
    } else {
      for (let i = 0; i < targetSubcircuit.NOutWires; i++) {
        _buildWireFlattenMap(
          globalWireList,
          subcircuitInfos,
          ind++,
          targetSubcircuit.id,
          targetSubcircuit.outWireIndex + i,
        )
      }
      for (let i = 0; i < targetSubcircuit.NInWires; i++) {
        _buildWireFlattenMap(
          globalWireList,
          subcircuitInfos,
          ind++,
          targetSubcircuit.id,
          targetSubcircuit.inWireIndex + i,
        )
      }
    }
  }

  for (let i = 0; i < numDiff_m_I; i++) {
    _buildWireFlattenMap(
      globalWireList,
      subcircuitInfos,
      ind++,
      -1,
      -1,
    )
  }

  if (ind !== l_D) {
    throw new Error(`parseWireList: Error during flattening interface wires`)
  }
  // Processing internal private wires
  for (const targetSubcircuit of subcircuitInfos) {
    // // The first wire is always for constant by Circom
    // _buildWireFlattenMap(
    //   globalWireList,
    //   subcircuitInfos,
    //   ind++,
    //   targetSubcircuit.id,
    //   0,
    // )
    const _numInterestWires = targetSubcircuit.Nwires - (targetSubcircuit.Out_idx[1] + targetSubcircuit.In_idx[1]) - 1
    for (let i = 0; i < _numInterestWires; i++) {
      _buildWireFlattenMap(
        globalWireList,
        subcircuitInfos,
        ind++,
        targetSubcircuit.id,
        targetSubcircuit.In_idx[0] + targetSubcircuit.In_idx[1] + i,
      )
    }
  }

  if (ind !== m_D) {
    throw new Error(`parseWireList: Error during flattening internal wires`)
  }

  _assertInternalInterfacePortPrefixes(subcircuitInfos, l, l_D)

  return {
    ...publicWireBoundaries,
    ...genericBoundaries,
    l_free,
    l,
    l_D,
    m_D,
    wireList: globalWireList,
  }
}

// Main script

const numConstsVec= [];

function getLineValue(lines, prefix) {
  const targetLine = lines.find((line) => line.startsWith(prefix))
  if (targetLine === undefined) {
    throw new Error(`parse.js: Missing '${prefix}' in compiler output.`)
  }

  const matches = targetLine.match(/\d+/g)
  if (matches === null || matches.length === 0) {
    throw new Error(`parse.js: Missing numeric value for '${prefix}'.`)
  }

  return Number(matches[matches.length - 1])
}

function parseSubcircuitBlock(lines) {
  const id = Number(lines[0].match(/\d+/)[0])

  let name
  const parts = lines[0].split(' = ')
  if (parts.length > 1) {
    const tempName = parts[1]
    if (tempName.includes('_')) {
      const index = tempName.indexOf('_')
      name = tempName.substring(0, index) + '-' + tempName.substring(index + 1)
    } else {
      name = tempName
    }
  } else {
    throw new Error(`parse.js: Failed to parse subcircuit name from '${lines[0]}'.`)
  }

  const numWires = getLineValue(lines, 'wires:')
  const numOutput = getLineValue(lines, 'public outputs:')
  const numInput = getLineValue(lines, 'public inputs:') + getLineValue(lines, 'private inputs:')
  const numConsts = getLineValue(lines, 'non-linear constraints:') + getLineValue(lines, 'linear constraints:')
  numConstsVec.push(numConsts)

  return {
    id,
    name,
    Nwires: numWires,
    Nconsts: numConsts,
    Out_idx: [1, numOutput],
    In_idx: [numOutput + 1, numInput],
  }
}

function main() {
  fs.readFile(compilerOutputPath, 'utf8', function(err, data) {
  if (err) throw err;
  
  const subcircuits = []

  const output = data
    .replace(ansiEscapePattern, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  let currentBlock = []
  for (const line of output) {
    if (line.startsWith('id[')) {
      if (currentBlock.length > 0) {
        subcircuits.push(parseSubcircuitBlock(currentBlock))
      }
      currentBlock = [line]
      continue
    }

    if (currentBlock.length > 0) {
      currentBlock.push(line)
    }
  }

  if (currentBlock.length > 0) {
    subcircuits.push(parseSubcircuitBlock(currentBlock))
  }

  for (const subcircuit of subcircuits) {
    const symbolPath = path.join(outputDir, `${subcircuit.name}_circuit.sym`)
    const symbolSource = fs.readFileSync(symbolPath, 'utf8')
    const symbolEntries = parseSymbolTable(symbolSource, symbolPath)
    collectInterfaceSignals(symbolEntries, subcircuit, symbolPath)
  }

  const circomConstants = parseCircomConstants(
    fs.readFileSync(constantsPath, 'utf8'),
    constantsPath,
  )
  validateBufferCapacities(subcircuits, circomConstants)

  const logicalInterfaces = loadLogicalInterfaces(
    subcircuits,
    interfaceDir,
    constantsPath,
  )
  for (const subcircuit of subcircuits) {
    const logicalInterface = logicalInterfaces.get(subcircuit.name)
    if (logicalInterface !== undefined) {
      subcircuit.logicalInterface = logicalInterface
    }
  }

  const globalWireInfo = parseWireList(subcircuits, LIBRARY_LAYOUT)
  const _n = Math.max(...numConstsVec)
  let n = 1;
  while (n < _n) {
      n <<= 1
  }

  const setupParams = Object.fromEntries(
    LIBRARY_LAYOUT.setupWireParameterKeys.map((key) => {
      const value = globalWireInfo[key]
      if (!Number.isFinite(value)) {
        throw new Error(`parse.js: Missing configured setup parameter '${key}'.`)
      }
      return [key, value]
    }),
  )
  setupParams.n = n
  setupParams.s_D = subcircuits.length
  setupParams.s_max = S_MAX
  const globalWireList = globalWireInfo.wireList

  // const tsSubcircuitInfo = `// Out_idx[0] denotes the index of the first output wire.
  // // Out_idx[1] denotes the number of output wires.
  // // In_idx[0] denotes the index of the first input wire.
  // // In_idx[1] denotes the number of input wires.
  // // flattenMap[localWireIndex] is a map that describes how each subcitcuit wire (local wire) is related to the library wires (global wires), i.e., 'flattenMap' is the inverse of 'globalWireList'.
  // export const subcircuits =\n ${JSON.stringify(subcircuits, null)}`
  // fs.writeFile('../subcircuits/library/subcircuitInfo.ts', tsSubcircuitInfo, (err) => {
  //   if (err) {
  //     console.log('Error writing the TypeScript file', err);
  //   } else {
  //     console.log('Successfully wrote the TypeScript file');
  //   }
  // })
  fs.writeFile(path.join(outputDir, 'subcircuitInfo.json'), JSON.stringify(subcircuits, null), (err) => {
    if (err) {
      console.log('Error writing the JSON file', err);
    } else {
      console.log('Successfully wrote the JSON file');
    }
  })

  // const tsGlobalWireList = `// This is a map that describes how each library wire (global wire) is related to the subcircuit wires (local wires), i.e., 'globalWireList' is the inverse of 'flattenMap' in the subcircuitInfo file.
  // // globalWireList[index][0] indicates subcircuitId to which this wire belongs.
  // // globalWireList[index][1] indicates the corresponding localWireIndex in the subcircuitId.
  // export const globalWireList =\n ${JSON.stringify(globalWireList, null)}`
  // fs.writeFile('../subcircuits/library/globalWireList.ts', tsGlobalWireList, (err) => {
  //   if (err) {
  //     console.log('Error writing the TypeScript file', err);
  //   } else {
  //     console.log('Successfully wrote the TypeScript file');
  //   }
  // })
  fs.writeFile(path.join(outputDir, 'globalWireList.json'), JSON.stringify(globalWireList, null), (err) => {
    if (err) {
      console.log('Error writing the JSON file', err);
    } else {
      console.log('Successfully wrote the JSON file');
    }
  })

  // const tsSetupParams = `// Parameters for the subcircuit library
  // // l_free: The number of public wires
  // // l_D: The number of interface wires (private)
  // // m: The total number of wires
  // // n: The maximum number of constraints
  // // s_D: The number of subcircuits in the library
  // export const setupParams = \n ${JSON.stringify(setupParams, null, 2)}`
  // fs.writeFile('../subcircuits/library/setupParams.ts', tsSetupParams, (err) => {
  //   if (err) {
  //     console.log('Error writing the TypeScript file', err);
  //   } else {
  //     console.log('Successfully wrote the TypeScript file');
  //   }
  // })
  fs.writeFile(path.join(outputDir, 'setupParams.json'), JSON.stringify(setupParams, null, 2), (err) => {
    if (err) {
      console.log('Error writing the JSON file', err);
    } else {
      console.log('Successfully wrote the JSON file');
    }
  })
  })
}

if (require.main === module) {
  main()
}

module.exports = {
  _assertInternalInterfacePortPrefixes,
  _validateBufferDeclarations,
  parseWireList,
}
