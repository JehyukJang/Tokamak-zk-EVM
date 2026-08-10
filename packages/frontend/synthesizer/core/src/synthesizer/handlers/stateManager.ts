import { DataPtFactory } from '../../synthesizer/dataStructure/dataPt.ts';
import {
  ISynthesizerProvider,
  MemoryPts,
  type DataPt,
  type PlacementEntry,
  type Placements,
  type PreparedComposition,
} from '../types/index.ts';
import { MemoryPt, StackPt } from '../dataStructure/index.ts';
import {
  BUFFER_LIST,
  Operator,
  ReservedBuffer,
  SubcircuitInfoByName,
  SubcircuitInfoByNameEntry,
  SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import type {
  PlacementComposition,
  PlacementCompositionManager,
} from '../../subcircuit/placementCompositionManager.ts';
import { InterpreterStep } from '@ethereumjs/evm';
import { LogCache } from './logAccess.ts';
import { InitialStorageReadList, StorageCache } from './storageAccess.ts';

type CompositionProducer = (name: Operator, inPts: DataPt[]) => DataPt[];

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
    (count, { dataPtType: { wireLayout } }) =>
      count + (wireLayout.kind === 'native-fr' ? 1 : wireLayout.count),
    0,
  )
  if (actualWireCount !== expectedWireCount) {
    throw new Error(
      `Synthesizer: ${operation} ${subcircuit} expected ${expectedWireCount} ${target} wires, but got ${actualWireCount}`,
    )
  }
}

function _isSameWire(left: DataPt, right: DataPt): boolean {
  return left.source === right.source && left.wireIndex === right.wireIndex
}

function _hasSameDataPtType(
  dataPt: DataPt,
  expectedType: DataPt['dataPtType'],
): boolean {
  const { valueDomain, wireLayout } = dataPt.dataPtType
  return (
    valueDomain.kind === expectedType.valueDomain.kind
    && (valueDomain.kind !== 'uint' || (
      expectedType.valueDomain.kind === 'uint'
      && valueDomain.bits === expectedType.valueDomain.bits
    ))
    && wireLayout.kind === expectedType.wireLayout.kind
    && (wireLayout.kind !== 'limbs-128' || (
      expectedType.wireLayout.kind === 'limbs-128'
      && wireLayout.count === expectedType.wireLayout.count
    ))
  )
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
  private readonly _compositionProducerByOperator = new Map<Operator, CompositionProducer>();

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

  public registerCompositionProducer(
    operators: readonly Operator[],
    producer: CompositionProducer,
  ): void {
    for (const operator of operators) {
      if (this._compositionProducerByOperator.has(operator)) {
        throw new Error(`Synthesizer: ${operator} composition producer is already registered`)
      }
      this._compositionProducerByOperator.set(operator, producer)
    }
  }

  public placeComposition(name: Operator, inPts: DataPt[]): DataPt[] {
    const producer = this._compositionProducerByOperator.get(name)
    if (producer === undefined) {
      throw new Error(`Synthesizer: ${name} composition producer is not implemented`)
    }
    return producer(name, inPts)
  }

  private _placePreparedComposition(preparedComposition: PreparedComposition): void {
    const composition = this._placementCompositionManager.get(preparedComposition.operation)
    if (composition.placementStrategy !== 'generic') {
      throw new Error(
        `Synthesizer: ${preparedComposition.operation} requires ${composition.placementStrategy} placement preparation`,
      )
    }

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
      _assertPreparedWireCount(
        preparedComposition.operation,
        step.subcircuit,
        'input',
        preparedStep.inPts,
        subcircuit.NInWires,
      )
      _assertPreparedWireCount(
        preparedComposition.operation,
        step.subcircuit,
        'output',
        preparedStep.outPts,
        subcircuit.NOutWires,
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
