import { DataPtFactory } from '../../synthesizer/dataStructure/dataPt.ts';
import {
  ISynthesizerProvider,
  MemoryPts,
  type DataPt,
  type PlacementEntry,
  type Placements,
  type PreparedComposition,
} from '../types/index.ts';
import {
  getDataPtTypeFromLogicalInterfaceType,
  getDataPtWireCount,
} from '../types/dataStructure.ts';
import { MemoryPt, StackPt } from '../dataStructure/index.ts';
import {
  BUFFER_LIST,
  ReservedBuffer,
  SubcircuitInfoByName,
  SubcircuitInfoByNameEntry,
  SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import type {
  PlacementComposition,
  PlacementCompositionManager,
} from '../../subcircuit/placementCompositionManager.ts';
import type { LogicalInterfacePort } from '../../subcircuit/libraryTypes.ts';
import { InterpreterStep } from '@ethereumjs/evm';
import { POSEIDON_INPUTS } from 'tokamak-l2js';
import { LogCache } from './logAccess.ts';
import { InitialStorageReadList, StorageCache } from './storageAccess.ts';

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

export type ContextConstructionData = {
  callerPt: DataPt;
  codeAddressPt: DataPt;
  storageAddressPt: DataPt;
  callDataMemoryPts: MemoryPts;
}

export class ContextManager {
  public stackPt: StackPt;
  public memoryPt: MemoryPt;
  public callerPt: DataPt;
  public codeAddressPt: DataPt;
  public storageAddressPt: DataPt;
  public returnDataMemoryPts: MemoryPts;
  public callDataMemoryPts: MemoryPts;
  public prevInterpreterStep: InterpreterStep | null;
  public resultMemoryPts: MemoryPts;

  constructor(data: ContextConstructionData) {
    this.stackPt = new StackPt();
    this.memoryPt = new MemoryPt();
    this.callerPt = data.callerPt;
    this.codeAddressPt = data.codeAddressPt;
    this.storageAddressPt = data.storageAddressPt;
    this.callDataMemoryPts = data.callDataMemoryPts;
    this.returnDataMemoryPts = [];
    this.prevInterpreterStep = null;
    this.resultMemoryPts = [];
  }
}

/**
 * Manages the state of the synthesizer, including placements, auxin, and subcircuit information.
 */
export class StateManager {
  private _placements: Placements = []
  public readonly logCache = new LogCache(this._placements)
  public readonly storageCache = new StorageCache()
  public readonly initialStorageReads = new InitialStorageReadList()

  public subcircuitInfoByName: SubcircuitInfoByName;
  private readonly _bufferSubcircuitByBuffer: Record<ReservedBuffer, SubcircuitInfoByNameEntry | undefined>;
  private readonly _placementCompositionManager: PlacementCompositionManager;
  public cachedEVMIn: Map<bigint, Map<string, DataPt>> = new Map()
  public cachedOrigin: DataPt | undefined = undefined

  public contextByDepth: ContextManager[] = [];

  constructor(parent: ISynthesizerProvider) {
    this.subcircuitInfoByName = parent.subcircuitLibrary.subcircuitInfoByName
    this._bufferSubcircuitByBuffer = parent.subcircuitLibrary.subcircuitBufferMapping
    this._placementCompositionManager = parent.subcircuitLibrary.placementCompositionManager
  }

  public get placements(): Placements {
    // placements are protected and can be manipulated only by this._place and this.addWirePairToBufferIn
    return placementsDeepCopy(this._placements)
  }

  public resetTransactionTracking(): void {
    this.storageCache.reset()
    this.initialStorageReads.reset()
    this.logCache.reset()
    this.cachedOrigin = undefined
  }

  public beginFrame(depth: number): void {
    this.storageCache.beginFrame(depth)
    this.logCache.beginFrame(depth)
  }

  public completeFrame(depth: number, succeeded: boolean): void {
    this.logCache.completeFrame(depth, succeeded)
    this.storageCache.completeFrame(depth, succeeded)
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

  public placeBuffer(
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
    const composition = this._placementCompositionManager.get(preparedComposition.operation)
    if (composition.placementStrategy === 'generic') {
      this._validatePreparedGenericComposition(preparedComposition, composition)
      for (const [stepIndex, step] of composition.steps.entries()) {
        const preparedStep = preparedComposition.steps[stepIndex]!
        this._place(
          step.subcircuit,
          preparedStep.inPts.slice(),
          preparedStep.outPts.slice(),
          step.usage,
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
          step.usage,
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
          step.usage,
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

  public addWirePairToBufferIn(inPt: DataPt, outPt: DataPt, dynamic: boolean): DataPt {
    const thisPlacementId = outPt.source
    if (dynamic) {
      if (
        // double confirmation
        this._placements[thisPlacementId]!.inPts.length !== this._placements[thisPlacementId]!.outPts.length
        || this._placements[thisPlacementId]!.outPts.length !== outPt.wireIndex
      ) {
        throw new Error(
          `Synthesizer: Mismatch in the buffer wires (placement id: ${thisPlacementId})`
        );
      }
      // Add input-output pair to the input buffer subcircuit
      this._placements[thisPlacementId]!.inPts.push(inPt);
      this._placements[thisPlacementId]!.outPts.push(outPt);
    } else {
      this._placements[thisPlacementId]!.inPts[inPt.wireIndex] = inPt
      this._placements[thisPlacementId]!.outPts[outPt.wireIndex] = outPt
    }
    
    return DataPtFactory.deepCopy(outPt)
  }
}
