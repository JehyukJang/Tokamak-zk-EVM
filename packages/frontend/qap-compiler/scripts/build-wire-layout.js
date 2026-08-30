function _assignFlattenedWire(globalWireList, subcircuitInfos, globalWireIndex, subcircuitId, subcircuitWireId) {
  if (subcircuitId >= 0 ){
    if ( globalWireList[globalWireIndex] !== undefined ) {
      throw new Error(`buildGlobalWireLayout: The same mapping occurs twice.`)
    }
    if ( subcircuitInfos[subcircuitId].flattenMap !== undefined ) {
      if ( subcircuitInfos[subcircuitId].flattenMap[subcircuitWireId] !== undefined ){
        throw new Error(`buildGlobalWireLayout: The same mapping occurs twice.`)
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
  throw new Error(`buildGlobalWireLayout: Unsupported port direction '${direction}'.`)
}

function _getOppositePortDirection(direction) {
  if (direction === 'in') return 'out'
  if (direction === 'out') return 'in'
  throw new Error(`buildGlobalWireLayout: Unsupported port direction '${direction}'.`)
}

function _appendPublicWireSegment(globalWireList, subcircuitInfos, globalWireIndex, targetSubcircuit, direction) {
  const [localWireIndex, numWires] = _getPortRange(targetSubcircuit, direction)
  let nextGlobalWireIndex = globalWireIndex
  for (let i = 0; i < numWires; i++) {
    _assignFlattenedWire(
      globalWireList,
      subcircuitInfos,
      nextGlobalWireIndex++,
      targetSubcircuit.id,
      localWireIndex + i,
    )
  }
  return nextGlobalWireIndex
}

function _recordPublicWireBoundary(boundaries, boundary, globalWireIndex) {
  if (boundaries[boundary] !== undefined) {
    throw new Error(`buildGlobalWireLayout: Duplicate public wire boundary '${boundary}'.`)
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
    throw new Error(`buildGlobalWireLayout: Buffer '${name}' has an invalid compiled ${direction} port range.`)
  }
}

function _validateBufferLayout(subcircuitInfoByName, libraryLayout) {
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
      throw new Error('buildGlobalWireLayout: Public wire phase names must be unique non-empty strings.')
    }
    if (region !== 'free' && region !== 'fixed') {
      throw new Error(`buildGlobalWireLayout: Public wire phase '${name}' has an invalid region.`)
    }
    if (hasFixedPhase && region === 'free') {
      throw new Error(`buildGlobalWireLayout: Public wire phase '${name}' cannot follow a fixed phase.`)
    }
    hasFixedPhase ||= region === 'fixed'
    if (typeof genericBoundary !== 'string' || genericBoundary.length === 0
      || typeof terminalBoundary !== 'string' || terminalBoundary.length === 0
      || typeof includeGenericBoundaryInSetup !== 'boolean') {
      throw new Error(`buildGlobalWireLayout: Public wire phase '${name}' has incomplete boundary metadata.`)
    }
    phaseByName.set(name, phase)
  }

  for (const segment of publicWireSegments) {
    const { name, direction, phase, boundary } = segment
    if (typeof name !== 'string' || name.length === 0
      || (direction !== 'in' && direction !== 'out')
      || typeof boundary !== 'string' || boundary.length === 0
      || !phaseByName.has(phase)) {
      throw new Error('buildGlobalWireLayout: Public wire segment has incomplete layout metadata.')
    }
  }

  for (const declaration of bufferDeclarations) {
    const { name, direction } = declaration
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('buildGlobalWireLayout: Buffer declaration has an invalid name.')
    }
    if (direction !== 'in' && direction !== 'out') {
      throw new Error(`buildGlobalWireLayout: Buffer '${name}' has an invalid direction.`)
    }
    if (directionByName.has(name)) {
      throw new Error(`buildGlobalWireLayout: Duplicate buffer declaration '${name}'.`)
    }

    const targetSubcircuit = subcircuitInfoByName.get(name)
    if (targetSubcircuit === undefined) {
      throw new Error(`buildGlobalWireLayout: Missing declared buffer '${name}'.`)
    }
    if (targetSubcircuit.logicalInterface !== undefined) {
      throw new Error(`buildGlobalWireLayout: Buffer declaration '${name}' refers to a non-buffer subcircuit.`)
    }
    _assertCompiledPortRange(targetSubcircuit, name, 'in')
    _assertCompiledPortRange(targetSubcircuit, name, 'out')

    const publicSegment = publicSegmentByName.get(name)
    if (publicSegment === undefined) {
      if (direction !== 'in') {
        throw new Error(`buildGlobalWireLayout: Private-only buffer '${name}' must have input direction.`)
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
        throw new Error(`buildGlobalWireLayout: Buffer '${name}' direction does not match its public segment.`)
      }
      if (actualWireIndex !== expectedWireIndex || actualWireCount !== expectedWireCount) {
        throw new Error(`buildGlobalWireLayout: Buffer '${name}' public wire range does not match its direction.`)
      }
    }

    directionByName.set(name, direction)
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
            `buildGlobalWireLayout: Missing flattened ${portName} port wire ${localWireIndex} for '${subcircuit.name}'.`,
          )
        }

        const isInternalInterfaceWire = globalWireIndex >= l && globalWireIndex < l_D
        if (isInternalInterfaceWire) {
          if (reachedNonInterfaceWire) {
            throw new Error(
              `buildGlobalWireLayout: '${subcircuit.name}' ${portName} port has an internal-interface wire after a non-interface wire.`,
            )
          }
        } else {
          reachedNonInterfaceWire = true
        }
      }
    }
  }
}

function buildGlobalWireLayout(subcircuitInfos, libraryLayout) {
  const layoutSubcircuits = subcircuitInfos.map((subcircuit) => ({ ...subcircuit }))
  const {
    publicWirePhases,
    publicWireSegments,
  } = libraryLayout
  let numTotalWires = 0
  let numInterfaceWires = 0
  const subcircuitInfoByName = new Map()
  for (const compiledSubcircuit of layoutSubcircuits) {
    numTotalWires += compiledSubcircuit.Nwires

    if (subcircuitInfoByName.has(compiledSubcircuit.name)) {
      throw new Error(`buildGlobalWireLayout: Duplicate subcircuit name '${compiledSubcircuit.name}'.`)
    }

    const normalizedPortLayout = {
      id: compiledSubcircuit.id,
      NWires: compiledSubcircuit.Nwires,
      NInWires: compiledSubcircuit.In_idx[1],
      NOutWires: compiledSubcircuit.Out_idx[1],
      inWireIndex: compiledSubcircuit.In_idx[0],
      outWireIndex: compiledSubcircuit.Out_idx[0],
      logicalInterface: compiledSubcircuit.logicalInterface,
    }
    subcircuitInfoByName.set(compiledSubcircuit.name, normalizedPortLayout)
  }

  const { directionByName, publicSegmentByName } = _validateBufferLayout(
    subcircuitInfoByName,
    libraryLayout,
  )
  for (const compiledSubcircuit of layoutSubcircuits) {
    const bufferDirection = directionByName.get(compiledSubcircuit.name)
    if (bufferDirection !== undefined) {
      compiledSubcircuit.bufferDirection = bufferDirection
    }
  }
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
      throw new Error(`buildGlobalWireLayout: Duplicate configured public subcircuit '${name}'.`)
    }
    configuredPublicNames.add(name)
    if (!subcircuitInfoByName.has(name)) {
      throw new Error(`buildGlobalWireLayout: Missing configured public subcircuit '${name}'.`)
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
  let nextPowerOfTwo = 1
  while (nextPowerOfTwo < l_free_actual) {
    nextPowerOfTwo <<= 1
  }
  const freePublicWirePadding = nextPowerOfTwo - l_free_actual
  const l_free = l_free_actual + freePublicWirePadding
  const l = l_free + fixedPublicWireCount

  nextPowerOfTwo = 1
  while (nextPowerOfTwo < numInterfaceWires) {
    nextPowerOfTwo <<= 1
  }

  const interfaceWirePadding = nextPowerOfTwo - numInterfaceWires
  const l_D = l + numInterfaceWires + interfaceWirePadding
  const m_D = numTotalWires + freePublicWirePadding + interfaceWirePadding
  // interfaceWirePadding makes m_I = l_D - l_free a power of two.

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
    let nextGlobalWireIndex = globalWireIndex
    for (const { name, direction, boundary } of segmentsByPhase.get(phase.name)) {
      nextGlobalWireIndex = _appendPublicWireSegment(
        globalWireList,
        layoutSubcircuits,
        nextGlobalWireIndex,
        subcircuitInfoByName.get(name),
        direction,
      )
      _recordPublicWireBoundary(publicWireBoundaries, boundary, nextGlobalWireIndex)
    }
    genericBoundaries[phase.genericBoundary] = nextGlobalWireIndex
    if (publicWireBoundaries[phase.terminalBoundary] !== nextGlobalWireIndex) {
      throw new Error(
        `buildGlobalWireLayout: Phase '${phase.name}' does not end at its configured terminal boundary.`,
      )
    }
    return nextGlobalWireIndex
  }

  let globalWireIndex = 0
  for (const phase of publicWirePhases) {
    if (phase.region === 'free') {
      globalWireIndex = appendPhase(phase, globalWireIndex)
    }
  }

  if (globalWireIndex !== l_free_actual) {
    throw new Error(`buildGlobalWireLayout: Free public wire count does not match flattened wire count.`)
  }

  for (let i = 0; i < freePublicWirePadding; i++) {
    _assignFlattenedWire(
      globalWireList,
      layoutSubcircuits,
      globalWireIndex++,
      -1,
      -1,
    )
  }

  if (globalWireIndex !== l_free) {
    throw new Error(`buildGlobalWireLayout: Public-wire padding does not reach the configured free boundary.`)
  }

  for (const phase of publicWirePhases) {
    if (phase.region === 'fixed') {
      globalWireIndex = appendPhase(phase, globalWireIndex)
    }
  }

  if (globalWireIndex !== l) {
    throw new Error(`buildGlobalWireLayout: Fixed public wire count does not match flattened wire count.`)
  }

  // Processing internal interface wires
  for (const [subcircuitName, targetSubcircuit] of subcircuitInfoByName) {
    // Include the Circom constant wire in the interface wire list.
    _assignFlattenedWire(
      globalWireList,
      layoutSubcircuits,
      globalWireIndex++,
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
        _assignFlattenedWire(
          globalWireList,
          layoutSubcircuits,
          globalWireIndex++,
          targetSubcircuit.id,
          internalWireIndex + i,
        )
      }
    } else {
      for (let i = 0; i < targetSubcircuit.NOutWires; i++) {
        _assignFlattenedWire(
          globalWireList,
          layoutSubcircuits,
          globalWireIndex++,
          targetSubcircuit.id,
          targetSubcircuit.outWireIndex + i,
        )
      }
      for (let i = 0; i < targetSubcircuit.NInWires; i++) {
        _assignFlattenedWire(
          globalWireList,
          layoutSubcircuits,
          globalWireIndex++,
          targetSubcircuit.id,
          targetSubcircuit.inWireIndex + i,
        )
      }
    }
  }

  for (let i = 0; i < interfaceWirePadding; i++) {
    _assignFlattenedWire(
      globalWireList,
      layoutSubcircuits,
      globalWireIndex++,
      -1,
      -1,
    )
  }

  if (globalWireIndex !== l_D) {
    throw new Error(`buildGlobalWireLayout: Error during flattening interface wires`)
  }
  // Processing internal private wires
  for (const targetSubcircuit of layoutSubcircuits) {
    const privateWireCount = targetSubcircuit.Nwires - (targetSubcircuit.Out_idx[1] + targetSubcircuit.In_idx[1]) - 1
    for (let i = 0; i < privateWireCount; i++) {
      _assignFlattenedWire(
        globalWireList,
        layoutSubcircuits,
        globalWireIndex++,
        targetSubcircuit.id,
        targetSubcircuit.In_idx[0] + targetSubcircuit.In_idx[1] + i,
      )
    }
  }

  if (globalWireIndex !== m_D) {
    throw new Error(`buildGlobalWireLayout: Error during flattening internal wires`)
  }

  _assertInternalInterfacePortPrefixes(layoutSubcircuits, l, l_D)

  return {
    ...publicWireBoundaries,
    ...genericBoundaries,
    l_free,
    l,
    l_D,
    m_D,
    subcircuits: layoutSubcircuits,
    wireList: globalWireList,
  }
}

function buildSetupParams(globalWireInfo, subcircuits, libraryLayout, sMax) {
  const maximumConstraintCount = Math.max(
    ...subcircuits.map(({ Nconsts }) => Nconsts),
  )
  let n = 1
  while (n < maximumConstraintCount) {
    n <<= 1
  }

  const setupParams = Object.fromEntries(
    libraryLayout.setupWireParameterKeys.map((key) => {
      const value = globalWireInfo[key]
      if (!Number.isFinite(value)) {
        throw new Error(`buildSetupParams: Missing configured setup parameter '${key}'.`)
      }
      return [key, value]
    }),
  )
  setupParams.n = n
  setupParams.s_D = subcircuits.length
  setupParams.s_max = sMax
  return setupParams
}

module.exports = {
  _assertInternalInterfacePortPrefixes,
  _validateBufferLayout,
  buildGlobalWireLayout,
  buildSetupParams,
}
