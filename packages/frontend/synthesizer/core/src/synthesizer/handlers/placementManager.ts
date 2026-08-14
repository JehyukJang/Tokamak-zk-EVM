import { bytesToBigInt, hexToBigInt, toBytes } from '@ethereumjs/util';
import { jubjub } from '@noble/curves/misc.js';
import { DataPtFactory } from '../../synthesizer/dataStructure/dataPt.ts';
import {
  DataPtDescription,
  DataPtType,
  ReservedVariable,
  SynthesizerOpts,
  VARIABLE_DESCRIPTION,
  UINT32_DATA_PT_TYPE,
  type DataPt,
  type CompositionOperands,
  type PlacementEntry,
  type Placements,
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
  type Operator,
} from '../../subcircuit/configuredTypes.ts';
import type {
  PlacementComposition,
  PlacementCompositionMapping,
} from '../../subcircuit/placementCompositionMapping.ts';
import type { LogicalInterfacePort, ResolvedSubcircuitLibrary } from '../../subcircuit/libraryTypes.ts';
import { FUNCTION_INPUT_LENGTH, POSEIDON_INPUTS } from 'tokamak-l2js';

type PlacementCandidate = Readonly<{
  operation: Operator;
  operands: CompositionOperands;
  resultPts: readonly DataPt[];
  placements: readonly PlacementEntry[];
}>;

const isNestedOperands = (
  operands: CompositionOperands,
): operands is readonly (readonly DataPt[])[] =>
  operands.length > 0 && Array.isArray(operands[0]);

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

function _assertCandidateInput(
  candidate: PlacementCandidate,
  stepIndex: number,
  inputIndex: number,
  input: PlacementComposition['steps'][number]['inputs'][number],
  candidateInput: DataPt,
  composition: PlacementComposition,
  intermediateOutPts: readonly (DataPt | undefined)[],
  basePlacementIndex: number,
): void {
  if (
    !Number.isInteger(candidateInput.source)
    || candidateInput.source < 0
    || candidateInput.source >= basePlacementIndex + stepIndex
  ) {
    throw new Error(
      `Synthesizer: ${candidate.operation} step ${stepIndex} input ${inputIndex} is not connected to an earlier placement output`,
    )
  }

  let expectedInput: DataPt | undefined
  switch (input.kind) {
    case 'operand':
      if (isNestedOperands(candidate.operands)) {
        throw new Error(`Synthesizer: ${candidate.operation} generic operands must be flat`)
      }
      expectedInput = candidate.operands[input.index] as DataPt | undefined
      break
    case 'step-output':
      expectedInput = intermediateOutPts[input.index]
      break
    case 'constant': {
      const constant = composition.constants[input.index]
      if (
        constant === undefined
        || candidateInput.source !== BUFFER_LIST.indexOf('EVM_IN')
        || candidateInput.value !== constant.value
        || !_hasSameDataPtType(candidateInput, constant.dataPtType)
      ) {
        throw new Error(
          `Synthesizer: ${candidate.operation} step ${stepIndex} constant ${input.index} is invalid`,
        )
      }
      return
    }
    case 'selector':
      if (typeof composition.steps[stepIndex]!.selector !== 'bigint') {
        throw new Error(
          `Synthesizer: ${candidate.operation} step ${stepIndex} requires a static selector`,
        )
      }
      if (
        candidateInput.source !== BUFFER_LIST.indexOf('EVM_IN')
        || candidateInput.value !== composition.steps[stepIndex]!.selector
      ) {
        throw new Error(
          `Synthesizer: ${candidate.operation} step ${stepIndex} selector is invalid`,
        )
      }
      return
  }

  if (expectedInput === undefined || !_isSameWire(candidateInput, expectedInput)) {
    throw new Error(
      `Synthesizer: ${candidate.operation} step ${stepIndex} input ${inputIndex} is not connected to its declared source`,
    )
  }
}

function _assertCandidateWireCount(
  operation: Operator,
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

function _assertCandidatePortTypes(
  operation: Operator,
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

function _assertCandidateStepPorts(
  operation: Operator,
  subcircuitName: SubcircuitNames,
  candidateStep: PlacementEntry,
  subcircuit: SubcircuitInfoByNameEntry,
): void {
  if (
    candidateStep.name !== subcircuitName
    || candidateStep.subcircuitId !== subcircuit.id
    || candidateStep.usage !== operation
  ) {
    throw new Error(`Synthesizer: ${operation} has an invalid ${subcircuitName} candidate placement`)
  }
  _assertCandidateWireCount(
    operation,
    subcircuitName,
    'input',
    candidateStep.inPts,
    subcircuit.NInWires,
  )
  _assertCandidateWireCount(
    operation,
    subcircuitName,
    'output',
    candidateStep.outPts,
    subcircuit.NOutWires,
  )
  if (subcircuit.logicalInterface === undefined) {
    throw new Error(
      `Synthesizer: ${subcircuitName} has no logical interface for ${operation}`,
    )
  }
  _assertCandidatePortTypes(
    operation,
    subcircuitName,
    'input',
    candidateStep.inPts,
    subcircuit.logicalInterface.inputs,
  )
  _assertCandidatePortTypes(
    operation,
    subcircuitName,
    'output',
    candidateStep.outPts,
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

function _assertStaticCandidateValue(
  operation: Operator,
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

function _assertCandidateEarlierSource(
  operation: Operator,
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
    private readonly subcircuitLibrary: ResolvedSubcircuitLibrary,
    private readonly cachedOpts: SynthesizerOpts,
  ) {
    this.subcircuitInfoByName = subcircuitLibrary.subcircuitInfoByName
    this._bufferSubcircuitByBuffer = subcircuitLibrary.subcircuitBufferMapping
    this._placementCompositionMapping = subcircuitLibrary.placementCompositionMapping
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
    this.addReservedVariableToBufferIn('BYTE_MASK', 0xffn)
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
    for (let i = 1; i <= this.subcircuitLibrary.numberOfPrevBlockHashes; i++) {
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

  public placeComposition(
    operation: Operator,
    operands: CompositionOperands,
  ): readonly DataPt[] {
    const composition = this._placementCompositionMapping[operation]
    const basePlacementIndex = this._placements.length
    let candidate: PlacementCandidate
    switch (composition.placementStrategy) {
      case 'generic':
        candidate = this._buildGenericComposition(operation, operands, basePlacementIndex)
        this._validateGenericCandidate(candidate, composition)
        break
      case 'poseidon':
        candidate = this._buildPoseidonComposition(operands, basePlacementIndex)
        this._validatePoseidonCandidate(candidate, composition)
        break
      case 'memory-view':
        candidate = this._materializeMemoryViewComposition(operands, basePlacementIndex)
        this._validateMemoryViewCandidate(candidate, composition)
        break
    }
    for (const placement of candidate.placements) {
      this._placements.push(placementEntryDeepCopy(placement))
    }
    return candidate.resultPts.map((dataPt) => DataPtFactory.deepCopy(dataPt))
  }

  private _createCandidateStep(
    operation: Operator,
    subcircuitName: SubcircuitNames,
    inPts: readonly DataPt[],
    outPts: readonly DataPt[],
  ): PlacementEntry {
    const subcircuit = this.subcircuitInfoByName.get(subcircuitName)
    if (subcircuit === undefined) {
      throw new Error(`Synthesizer: ${subcircuitName} subcircuit is not found for ${operation}. Check qap-compiler.`)
    }
    return {
      name: subcircuitName,
      usage: operation,
      subcircuitId: subcircuit.id,
      inPts: inPts.slice(),
      outPts: outPts.slice(),
    }
  }

  private _materializeMemoryViewComposition(
    operands: CompositionOperands,
    basePlacementIndex: number,
  ): PlacementCandidate {
    const operation = 'MemoryView'
    if (operands.some((view) => !Array.isArray(view))) {
      throw new Error('Synthesizer: MemoryView requires view-grouped operands')
    }
    const views = operands as readonly (readonly DataPt[])[]
    const composition = this._placementCompositionMapping[operation]
    const step = composition.steps[0]
    if (step === undefined || step.subcircuit !== 'MemoryViewStep') {
      throw new Error('Synthesizer: MemoryView has no MemoryViewStep template')
    }
    const logicalInterface = this.subcircuitInfoByName.get(step.subcircuit)?.logicalInterface
    if (logicalInterface === undefined) {
      throw new Error(`Synthesizer: ${step.subcircuit} logical interface is unavailable`)
    }
    const inputTypes = logicalInterface.inputs.map(({ logicalType }) =>
      getDataPtTypeFromLogicalInterfaceType(logicalType),
    )
    const outputTypes = logicalInterface.outputs.map(({ logicalType }) =>
      getDataPtTypeFromLogicalInterfaceType(logicalType),
    )
    const previousWordType = inputTypes[3]
    const previousOwnershipType = inputTypes[4]
    const nextWordType = outputTypes[0]
    const nextOwnershipType = outputTypes[1]
    if (logicalInterface.inputs.length !== 5 || logicalInterface.outputs.length !== 2
      || previousWordType === undefined || previousOwnershipType === undefined
      || nextWordType === undefined || nextOwnershipType === undefined) {
      throw new Error(`Synthesizer: ${step.subcircuit} logical interface is incomplete`)
    }
    const inputsPerFragment = 3
    const steps: PlacementEntry[] = []
    const resultPts: DataPt[] = []
    for (const [viewIndex, view] of views.entries()) {
      const zeroWordPt = this.loadArbitraryStatic(0n, previousWordType)
      if (view.length === 0) {
        resultPts.push(zeroWordPt)
        continue
      }
      if (view.length % inputsPerFragment !== 0) {
        throw new Error(`Synthesizer: MemoryView view ${viewIndex} must contain three inputs per fragment`)
      }
      const zeroOwnershipPt = this.loadArbitraryStatic(0n, previousOwnershipType)
      let previousWordPt = zeroWordPt
      let previousOwnershipPt = zeroOwnershipPt
      const fragmentCount = view.length / inputsPerFragment
      for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
        const operandOffset = fragmentIndex * inputsPerFragment
        const fragmentPts = view.slice(operandOffset, operandOffset + inputsPerFragment)
        const inPts = [...fragmentPts, previousWordPt, previousOwnershipPt]
        const [nextWordValue, nextOwnershipValue] = this.subcircuitLibrary.calculateSubcircuitOutputValues(
          'MemoryViewStep',
          inPts.map(({ value }) => value),
        )
        if (nextWordValue === undefined || nextOwnershipValue === undefined) {
          throw new Error('Synthesizer: MemoryViewStep did not produce both outputs')
        }
        const placementIndex = basePlacementIndex + steps.length
        const nextWordPt = DataPtFactory.create({
          source: placementIndex,
          wireIndex: 0,
          dataPtType: nextWordType,
        }, nextWordValue)
        const nextOwnershipPt = DataPtFactory.create({
          source: placementIndex,
          wireIndex: 1,
          dataPtType: nextOwnershipType,
        }, nextOwnershipValue)
        steps.push(this._createCandidateStep(
          operation,
          step.subcircuit,
          inPts,
          [nextWordPt, nextOwnershipPt],
        ))
        previousWordPt = nextWordPt
        previousOwnershipPt = nextOwnershipPt
      }
      resultPts.push(previousWordPt)
    }
    return { operation, operands: views, resultPts, placements: steps }
  }

  private _buildGenericComposition(
    operation: Operator,
    compositionOperands: CompositionOperands,
    basePlacementIndex: number,
  ): PlacementCandidate {
    if (isNestedOperands(compositionOperands)) {
      throw new Error(`Synthesizer: ${operation} requires flat operands`)
    }
    const operands = compositionOperands as readonly DataPt[]
    const composition = this._placementCompositionMapping[operation]
    if (composition.placementStrategy !== 'generic' || composition.numSteps === 'dynamic'
      || composition.numOperands === 'dynamic' || composition.numResults === 'dynamic'
      || operands.length !== composition.numOperands) {
      throw new Error(`Synthesizer: ${operation} has an invalid fixed generic composition`)
    }
    const intermediateOutPts: Array<DataPt | undefined> = []
    const resultPts: Array<DataPt | undefined> = Array(composition.numResults)
    const steps: PlacementEntry[] = []
    for (const [stepIndex, step] of composition.steps.entries()) {
      const inPts: DataPt[] = []
      for (const input of step.inputs) {
        switch (input.kind) {
          case 'operand': {
            const operand = operands[input.index]
            if (operand === undefined) {
              throw new Error(`Synthesizer: ${operation} operand ${input.index} is unavailable`)
            }
            inPts.push(operand)
            break
          }
          case 'step-output': {
            const output = intermediateOutPts[input.index]
            if (output === undefined) {
              throw new Error(`Synthesizer: ${operation} intermediate ${input.index} is unavailable`)
            }
            inPts.push(output)
            break
          }
          case 'constant': {
            const constant = composition.constants[input.index]
            if (constant === undefined) {
              throw new Error(`Synthesizer: ${operation} constant ${input.index} is unavailable`)
            }
            inPts.push(this.loadArbitraryStatic(constant.value, constant.dataPtType))
            break
          }
          case 'selector':
            if (typeof step.selector !== 'bigint') {
              throw new Error(`Synthesizer: ${operation} requires a static selector`)
            }
            inPts.push(this.loadArbitraryStatic(
              step.selector,
              UINT32_DATA_PT_TYPE,
              `ALU selector for ${operation} of ${step.subcircuit}`,
            ))
            break
        }
      }
      const logicalInterface = this.subcircuitInfoByName.get(step.subcircuit)?.logicalInterface
      if (logicalInterface === undefined) {
        throw new Error(`Synthesizer: ${step.subcircuit} logical interface is unavailable`)
      }
      const values = this.subcircuitLibrary.calculateSubcircuitOutputValues(
        step.subcircuit,
        inPts.map(({ value }) => value),
      )
      if (values.length !== logicalInterface.outputs.length) {
        throw new Error(`Synthesizer: ${step.subcircuit} produced ${values.length} outputs, but its logical interface declares ${logicalInterface.outputs.length}`)
      }
      const outPts = values.map((value, outputIndex) => DataPtFactory.create({
        source: basePlacementIndex + stepIndex,
        wireIndex: outputIndex,
        dataPtType: getDataPtTypeFromLogicalInterfaceType(
          logicalInterface.outputs[outputIndex]!.logicalType,
        ),
      }, value))
      for (const [outputIndex, output] of step.outputs.entries()) {
        const outPt = outPts[outputIndex]
        if (outPt === undefined) {
          throw new Error(`Synthesizer: ${operation} step ${stepIndex} output ${outputIndex} is unavailable`)
        }
        if (output.kind === 'step-output') intermediateOutPts[output.index] = outPt
        else if (output.kind === 'result') {
          if (output.index === 'dynamic') {
            throw new Error(`Synthesizer: ${operation} generic composition has a dynamic result`)
          }
          resultPts[output.index] = outPt
        }
      }
      steps.push(this._createCandidateStep(operation, step.subcircuit, inPts, outPts))
    }
    if (resultPts.some((resultPt) => resultPt === undefined)) {
      throw new Error(`Synthesizer: ${operation} did not produce every declared result`)
    }
    return { operation, operands, resultPts: resultPts as DataPt[], placements: steps }
  }

  private _buildPoseidonComposition(
    compositionOperands: CompositionOperands,
    basePlacementIndex: number,
  ): PlacementCandidate {
    if (isNestedOperands(compositionOperands)) {
      throw new Error('Synthesizer: Poseidon requires flat operands')
    }
    const operands = compositionOperands as readonly DataPt[]
    const composition = this._placementCompositionMapping.Poseidon
    const step = composition.steps[0]
    if (composition.placementStrategy !== 'poseidon' || composition.numSteps !== 'dynamic'
      || composition.numOperands !== 'dynamic' || composition.numResults !== 1
      || composition.steps.length !== 1 || step === undefined || step.subcircuit !== 'Poseidon'
      || step.selector !== 'dynamic' || step.inputs[0]?.kind !== 'selector') {
      throw new Error('Synthesizer: Poseidon has an invalid placement composition')
    }
    const logicalInterface = this.subcircuitInfoByName.get(step.subcircuit)?.logicalInterface
    const selectorPort = logicalInterface?.inputs[0]
    const valuePort = logicalInterface?.inputs[1]
    const resultPort = logicalInterface?.outputs[0]
    if (logicalInterface === undefined || logicalInterface.inputs.length !== step.inputs.length
      || logicalInterface.outputs.length !== 1 || selectorPort === undefined
      || valuePort === undefined || resultPort === undefined) {
      throw new Error('Synthesizer: Poseidon logical interface is unavailable')
    }
    const inputLimit = step.inputs.length - 1
    if (inputLimit < POSEIDON_INPUTS) {
      throw new Error('Synthesizer: Poseidon input capacity is too small')
    }
    const selectorType = getDataPtTypeFromLogicalInterfaceType(selectorPort.logicalType)
    const valueType = getDataPtTypeFromLogicalInterfaceType(valuePort.logicalType)
    const resultType = getDataPtTypeFromLogicalInterfaceType(resultPort.logicalType)
    const zeroPt = this.loadArbitraryStatic(0n, valueType)
    const steps: PlacementEntry[] = []
    const prepareNormalized = (inputPts: readonly DataPt[]): DataPt => {
      if (inputPts.length < POSEIDON_INPUTS || inputPts.length > inputLimit) {
        throw new Error(`Synthesizer: Poseidon expected between ${POSEIDON_INPUTS} and ${inputLimit} inputs, but got ${inputPts.length}`)
      }
      const finalInPts = [
        this.loadArbitraryStatic(
          1n << BigInt(inputPts.length - POSEIDON_INPUTS),
          selectorType,
          'ALU selector for Poseidon',
        ),
        ...inputPts,
        ...Array.from(
          { length: inputLimit - inputPts.length },
          () => DataPtFactory.deepCopy(zeroPt),
        ),
      ]
      const values = this.subcircuitLibrary.calculateSubcircuitOutputValues(
        'Poseidon',
        finalInPts.map(({ value }) => value),
      )
      if (values.length !== 1) {
        throw new Error(`Synthesizer: Poseidon produced ${values.length} outputs`)
      }
      const outPt = DataPtFactory.create({
        source: basePlacementIndex + steps.length,
        wireIndex: 0,
        dataPtType: resultType,
      }, values[0]!)
      steps.push(this._createCandidateStep('Poseidon', step.subcircuit, finalInPts, [outPt]))
      return outPt
    }
    let chainInputs = operands.slice()
    if (chainInputs.length === 0) {
      chainInputs = [DataPtFactory.deepCopy(zeroPt), DataPtFactory.deepCopy(zeroPt)]
    } else if (chainInputs.length === 1) {
      chainInputs.push(DataPtFactory.deepCopy(zeroPt))
    }
    while (chainInputs.length > inputLimit) {
      chainInputs = [
        prepareNormalized(chainInputs.slice(0, inputLimit)),
        ...chainInputs.slice(inputLimit),
      ]
    }
    const resultPt = prepareNormalized(chainInputs)
    return { operation: 'Poseidon', operands, resultPts: [resultPt], placements: steps }
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

  private _validatePoseidonCandidate(
    candidate: PlacementCandidate,
    composition: PlacementComposition,
  ): void {
    if (isNestedOperands(candidate.operands)) {
      throw new Error('Synthesizer: Poseidon operands must be flat')
    }
    const operands = candidate.operands as readonly DataPt[]
    const step = composition.steps[0]!
    if (candidate.resultPts.length !== 1) {
      throw new Error('Synthesizer: Poseidon must produce exactly one result')
    }
    const subcircuit = this.subcircuitInfoByName.get(step.subcircuit)
    if (subcircuit === undefined) {
      throw new Error('Synthesizer: Poseidon subcircuit is not found. Check qap-compiler.')
    }
    const inputLimit = step.inputs.length - 1

    const basePlacementIndex = this._placements.length
    let chainInputs: Array<DataPt | undefined> = operands.slice()
    if (chainInputs.length === 0) {
      chainInputs = [undefined, undefined]
    } else if (chainInputs.length === 1) {
      chainInputs.push(undefined)
    }

    let stepIndex = 0
    let resultPt: DataPt
    while (chainInputs.length > inputLimit) {
      resultPt = this._validatePoseidonCandidateStep(
        candidate,
        step,
        subcircuit,
        stepIndex,
        chainInputs.slice(0, inputLimit),
        basePlacementIndex,
      )
      chainInputs = [resultPt, ...chainInputs.slice(inputLimit)]
      stepIndex++
    }
    resultPt = this._validatePoseidonCandidateStep(
      candidate,
      step,
      subcircuit,
      stepIndex,
      chainInputs,
      basePlacementIndex,
    )
    stepIndex++
    if (candidate.placements.length !== stepIndex) {
      throw new Error(
        `Synthesizer: Poseidon expected ${stepIndex} placement steps, but got ${candidate.placements.length}`,
      )
    }
    if (!_isSameWire(candidate.resultPts[0]!, resultPt)) {
      throw new Error('Synthesizer: Poseidon result is not connected to its final placement')
    }
  }

  private _validateMemoryViewCandidate(
    candidate: PlacementCandidate,
    composition: PlacementComposition,
  ): void {
    const step = composition.steps[0]!
    const inputsPerFragment = 3
    if (candidate.operation !== 'MemoryView' || candidate.operands.some((view) => !Array.isArray(view))) {
      throw new Error('Synthesizer: MemoryView operands must preserve view boundaries')
    }
    const views = candidate.operands as readonly (readonly DataPt[])[]
    if (candidate.resultPts.length !== views.length) {
      throw new Error(
        `Synthesizer: ${candidate.operation} expected ${views.length} results, but got ${candidate.resultPts.length}`,
      )
    }
    const subcircuit = this.subcircuitInfoByName.get(step.subcircuit)
    if (subcircuit === undefined) {
      throw new Error('Synthesizer: MemoryViewStep subcircuit is not found. Check qap-compiler.')
    }

    const basePlacementIndex = this._placements.length
    let candidateStepIndex = 0
    for (const [viewIndex, view] of views.entries()) {
      const resultPt = candidate.resultPts[viewIndex]!
      if (view.length === 0) {
        _assertStaticCandidateValue(candidate.operation, `view ${viewIndex} zero result`, resultPt, 0n)
        continue
      }
      if (view.length % inputsPerFragment !== 0) {
        throw new Error(`Synthesizer: ${candidate.operation} view ${viewIndex} has invalid operands`)
      }
      const fragmentCount = view.length / inputsPerFragment
      let previousWordPt: DataPt | undefined
      let previousOwnershipPt: DataPt | undefined

      for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
        const candidateStep = candidate.placements[candidateStepIndex]
        if (candidateStep === undefined) {
          throw new Error(`Synthesizer: ${candidate.operation} view ${viewIndex} is missing a step`)
        }
        _assertCandidateStepPorts(
          candidate.operation,
          step.subcircuit,
          candidateStep,
          subcircuit,
        )
        if (
          candidateStep.inPts.length !== step.inputs.length
          || candidateStep.outPts.length !== step.outputs.length
        ) {
          throw new Error(`Synthesizer: ${candidate.operation} step ${candidateStepIndex} has an invalid port count`)
        }

        const operandOffset = fragmentIndex * inputsPerFragment
        for (let inputIndex = 0; inputIndex < inputsPerFragment; inputIndex++) {
          const input = candidateStep.inPts[inputIndex]!
          if (!_isSameWire(input, view[operandOffset + inputIndex]!)) {
            throw new Error(
              `Synthesizer: ${candidate.operation} step ${candidateStepIndex} fragment input ${inputIndex} is not connected to its declared operand`,
            )
          }
          _assertCandidateEarlierSource(
            candidate.operation,
            candidateStepIndex,
            inputIndex,
            input,
            basePlacementIndex,
          )
        }

        const [sourceWordPt, encodedShiftPt, ownershipPt] = candidateStep.inPts
        if (sourceWordPt === undefined || encodedShiftPt === undefined || ownershipPt === undefined) {
          throw new Error(`Synthesizer: ${candidate.operation} step ${candidateStepIndex} is missing fragment inputs`)
        }
        _assertStaticCandidateValue(candidate.operation, `step ${candidateStepIndex} encoded byte shift`, encodedShiftPt, encodedShiftPt.value)
        _assertStaticCandidateValue(candidate.operation, `step ${candidateStepIndex} byte ownership`, ownershipPt, ownershipPt.value)

        const previousWordInput = candidateStep.inPts[3]!
        const previousOwnershipInput = candidateStep.inPts[4]!
        if (fragmentIndex === 0) {
          _assertStaticCandidateValue(candidate.operation, `view ${viewIndex} initial word`, previousWordInput, 0n)
          _assertStaticCandidateValue(candidate.operation, `view ${viewIndex} initial ownership`, previousOwnershipInput, 0n)
        } else if (
          previousWordPt === undefined
          || previousOwnershipPt === undefined
          || !_isSameWire(previousWordInput, previousWordPt)
          || !_isSameWire(previousOwnershipInput, previousOwnershipPt)
        ) {
          throw new Error(`Synthesizer: ${candidate.operation} step ${candidateStepIndex} is not connected to the previous step`)
        }
        const nextWordPt = candidateStep.outPts[0]!
        const nextOwnershipPt = candidateStep.outPts[1]!
        if (
          nextWordPt.source !== basePlacementIndex + candidateStepIndex
          || nextWordPt.wireIndex !== 0
          || nextOwnershipPt.source !== basePlacementIndex + candidateStepIndex
          || nextOwnershipPt.wireIndex !== 1
        ) {
          throw new Error(`Synthesizer: ${candidate.operation} step ${candidateStepIndex} has invalid output sources`)
        }
        previousWordPt = nextWordPt
        previousOwnershipPt = nextOwnershipPt
        candidateStepIndex++
      }

      if (previousWordPt === undefined || !_isSameWire(resultPt, previousWordPt)) {
        throw new Error(`Synthesizer: ${candidate.operation} view ${viewIndex} result is not connected to its final placement`)
      }
    }
    if (candidateStepIndex !== candidate.placements.length) {
      throw new Error(
        `Synthesizer: ${candidate.operation} has ${candidate.placements.length - candidateStepIndex} unexpected steps`,
      )
    }
  }

  private _validatePoseidonCandidateStep(
    candidate: PlacementCandidate,
    step: PlacementComposition['steps'][number],
    subcircuit: SubcircuitInfoByNameEntry,
    stepIndex: number,
    expectedPayload: readonly (DataPt | undefined)[],
    basePlacementIndex: number,
  ): DataPt {
    const candidateStep = candidate.placements[stepIndex]
    if (candidateStep === undefined) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} is unavailable`)
    }
    _assertCandidateStepPorts(
      candidate.operation,
      step.subcircuit,
      candidateStep,
      subcircuit,
    )
    if (
      candidateStep.inPts.length !== step.inputs.length
      || candidateStep.outPts.length !== step.outputs.length
    ) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} has an invalid port count`)
    }
    const selector = candidateStep.inPts[0]!
    const expectedSelector = 1n << BigInt(expectedPayload.length - POSEIDON_INPUTS)
    if (
      selector.source !== BUFFER_LIST.indexOf('EVM_IN')
      || selector.value !== expectedSelector
    ) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} selector is invalid`)
    }

    for (let payloadIndex = 0; payloadIndex < step.inputs.length - 1; payloadIndex++) {
      const input = candidateStep.inPts[payloadIndex + 1]!
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

    const output = candidateStep.outPts[0]!
    if (
      output.source !== basePlacementIndex + stepIndex
      || output.wireIndex !== 0
    ) {
      throw new Error(`Synthesizer: Poseidon step ${stepIndex} has an invalid output source`)
    }
    return output
  }

  private _validateGenericCandidate(
    candidate: PlacementCandidate,
    composition: PlacementComposition,
  ): void {
    if (
      composition.numSteps === 'dynamic'
      || composition.numOperands === 'dynamic'
      || composition.numResults === 'dynamic'
      || isNestedOperands(candidate.operands)
    ) {
      throw new Error(
        `Synthesizer: ${candidate.operation} generic placement requires fixed composition sizes`,
      )
    }
    if (candidate.placements.length !== composition.numSteps) {
      throw new Error(
        `Synthesizer: ${candidate.operation} expected ${composition.numSteps} placement steps, but got ${candidate.placements.length}`,
      )
    }
    if (candidate.operands.length !== composition.numOperands) {
      throw new Error(
        `Synthesizer: ${candidate.operation} expected ${composition.numOperands} operands, but got ${candidate.operands.length}`,
      )
    }
    if (candidate.resultPts.length !== composition.numResults) {
      throw new Error(
        `Synthesizer: ${candidate.operation} expected ${composition.numResults} results, but got ${candidate.resultPts.length}`,
      )
    }

    const basePlacementIndex = this._placements.length
    const intermediateOutPts: Array<DataPt | undefined> = []
    const resultOutPts: Array<DataPt | undefined> = Array(composition.numResults)

    for (const [stepIndex, step] of composition.steps.entries()) {
      const candidateStep = candidate.placements[stepIndex]!
      const subcircuit = this.subcircuitInfoByName.get(step.subcircuit)
      if (subcircuit === undefined) {
        throw new Error(
          `Synthesizer: ${step.subcircuit} subcircuit is not found for ${candidate.operation}. Check qap-compiler.`,
        )
      }
      _assertCandidateStepPorts(
        candidate.operation,
        step.subcircuit,
        candidateStep,
        subcircuit,
      )
      if (candidateStep.inPts.length !== step.inputs.length) {
        throw new Error(
          `Synthesizer: ${candidate.operation} step ${stepIndex} expected ${step.inputs.length} inputs, but got ${candidateStep.inPts.length}`,
        )
      }
      if (candidateStep.outPts.length !== step.outputs.length) {
        throw new Error(
          `Synthesizer: ${candidate.operation} step ${stepIndex} expected ${step.outputs.length} outputs, but got ${candidateStep.outPts.length}`,
        )
      }

      for (const [inputIndex, input] of step.inputs.entries()) {
        _assertCandidateInput(
          candidate,
          stepIndex,
          inputIndex,
          input,
          candidateStep.inPts[inputIndex]!,
          composition,
          intermediateOutPts,
          basePlacementIndex,
        )
      }

      for (const [outputIndex, output] of step.outputs.entries()) {
        const candidateOutput = candidateStep.outPts[outputIndex]!
        if (
          candidateOutput.source !== basePlacementIndex + stepIndex
          || candidateOutput.wireIndex !== outputIndex
        ) {
          throw new Error(
            `Synthesizer: ${candidate.operation} step ${stepIndex} output ${outputIndex} has an invalid placement source`,
          )
        }
        if (output.kind === 'step-output') {
          intermediateOutPts[output.index] = candidateOutput
        } else if (output.kind === 'result') {
          if (output.index === 'dynamic') {
            throw new Error(`Synthesizer: ${candidate.operation} generic result cannot be dynamic`)
          }
          resultOutPts[output.index] = candidateOutput
        }
      }
    }

    for (const [resultIndex, resultPt] of candidate.resultPts.entries()) {
      const producedResult = resultOutPts[resultIndex]
      if (producedResult === undefined || !_isSameWire(resultPt, producedResult)) {
        throw new Error(
          `Synthesizer: ${candidate.operation} result ${resultIndex} is not connected to its declared producer`,
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
