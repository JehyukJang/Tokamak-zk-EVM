import { bytesToBigInt, hexToBigInt, toBytes } from '@ethereumjs/util';
import { jubjub } from '@noble/curves/misc.js';
import { DataPtFactory } from '../../synthesizer/dataStructure/dataPt.ts';
import {
  DataPtDescription,
  DataPtType,
  ISynthesizerProvider,
  ReservedVariable,
  SynthesizerOpts,
  VARIABLE_DESCRIPTION,
  type DataPt,
  type PlacementEntry,
  type Placements,
  type PreparedComposition,
} from '../types/index.ts';
import {
  getDataPtTypeFromLogicalInterfaceType,
  getDataPtWireCount,
} from '../types/dataStructure.ts';
import {
  BUFFER_DESCRIPTION,
  BUFFER_LIST,
  ReservedBuffer,
  SubcircuitInfoByName,
  SubcircuitInfoByNameEntry,
  SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import type {
  PlacementComposition,
  PlacementCompositionMapping,
} from '../../subcircuit/placementCompositionMapping.ts';
import type { LogicalInterfacePort } from '../../subcircuit/libraryTypes.ts';
import { FUNCTION_INPUT_LENGTH, POSEIDON_INPUTS } from 'tokamak-l2js';

export function placementEntryDeepCopy(placement: PlacementEntry): PlacementEntry {
  return {
    ...placement,
    inPts: placement.inPts.slice(),
    outPts: placement.outPts.slice(),
  }
}

export function placementsDeepCopy(placements: Placements): Placements {
  const copy: Placements = []
  for (const placement of placements) {
    copy.push(placementEntryDeepCopy(placement))
  }
  return copy
}

function _assertPreparedInput(
  preparedComposition: PreparedComposition,
  stepIndex: number,
  inputIndex: number,
  input: PlacementComposition['steps'][number]['inputs'][number],
  preparedInput: DataPt,
  composition: PlacementComposition,
  intermediateOutPts: readonly (DataPt | undefined)[],
  basePlacementIndex: number,
): void {
  if (
    !Number.isInteger(preparedInput.source)
    || preparedInput.source < 0
    || preparedInput.source >= basePlacementIndex + stepIndex
  ) {
    throw new Error(
      `Synthesizer: ${preparedComposition.operation} step ${stepIndex} input ${inputIndex} is not connected to an earlier placement output`,
    )
  }

  let expectedInput: DataPt | undefined
  switch (input.kind) {
    case 'operand':
      expectedInput = preparedComposition.operands[input.index]
      break
    case 'step-output':
      expectedInput = intermediateOutPts[input.index]
      break
    case 'constant': {
      const constant = composition.constants[input.index]
      if (
        constant === undefined
        || preparedInput.source !== BUFFER_LIST.indexOf('EVM_IN')
        || preparedInput.value !== constant.value
        || !_hasSameDataPtType(preparedInput, constant.dataPtType)
      ) {
        throw new Error(
          `Synthesizer: ${preparedComposition.operation} step ${stepIndex} constant ${input.index} is invalid`,
        )
      }
      return
    }
    case 'selector':
      if (typeof composition.steps[stepIndex]!.selector !== 'bigint') {
        throw new Error(
          `Synthesizer: ${preparedComposition.operation} step ${stepIndex} requires a static selector`,
        )
      }
      if (
        preparedInput.source !== BUFFER_LIST.indexOf('EVM_IN')
        || preparedInput.value !== composition.steps[stepIndex]!.selector
      ) {
        throw new Error(
          `Synthesizer: ${preparedComposition.operation} step ${stepIndex} selector is invalid`,
        )
      }
      return
  }

  if (expectedInput === undefined || !_isSameWire(preparedInput, expectedInput)) {
    throw new Error(
      `Synthesizer: ${preparedComposition.operation} step ${stepIndex} input ${inputIndex} is not connected to its declared source`,
    )
  }
}

function _assertPreparedWireCount(
  operation: PreparedComposition['operation'],
  subcircuit: SubcircuitNames,
  target: 'input' | 'output',
  dataPts: readonly DataPt[],
  expectedWireCount: number,
): void {
  const actualWireCount = dataPts.reduce(
    (count, { dataPtType }) => count + getDataPtWireCount(dataPtType),
    0,
  )
  if (actualWireCount !== expectedWireCount) {
    throw new Error(
      `Synthesizer: ${operation} ${subcircuit} expected ${expectedWireCount} ${target} wires, but got ${actualWireCount}`,
    )
  }
}

function _assertPreparedPortTypes(
  operation: PreparedComposition['operation'],
  subcircuit: SubcircuitNames,
  target: 'input' | 'output',
  dataPts: readonly DataPt[],
  ports: readonly LogicalInterfacePort[],
): void {
  if (dataPts.length !== ports.length) {
    throw new Error(
      `Synthesizer: ${operation} ${subcircuit} expected ${ports.length} ${target} ports, but got ${dataPts.length}`,
    )
  }

  for (const [portIndex, port] of ports.entries()) {
    const expectedDataPtType = getDataPtTypeFromLogicalInterfaceType(port.logicalType)
    const dataPt = dataPts[portIndex]!
    if (!_hasSameDataPtType(dataPt, expectedDataPtType)) {
      throw new Error(
        `Synthesizer: ${operation} ${subcircuit} ${target} port ${portIndex} (${port.name}) expected ${expectedDataPtType}, but got ${dataPt.dataPtType}`,
      )
    }
  }
}

function _assertPreparedStepPorts(
  operation: PreparedComposition['operation'],
  subcircuitName: SubcircuitNames,
  preparedStep: PreparedComposition['steps'][number],
  subcircuit: SubcircuitInfoByNameEntry,
): void {
  _assertPreparedWireCount(
    operation,
    subcircuitName,
    'input',
    preparedStep.inPts,
    subcircuit.NInWires,
  )
  _assertPreparedWireCount(
    operation,
    subcircuitName,
    'output',
    preparedStep.outPts,
    subcircuit.NOutWires,
  )
  if (subcircuit.logicalInterface === undefined) {
    throw new Error(
      `Synthesizer: ${subcircuitName} has no logical interface for ${operation}`,
    )
  }
  _assertPreparedPortTypes(
    operation,
    subcircuitName,
    'input',
    preparedStep.inPts,
    subcircuit.logicalInterface.inputs,
  )
  _assertPreparedPortTypes(
    operation,
    subcircuitName,
    'output',
    preparedStep.outPts,
    subcircuit.logicalInterface.outputs,
  )
}

function _isSameWire(left: DataPt, right: DataPt): boolean {
  return left.source === right.source && left.wireIndex === right.wireIndex
}

function _hasSameDataPtType(
  dataPt: DataPt,
  expectedType: DataPt['dataPtType'],
): boolean {
  return dataPt.dataPtType === expectedType
}

function _assertStaticPreparedValue(
  operation: PreparedComposition['operation'],
  description: string,
  dataPt: DataPt,
  expectedValue: bigint,
): void {
  if (
    dataPt.source !== BUFFER_LIST.indexOf('EVM_IN')
    || dataPt.value !== expectedValue
  ) {
    throw new Error(
      `Synthesizer: ${operation} ${description} must be the EVM_IN static value ${expectedValue}`,
    )
  }
}

function _assertPreparedEarlierSource(
  operation: PreparedComposition['operation'],
  stepIndex: number,
  inputIndex: number,
  dataPt: DataPt,
  basePlacementIndex: number,
): void {
  if (
    !Number.isInteger(dataPt.source)
    || dataPt.source < 0
    || dataPt.source >= basePlacementIndex + stepIndex
  ) {
    throw new Error(
      `Synthesizer: ${operation} step ${stepIndex} input ${inputIndex} is not connected to an earlier placement output`,
    )
  }
}

export class PlacementManager {
  private _placements: Placements = []
  private _cachedEVMIn: Map<bigint, Map<string, DataPt>> = new Map()

  public subcircuitInfoByName: SubcircuitInfoByName;
  private readonly _bufferSubcircuitByBuffer: Record<ReservedBuffer, SubcircuitInfoByNameEntry | undefined>;
  private readonly _placementCompositionMapping: PlacementCompositionMapping;

  constructor(
    private readonly parent: ISynthesizerProvider,
    private readonly cachedOpts: SynthesizerOpts,
  ) {
    this.subcircuitInfoByName = parent.subcircuitLibrary.subcircuitInfoByName
    this._bufferSubcircuitByBuffer = parent.subcircuitLibrary.subcircuitBufferMapping
    this._placementCompositionMapping = parent.subcircuitLibrary.placementCompositionMapping
    this._initBuffers()
  }

  public get placements(): Placements {
    // Placements are mutated only through this class's private placement and buffer helpers.
    return placementsDeepCopy(this._placements)
  }

  public addReservedVariableToBufferIn(
    varName: ReservedVariable,
    value: bigint = 0n,
    dynamic: boolean = false,
    message?: string,
  ): DataPt {
    const placementIndex = VARIABLE_DESCRIPTION[varName].source
    const wireDesc: DataPtDescription = {
      ...VARIABLE_DESCRIPTION[varName],
      extSource: VARIABLE_DESCRIPTION[varName].extSource + (message ?? ''),
    }
    const externalDataPt = DataPtFactory.create(wireDesc, value)
    if (dynamic) {
      if (wireDesc.wireIndex !== -1) {
        throw new Error('This variable is static')
      }
      externalDataPt.wireIndex = this._placements[placementIndex]!.inPts.length
    }
    const symbolDataPt = DataPtFactory.createBufferTwin(externalDataPt)
    return DataPtFactory.deepCopy(this._appendBufferWirePair(externalDataPt, symbolDataPt, dynamic))
  }

  public addReservedVariableToBufferOut(
    varName: ReservedVariable,
    symbolDataPt: DataPt,
    dynamic: boolean = false,
    message?: string,
  ): DataPt {
    const placementIndex = VARIABLE_DESCRIPTION[varName].source
    const wireDesc: DataPtDescription = {
      ...VARIABLE_DESCRIPTION[varName],
      extDest: VARIABLE_DESCRIPTION[varName].extDest + (message ?? ''),
    }
    const externalDataPt = DataPtFactory.create(wireDesc, symbolDataPt.value)
    if (dynamic) {
      if (wireDesc.wireIndex !== -1) {
        throw new Error('This variable is static')
      }
      externalDataPt.wireIndex = this._placements[placementIndex]!.inPts.length
    }
    return DataPtFactory.deepCopy(this._appendBufferWirePair(symbolDataPt, externalDataPt, dynamic))
  }

  public loadArbitraryStatic(
    value: bigint,
    dataPtType: DataPtType,
    desc?: string,
  ): DataPt {
    const cacheKey = dataPtType
    if (desc === undefined) {
      const cachedDataPt = this._cachedEVMIn.get(value)?.get(cacheKey)
      if (cachedDataPt !== undefined) {
        return DataPtFactory.deepCopy(cachedDataPt)
      }
    }
    const placementIndex = BUFFER_LIST.indexOf('EVM_IN')
    const inPtRaw: DataPtDescription = {
      extSource: desc ?? 'Arbitrary constant',
      source: placementIndex,
      wireIndex: this._placements[placementIndex]!.inPts.length,
      dataPtType,
    }
    const inPt = DataPtFactory.create(inPtRaw, value)
    const outPt = DataPtFactory.createBufferTwin(inPt)
    this._appendBufferWirePair(inPt, outPt, true)
    const cachedByType = this._cachedEVMIn.get(value) ?? new Map<string, DataPt>()
    cachedByType.set(cacheKey, outPt)
    this._cachedEVMIn.set(value, cachedByType)
    return DataPtFactory.deepCopy(outPt)
  }

  public getReservedVariableFromBuffer(varName: ReservedVariable): DataPt {
    if (VARIABLE_DESCRIPTION[varName].extSource === undefined) {
      throw new Error('Usable only for reserved variables of input buffers')
    }
    const placementIndex = VARIABLE_DESCRIPTION[varName].source
    const wireIndex = VARIABLE_DESCRIPTION[varName].wireIndex
    const outPt = this._placements[placementIndex]!.outPts[wireIndex]!
    if (outPt.wireIndex !== wireIndex || outPt.source !== placementIndex) {
      throw new Error('Invalid wire information')
    }
    return DataPtFactory.deepCopy(outPt)
  }

  private _initBuffers(): void {
    for (const buffer of BUFFER_LIST) {
      this._placeBuffer(buffer, [], [], BUFFER_DESCRIPTION[buffer])
    }

    this.addReservedVariableToBufferIn('CIRCOM_CONST_ONE', 1n)
    this.addReservedVariableToBufferIn('CIRCOM_CONST_ZERO', 0n)
    this.addReservedVariableToBufferIn('ADDRESS_MASK', (1n << 160n) - 1n)
    this.addReservedVariableToBufferIn('JUBJUB_BASE_X', jubjub.Point.BASE.toAffine().x)
    this.addReservedVariableToBufferIn('JUBJUB_BASE_Y', jubjub.Point.BASE.toAffine().y)
    this.addReservedVariableToBufferIn('JUBJUB_POI_X', jubjub.Point.ZERO.toAffine().x)
    this.addReservedVariableToBufferIn('JUBJUB_POI_Y', jubjub.Point.ZERO.toAffine().y)
    this.addReservedVariableToBufferIn('COINBASE', hexToBigInt(this.cachedOpts.blockInfo.coinBase))
    this.addReservedVariableToBufferIn('TIMESTAMP', hexToBigInt(this.cachedOpts.blockInfo.timeStamp))
    this.addReservedVariableToBufferIn('NUMBER', hexToBigInt(this.cachedOpts.blockInfo.blockNumber))
    this.addReservedVariableToBufferIn('PREVRANDAO', hexToBigInt(this.cachedOpts.blockInfo.prevRanDao))
    this.addReservedVariableToBufferIn('GASLIMIT', hexToBigInt(this.cachedOpts.blockInfo.gasLimit))
    this.addReservedVariableToBufferIn('CHAINID', hexToBigInt(this.cachedOpts.blockInfo.chainId))
    this.addReservedVariableToBufferIn('SELFBALANCE', hexToBigInt(this.cachedOpts.blockInfo.selfBalance))
    this.addReservedVariableToBufferIn('BASEFEE', hexToBigInt(this.cachedOpts.blockInfo.baseFee))
    for (let i = 1; i <= this.parent.subcircuitLibrary.numberOfPrevBlockHashes; i++) {
      this.addReservedVariableToBufferIn(
        `BLOCKHASH_${i}` as ReservedVariable,
        hexToBigInt(this.cachedOpts.blockInfo.prevBlockHashes[i - 1]),
      )
    }

    this._initTransactionBuffer()

    for (const [placementIndex, buffer] of BUFFER_LIST.entries()) {
      const placement = this._placements[placementIndex]!
      const actualNumberInWires = placement.inPts.filter((wire) => wire !== undefined).length
      const actualNumberOutWires = placement.outPts.filter((wire) => wire !== undefined).length
      if (
        actualNumberInWires - 1 !== (placement.inPts.at(-1)?.wireIndex ?? -1)
        || actualNumberOutWires - 1 !== (placement.outPts.at(-1)?.wireIndex ?? -1)
      ) {
        throw new Error('Some wires are omitted while initializing buffers')
      }
      if (actualNumberInWires !== actualNumberOutWires) {
        throw new Error(`Input and output wires mismatch in ${buffer} buffer`)
      }
    }
  }

  private _initTransactionBuffer(): void {
    const l2Tx = this.cachedOpts.signedTransaction
    const senderPublicKey = l2Tx.getUnsafeEddsaPubKey()
    const randomizer = l2Tx.r === undefined ? undefined : l2Tx.getUnsafeEddsaRandomizer()
    this.addReservedVariableToBufferIn('EDDSA_PUBLIC_KEY_X', senderPublicKey.toAffine().x)
    this.addReservedVariableToBufferIn('EDDSA_PUBLIC_KEY_Y', senderPublicKey.toAffine().y)
    this.addReservedVariableToBufferIn('EDDSA_RANDOMIZER_X', randomizer?.toAffine().x)
    this.addReservedVariableToBufferIn('EDDSA_RANDOMIZER_Y', randomizer?.toAffine().y)
    this.addReservedVariableToBufferIn('EDDSA_SIGNATURE', l2Tx.s)
    this.addReservedVariableToBufferIn('CONTRACT_ADDRESS', bytesToBigInt(toBytes(l2Tx.to)))
    this.addReservedVariableToBufferIn('FUNCTION_SELECTOR', bytesToBigInt(l2Tx.getFunctionSelector()))
    this.addReservedVariableToBufferIn('TRANSACTION_NONCE', l2Tx.nonce)
    for (let inputIndex = 0; inputIndex < FUNCTION_INPUT_LENGTH; inputIndex++) {
      this.addReservedVariableToBufferIn(
        `TRANSACTION_INPUT${inputIndex}` as ReservedVariable,
        bytesToBigInt(l2Tx.getFunctionInput(inputIndex)),
      )
    }
  }

  private _getLogOutPlacement(): PlacementEntry {
    const logOutPlacement = this._placements[BUFFER_LIST.indexOf('LOG_OUT')]
    if (logOutPlacement === undefined) {
      throw new Error('Synthesizer: LOG_OUT buffer placement is missing')
    }
    return logOutPlacement
  }

  public getLogOutWireLength(): number {
    const logOutPlacement = this._getLogOutPlacement()
    if (logOutPlacement.inPts.length !== logOutPlacement.outPts.length) {
      throw new Error('Synthesizer: LOG_OUT input and output lengths do not match')
    }
    return logOutPlacement.inPts.length
  }

  public truncateLogOut(logOutLength: number): void {
    const logOutPlacement = this._getLogOutPlacement()
    if (
      logOutPlacement.inPts.length !== logOutPlacement.outPts.length
      || logOutPlacement.inPts.length < logOutLength
    ) {
      throw new Error('Synthesizer: LOG_OUT buffer is inconsistent with its frame snapshot')
    }
    logOutPlacement.inPts.length = logOutLength
    logOutPlacement.outPts.length = logOutLength
  }

  private _place(
    name: SubcircuitNames,
    inPts: DataPt[],
    outPts: DataPt[],
    usage: string,
  ) {
    for (const inPt of inPts) {
      if (typeof inPt.source !== 'number') {
        throw new Error(
          `Synthesizer: Placing a subcircuit: Input wires to a new placement must be connected to the output wires of other placements.`,
        );
      }
    }
    const placement: PlacementEntry = {
      name,
      usage,
      subcircuitId: this.subcircuitInfoByName.get(name)!.id,
      inPts,
      outPts,
    };
    this._placements.push(placement);
  }

  private _placeBuffer(
    buffer: ReservedBuffer,
    inPts: DataPt[],
    outPts: DataPt[],
    usage: string,
  ): void {
    const subcircuit = this._bufferSubcircuitByBuffer[buffer]
    if (subcircuit === undefined) {
      throw new Error(`Synthesizer: Buffer subcircuit is not found for ${buffer}`)
    }
    this._place(subcircuit.name, inPts, outPts, usage)
  }

  public placeComposition(preparedComposition: PreparedComposition): void {
    const composition = this._placementCompositionMapping[preparedComposition.operation]
    if (composition.placementStrategy === 'generic') {
      this._validatePreparedGenericComposition(preparedComposition, composition)
      for (const [stepIndex, step] of composition.steps.entries()) {
        const preparedStep = preparedComposition.steps[stepIndex]!
        this._place(
          step.subcircuit,
          preparedStep.inPts.slice(),
          preparedStep.outPts.slice(),
          preparedComposition.operation,
        )
      }
      return
    }
    if (composition.placementStrategy === 'poseidon') {
      this._validatePreparedPoseidonComposition(preparedComposition, composition)
      const step = composition.steps[0]!
      for (const preparedStep of preparedComposition.steps) {
        this._place(
          step.subcircuit,
          preparedStep.inPts.slice(),
          preparedStep.outPts.slice(),
          preparedComposition.operation,
        )
      }
      return
    }
    if (composition.placementStrategy === 'memory-load') {
      this._validatePreparedMemoryLoadComposition(preparedComposition, composition)
      const step = composition.steps[0]!
      for (const preparedStep of preparedComposition.steps) {
        this._place(
          step.subcircuit,
          preparedStep.inPts.slice(),
          preparedStep.outPts.slice(),
          preparedComposition.operation,
        )
      }
      return
    }
    throw new Error(
      `Synthesizer: ${preparedComposition.operation} requires ${composition.placementStrategy} placement preparation`,
    )
  }

  private _validatePreparedPoseidonComposition(
    preparedComposition: PreparedComposition,
    composition: PlacementComposition,
  ): void {
    const step = composition.steps[0]!
    if (preparedComposition.resultPts.length !== 1) {
      throw new Error('Synthesizer: Poseidon must produce exactly one result')
    }
    const subcircuit = this.subcircuitInfoByName.get(step.subcircuit)
    if (subcircuit === undefined) {
      throw new Error('Synthesizer: Poseidon subcircuit is not found. Check qap-compiler.')
    }
    const inputLimit = step.inputs.length - 1

    const basePlacementIndex = this._placements.length
    let chainInputs: Array<DataPt | undefined> = preparedComposition.operands.slice()
    if (chainInputs.length === 0) {
      chainInputs = [undefined, undefined]
    } else if (chainInputs.length === 1) {
      chainInputs.push(undefined)
    }

    let stepIndex = 0
    let resultPt: DataPt
    while (chainInputs.length > inputLimit) {
      resultPt = this._validatePreparedPoseidonStep(
        preparedComposition,
        step,
        subcircuit,
        stepIndex,
        chainInputs.slice(0, inputLimit),
        basePlacementIndex,
      )
      chainInputs = [resultPt, ...chainInputs.slice(inputLimit)]
      stepIndex++
    }
    resultPt = this._validatePreparedPoseidonStep(
      preparedComposition,
      step,
      subcircuit,
      stepIndex,
      chainInputs,
      basePlacementIndex,
    )
    stepIndex++
    if (preparedComposition.steps.length !== stepIndex) {
      throw new Error(
        `Synthesizer: Poseidon expected ${stepIndex} placement steps, but got ${preparedComposition.steps.length}`,
      )
    }
    if (!_isSameWire(preparedComposition.resultPts[0]!, resultPt)) {
      throw new Error('Synthesizer: Poseidon result is not connected to its final placement')
    }
  }

  private _validatePreparedMemoryLoadComposition(
    preparedComposition: PreparedComposition,
    composition: PlacementComposition,
  ): void {
    const step = composition.steps[0]!
    const inputsPerFragment = 4
    if (preparedComposition.resultPts.length !== 1) {
      throw new Error('Synthesizer: MemoryLoad must produce exactly one result')
    }
    if (
      preparedComposition.operands.length <= 1
      || (preparedComposition.operands.length - 1) % inputsPerFragment !== 0
    ) {
      throw new Error('Synthesizer: MemoryLoad operands must contain one or more four-input fragments and final coverage')
    }
    const fragmentCount = (preparedComposition.operands.length - 1) / inputsPerFragment
    if (preparedComposition.steps.length !== fragmentCount) {
      throw new Error(
        `Synthesizer: MemoryLoad expected ${fragmentCount} placement steps, but got ${preparedComposition.steps.length}`,
      )
    }
    const subcircuit = this.subcircuitInfoByName.get(step.subcircuit)
    if (subcircuit === undefined) {
      throw new Error('Synthesizer: MemoryLoadStep subcircuit is not found. Check qap-compiler.')
    }

    const basePlacementIndex = this._placements.length
    const expectedCoveragePt = preparedComposition.operands.at(-1)!
    let accumulatedCoverage = 0n
    let previousWordPt: DataPt | undefined
    let previousOwnershipPt: DataPt | undefined

    for (let stepIndex = 0; stepIndex < fragmentCount; stepIndex++) {
      const preparedStep = preparedComposition.steps[stepIndex]!
      _assertPreparedStepPorts(
        preparedComposition.operation,
        step.subcircuit,
        preparedStep,
        subcircuit,
      )
      if (
        preparedStep.inPts.length !== step.inputs.length
        || preparedStep.outPts.length !== step.outputs.length
      ) {
        throw new Error(`Synthesizer: MemoryLoad step ${stepIndex} has an invalid port count`)
      }

      const operandOffset = stepIndex * inputsPerFragment
      for (let inputIndex = 0; inputIndex < inputsPerFragment; inputIndex++) {
        const input = preparedStep.inPts[inputIndex]!
        if (!_isSameWire(input, preparedComposition.operands[operandOffset + inputIndex]!)) {
          throw new Error(
            `Synthesizer: MemoryLoad step ${stepIndex} fragment input ${inputIndex} is not connected to its declared operand`,
          )
        }
        _assertPreparedEarlierSource(
          preparedComposition.operation,
          stepIndex,
          inputIndex,
          input,
          basePlacementIndex,
        )
      }

      const [sourceWordPt, shiftPt, directionPt, ownershipPt] = preparedStep.inPts
      _assertStaticPreparedValue(preparedComposition.operation, `step ${stepIndex} byte shift`, shiftPt!, shiftPt!.value)
      _assertStaticPreparedValue(preparedComposition.operation, `step ${stepIndex} shift direction`, directionPt!, directionPt!.value)
      _assertStaticPreparedValue(preparedComposition.operation, `step ${stepIndex} byte ownership`, ownershipPt!, ownershipPt!.value)
      if (sourceWordPt === undefined || shiftPt === undefined || directionPt === undefined || ownershipPt === undefined) {
        throw new Error(`Synthesizer: MemoryLoad step ${stepIndex} is missing fragment inputs`)
      }

      accumulatedCoverage |= ownershipPt.value
      const previousWordInput = preparedStep.inPts[4]!
      const previousOwnershipInput = preparedStep.inPts[5]!
      if (stepIndex === 0) {
        _assertStaticPreparedValue(preparedComposition.operation, 'initial word', previousWordInput, 0n)
        _assertStaticPreparedValue(preparedComposition.operation, 'initial byte ownership', previousOwnershipInput, 0n)
      } else if (
        previousWordPt === undefined
        || previousOwnershipPt === undefined
        || !_isSameWire(previousWordInput, previousWordPt)
        || !_isSameWire(previousOwnershipInput, previousOwnershipPt)
      ) {
        throw new Error(`Synthesizer: MemoryLoad step ${stepIndex} is not connected to the previous step`)
      }

      if (!_isSameWire(preparedStep.inPts[6]!, expectedCoveragePt)) {
        throw new Error(`Synthesizer: MemoryLoad step ${stepIndex} final coverage is inconsistent`)
      }
      _assertStaticPreparedValue(
        preparedComposition.operation,
        `step ${stepIndex} final-mode flag`,
        preparedStep.inPts[7]!,
        stepIndex === fragmentCount - 1 ? 1n : 0n,
      )

      const nextWordPt = preparedStep.outPts[0]!
      const nextOwnershipPt = preparedStep.outPts[1]!
      if (
        nextWordPt.source !== basePlacementIndex + stepIndex
        || nextWordPt.wireIndex !== 0
        || nextOwnershipPt.source !== basePlacementIndex + stepIndex
        || nextOwnershipPt.wireIndex !== 1
      ) {
        throw new Error(`Synthesizer: MemoryLoad step ${stepIndex} has invalid output sources`)
      }
      previousWordPt = nextWordPt
      previousOwnershipPt = nextOwnershipPt
    }

    _assertStaticPreparedValue(
      preparedComposition.operation,
      'final byte ownership',
      expectedCoveragePt,
      accumulatedCoverage,
    )
    if (previousWordPt === undefined || !_isSameWire(preparedComposition.resultPts[0]!, previousWordPt)) {
      throw new Error('Synthesizer: MemoryLoad result is not connected to its final placement')
    }
  }

  private _validatePreparedPoseidonStep(
    preparedComposition: PreparedComposition,
    step: PlacementComposition['steps'][number],
    subcircuit: SubcircuitInfoByNameEntry,
    stepIndex: number,
    expectedPayload: readonly (DataPt | undefined)[],
    basePlacementIndex: number,
  ): DataPt {
    const preparedStep = preparedComposition.steps[stepIndex]
    if (preparedStep === undefined) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} is unavailable`)
    }
    _assertPreparedStepPorts(
      preparedComposition.operation,
      step.subcircuit,
      preparedStep,
      subcircuit,
    )
    if (
      preparedStep.inPts.length !== step.inputs.length
      || preparedStep.outPts.length !== step.outputs.length
    ) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} has an invalid port count`)
    }
    const selector = preparedStep.inPts[0]!
    const expectedSelector = 1n << BigInt(expectedPayload.length - POSEIDON_INPUTS)
    if (
      selector.source !== BUFFER_LIST.indexOf('EVM_IN')
      || selector.value !== expectedSelector
    ) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} selector is invalid`)
    }

    for (let payloadIndex = 0; payloadIndex < step.inputs.length - 1; payloadIndex++) {
      const input = preparedStep.inPts[payloadIndex + 1]!
      if (
        !Number.isInteger(input.source)
        || input.source < 0
        || input.source >= basePlacementIndex + stepIndex
      ) {
        throw new Error(
          `Synthesizer: Poseidon step ${stepIndex} input ${payloadIndex} is not connected to an earlier placement output`,
        )
      }
      const expectedInput = expectedPayload[payloadIndex]
      if (expectedInput === undefined) {
        if (input.source !== BUFFER_LIST.indexOf('EVM_IN') || input.value !== 0n) {
          throw new Error(`Synthesizer: Poseidon step ${stepIndex} padding is invalid`)
        }
      } else if (!_isSameWire(input, expectedInput)) {
        throw new Error(
          `Synthesizer: Poseidon step ${stepIndex} input ${payloadIndex} is not connected to its declared source`,
        )
      }
    }

    const output = preparedStep.outPts[0]!
    if (
      output.source !== basePlacementIndex + stepIndex
      || output.wireIndex !== 0
    ) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} has an invalid output source`)
    }
    return output
  }

  private _validatePreparedGenericComposition(
    preparedComposition: PreparedComposition,
    composition: PlacementComposition,
  ): void {
    if (
      composition.numSteps === 'dynamic'
      || composition.numOperands === 'dynamic'
    ) {
      throw new Error(
        `Synthesizer: ${preparedComposition.operation} generic placement requires fixed composition sizes`,
      )
    }
    if (preparedComposition.steps.length !== composition.numSteps) {
      throw new Error(
        `Synthesizer: ${preparedComposition.operation} expected ${composition.numSteps} placement steps, but got ${preparedComposition.steps.length}`,
      )
    }
    if (preparedComposition.operands.length !== composition.numOperands) {
      throw new Error(
        `Synthesizer: ${preparedComposition.operation} expected ${composition.numOperands} operands, but got ${preparedComposition.operands.length}`,
      )
    }
    if (preparedComposition.resultPts.length !== composition.numResults) {
      throw new Error(
        `Synthesizer: ${preparedComposition.operation} expected ${composition.numResults} results, but got ${preparedComposition.resultPts.length}`,
      )
    }

    const basePlacementIndex = this._placements.length
    const intermediateOutPts: Array<DataPt | undefined> = []
    const resultOutPts: Array<DataPt | undefined> = Array(composition.numResults)

    for (const [stepIndex, step] of composition.steps.entries()) {
      const preparedStep = preparedComposition.steps[stepIndex]!
      const subcircuit = this.subcircuitInfoByName.get(step.subcircuit)
      if (subcircuit === undefined) {
        throw new Error(
          `Synthesizer: ${step.subcircuit} subcircuit is not found for ${preparedComposition.operation}. Check qap-compiler.`,
        )
      }
      _assertPreparedStepPorts(
        preparedComposition.operation,
        step.subcircuit,
        preparedStep,
        subcircuit,
      )
      if (preparedStep.inPts.length !== step.inputs.length) {
        throw new Error(
          `Synthesizer: ${preparedComposition.operation} step ${stepIndex} expected ${step.inputs.length} inputs, but got ${preparedStep.inPts.length}`,
        )
      }
      if (preparedStep.outPts.length !== step.outputs.length) {
        throw new Error(
          `Synthesizer: ${preparedComposition.operation} step ${stepIndex} expected ${step.outputs.length} outputs, but got ${preparedStep.outPts.length}`,
        )
      }

      for (const [inputIndex, input] of step.inputs.entries()) {
        _assertPreparedInput(
          preparedComposition,
          stepIndex,
          inputIndex,
          input,
          preparedStep.inPts[inputIndex]!,
          composition,
          intermediateOutPts,
          basePlacementIndex,
        )
      }

      for (const [outputIndex, output] of step.outputs.entries()) {
        const preparedOutput = preparedStep.outPts[outputIndex]!
        if (
          preparedOutput.source !== basePlacementIndex + stepIndex
          || preparedOutput.wireIndex !== outputIndex
        ) {
          throw new Error(
            `Synthesizer: ${preparedComposition.operation} step ${stepIndex} output ${outputIndex} has an invalid placement source`,
          )
        }
        if (output.kind === 'step-output') {
          intermediateOutPts[output.index] = preparedOutput
        } else if (output.kind === 'result') {
          resultOutPts[output.index] = preparedOutput
        }
      }
    }

    for (const [resultIndex, resultPt] of preparedComposition.resultPts.entries()) {
      const producedResult = resultOutPts[resultIndex]
      if (producedResult === undefined || !_isSameWire(resultPt, producedResult)) {
        throw new Error(
          `Synthesizer: ${preparedComposition.operation} result ${resultIndex} is not connected to its declared producer`,
        )
      }
    }
  }

  private _appendBufferWirePair(inPt: DataPt, outPt: DataPt, dynamic: boolean): DataPt {
    const thisPlacementId = outPt.source
    if (dynamic) {
      if (
        this._placements[thisPlacementId]!.inPts.length !== this._placements[thisPlacementId]!.outPts.length
        || this._placements[thisPlacementId]!.outPts.length !== outPt.wireIndex
      ) {
        throw new Error(
          `Synthesizer: Mismatch in the buffer wires (placement id: ${thisPlacementId})`
        );
      }
      // Append one input-output pair to the buffer placement.
      this._placements[thisPlacementId]!.inPts.push(inPt);
      this._placements[thisPlacementId]!.outPts.push(outPt);
    } else {
      this._placements[thisPlacementId]!.inPts[inPt.wireIndex] = inPt
      this._placements[thisPlacementId]!.outPts[outPt.wireIndex] = outPt
    }
    
    return DataPtFactory.deepCopy(outPt)
  }
}
