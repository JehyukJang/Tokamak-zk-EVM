import { createVM, runTx, RunTxOpts, RunTxResult, VM, VMOpts } from '@ethereumjs/vm';

import { BlockData, BlockOptions, createBlock, HeaderData } from '@ethereumjs/block';
import { bigIntToBytes, bigIntToHex, bytesToHex, createAddressFromBigInt, setLengthLeft } from '@ethereumjs/util';

import { EVMResult, InterpreterStep } from '@ethereumjs/evm';
import { DataAliasGeometries, DataPt, DataPtType, getDataPtTypeFromLogicalInterfaceType, Placements, PreparedComposition, ReservedVariable, SynthesizerInterface, SynthesizerOpts, SynthesizerStepLogEntry, UINT32_DATA_PT_TYPE } from './types/index.ts';
import { BufferManager, InstructionHandler, StateManager } from './handlers/index.ts';
import { ReservedBuffer, type CompositionSubcircuit, type Operator } from '../subcircuit/configuredTypes.ts';
import type { ResolvedSubcircuitLibrary } from '../subcircuit/libraryTypes.ts';
import { DataPtFactory } from './dataStructure/dataPt.ts';
import { TypedTransaction } from '@ethereumjs/tx';
import { POSEIDON_INPUTS } from 'tokamak-l2js';

/**
 * The Synthesizer class manages data related to subcircuits.
 * It acts as a facade, delegating tasks to various handler classes.
 */
export class Synthesizer implements SynthesizerInterface
{
  private _state: StateManager
  protected _bufferManager: BufferManager
  protected _instructionHandlers: InstructionHandler
  private readonly _cachedOpts: SynthesizerOpts
  public readonly subcircuitLibrary: ResolvedSubcircuitLibrary
  private _eventHandlerError: unknown
  private _hasEventHandlerError: boolean
  private _stepLogs: SynthesizerStepLogEntry[]

  constructor(opts: SynthesizerOpts, subcircuitLibrary: ResolvedSubcircuitLibrary) {
    this._cachedOpts = opts
    this.subcircuitLibrary = subcircuitLibrary
    this._state = new StateManager(this)
    this._bufferManager = new BufferManager(this, this._state, this._cachedOpts)
    this._instructionHandlers = new InstructionHandler(this, this._state, this._cachedOpts)
    this._eventHandlerError = undefined
    this._hasEventHandlerError = false
    this._stepLogs = []
  }

  private _recordEventHandlerError(handlerName: string, err: unknown): void {
    if (!this._hasEventHandlerError) {
      this._eventHandlerError = err
      this._hasEventHandlerError = true
    }
    console.error(`Synthesizer: ${handlerName} error:`, err)
  }

  private _attachSynthesizerToVM(vm: VM): void {
    if (vm.evm.events === undefined ) {
      throw new Error("EVM event emitter is turned off.")
    }
    vm.events.on('beforeTx', (_data: TypedTransaction, resolve?: (result?: any) => void) => {
      ; (async () => {
        try {
          if (!this._hasEventHandlerError) {
            await this._prepareSynthesizeTransaction()
            // TODO: BLOCKHASH preparation in state manager for EIP-7709
          }
        } catch (err) {
          this._recordEventHandlerError('beforeTx', err)
        } finally {
          resolve?.()
        }
      })()
    });
    vm.evm.events.on('beforeMessage', (data, resolve?: (result?: any) => void) => {
      try {
        if (!this._hasEventHandlerError) {
          this._instructionHandlers.initializeMessageContext(data);
        }
      } catch (err) {
        this._recordEventHandlerError('beforeMessage', err)
      } finally {
        resolve?.()
      }
    });
    vm.evm.events!.on('step', (data: InterpreterStep, resolve?: (result?: any) => void) => {
      ; (async () => {
        try {
          if (!this._hasEventHandlerError) {
            await this._applySynthesizerHandler(data);
          }
        } catch (err) {
          this._recordEventHandlerError('step', err)
        } finally {
          resolve?.()
        }
      }) () 
    })
    vm.evm.events.on('afterMessage', (data: EVMResult, resolve?: (result?: any) => void) => {
      ; (async () => {
        try {
          if (this._hasEventHandlerError) {
            return
          }
          const _runState = data.execResult.runState
          if (_runState === undefined) {
            throw new Error('Failed to capture the final state')
          }
          const _interpreter = _runState.interpreter
          const opcodeInfo = _interpreter.lookupOpInfo(_runState.opCode).opcodeInfo
          const memorySize = 8192n
          let error = undefined
          if (opcodeInfo.code === 0xfd) {
            error = data.execResult.returnValue
          }
          const stepData: InterpreterStep = {
            pc: _runState.programCounter,
            gasLeft: _interpreter.getGasLeft(),
            gasRefund: _runState.gasRefund,
            opcode: {
              name: opcodeInfo.fullName,
              fee: opcodeInfo.fee,
              dynamicFee: undefined,
              isAsync: opcodeInfo.isAsync,
              code: opcodeInfo.code,
            },
            stack: _runState.stack.getStack().slice(),
            depth: _interpreter._env.depth,
            address: _interpreter._env.address,
            account: _interpreter._env.contract,
            memory: _runState.memory._store.subarray(0, Number(memorySize) * 32),
            memoryWordCount: memorySize,
            codeAddress: _interpreter._env.codeAddress,
            stateManager: _runState.stateManager,
            eofSection: _interpreter._env.eof?.container.header.getSectionFromProgramCounter(
              _runState.programCounter,
            ),
            immediate: undefined,
            error,
            eofFunctionDepth:
              _interpreter._env.eof !== undefined ? _interpreter._env.eof?.eofRunState.returnStack.length + 1 : undefined,
          }
          await this._applySynthesizerHandler(stepData);
          this._returnMessageCall(stepData.depth);
          this._state.completeFrame(
            stepData.depth,
            data.execResult.exceptionError === undefined,
          )
        } catch (err) {
          this._recordEventHandlerError('afterMessage', err)
        } finally {
          resolve?.()
        }
      })()
    })

  }

  private async _prepareSynthesizeTransaction(): Promise<void> {
    this._state.resetTransactionTracking()
  }

  private _finalizeStorageStore(): void {
    for (const entry of this._state.storageCache.dirtyEntries) {
      this.addReservedVariableToBufferOut('SSTORE_ADDRESS', entry.canonicalAddressPt, true)
      this.addReservedVariableToBufferOut('SSTORE_KEY', entry.canonicalKeyPt, true)
      this.addReservedVariableToBufferOut('SSTORE_VALUE', entry.latestValuePt, true)
    }
  }

  private _returnMessageCall(depth: number):void {
    if (depth > 0){
      const parentContext = this._state.contextByDepth[depth - 1]
      const childContext = this._state.contextByDepth[depth]
      if (parentContext === undefined || childContext === undefined) {
        throw new Error('Synthesizer: message return context is unavailable')
      }
      parentContext.returnDataMemoryPts = childContext.resultMemoryPts.map(entry => {
        return {
          ...entry,
          dataPt: DataPtFactory.deepCopy(entry.dataPt),
        }
      });
      parentContext.returnDataByteLength = childContext.resultDataByteLength
    }
  }

  public async synthesizeTX(): Promise<RunTxResult> {
    const common = this._cachedOpts.stateManager.common;
    this._eventHandlerError = undefined
    this._hasEventHandlerError = false
    this._stepLogs = []

    const headerData: HeaderData = {
      parentHash: setLengthLeft(
        bigIntToBytes(this.getReservedVariableFromBuffer('BLOCKHASH_1').value),
        32,
      ),
      coinbase: createAddressFromBigInt(this.getReservedVariableFromBuffer('COINBASE').value),
      // difficulty = 0 for PoS blocks
      difficulty: 0n,
      number: this.getReservedVariableFromBuffer('NUMBER').value,
      gasLimit: this.getReservedVariableFromBuffer('GASLIMIT').value,
      timestamp: this.getReservedVariableFromBuffer('TIMESTAMP').value,

      baseFeePerGas: undefined,
    };
    
    const vmOpts: VMOpts = {
      common,
      stateManager: this._cachedOpts.stateManager,
      profilerOpts: {reportAfterTx: true},
    };
    const vm = await createVM(vmOpts);
    this._attachSynthesizerToVM(vm);

    const blockData: BlockData = {
      header: headerData,
    };
    const blockOpts: BlockOptions = {
      common,
      skipConsensusFormatValidation: true,
    };
    const block = createBlock(blockData, blockOpts);
    const runTxOpts: RunTxOpts = {
      block,
      tx: this._cachedOpts.signedTransaction,
      skipBalance: true,
      skipBlockGasLimitValidation: true,
      skipHardForkValidation: true,
      reportPreimages: true,
    };
    let result: RunTxResult
    try {
      result = await runTx(vm, runTxOpts)
    } catch (err) {
      if (this._hasEventHandlerError) {
        throw this._eventHandlerError
      }
      throw err
    }
    if (this._hasEventHandlerError) {
      throw this._eventHandlerError
    }
    if (result.execResult.exceptionError !== undefined) {
      throw result.execResult.exceptionError
    }
    this._finalizeStorageStore()
    return result
  }

  private _applySynthesizerHandler = async (data: InterpreterStep): Promise<void> => {
    const stepResult: InterpreterStep = {
      ...data,
      stack: data.stack.slice().reverse(),
    }
    const thisContext = this._state.contextByDepth[stepResult.depth];
    if (thisContext === undefined ) {
      throw new Error('Debug: The current context is not initialized')
    }
    const prevStepResult = thisContext.prevInterpreterStep;
    if ( prevStepResult !== null) {
      const opcode = prevStepResult.opcode
      const opHandler = this._instructionHandlers.synthesizerHandlers.get(opcode.code)
      if (opHandler === undefined) {
        throw new Error(`Undefined synthesizer handler for opcode ${opcode.name}`)
      }

      const stepLog: SynthesizerStepLogEntry = {
        stack: prevStepResult.stack.map(x => bigIntToHex(x)),
        pc: prevStepResult.pc,
        opcode: opcode.name,
      }
      if (opcode.name === 'KECCAK256') {
        const offset = prevStepResult.stack[0]
        const size = prevStepResult.stack[1]
        if (offset !== undefined && size !== undefined) {
          const start = Number(offset)
          const end = start + Number(size)
          const inputBytes = prevStepResult.memory.subarray(start, end)
          const chunks: string[] = []
          for (let i = 0; i < inputBytes.length; i += 32) {
            chunks.push(bytesToHex(inputBytes.subarray(i, i + 32)))
          }
          stepLog.keccak256Input = chunks
        }
      }
      this._stepLogs.push(stepLog)

      await opHandler.apply(null, [thisContext, stepResult])
    }
    thisContext.prevInterpreterStep = {
      ...stepResult,
      stack: stepResult.stack.slice(),
    }
  }

  public get stepLogs(): SynthesizerStepLogEntry[] {
    return this._stepLogs
  }

  public get messageCodeAddresses(): readonly string[] {
    return this._state.messageCodeAddresses
  }

  public get placements(): Placements {
    return this._state.placements
  }

  placeBuffer(buffer: ReservedBuffer, inPts: DataPt[], outPts: DataPt[], usage: string): void {
    this._state.placeBuffer(buffer, inPts, outPts, usage)
  }

  placeComposition(preparedComposition: PreparedComposition): void {
    this._state.placeComposition(preparedComposition)
  }

  calculateSubcircuitOutputValues(
    name: CompositionSubcircuit,
    values: bigint[],
  ): bigint[] {
    return this.subcircuitLibrary.calculateSubcircuitOutputValues(name, values)
  }

  getReservedVariableFromBuffer(
    varName: ReservedVariable
  ): DataPt {
    return this._bufferManager.getReservedVariableFromBuffer(varName)
  }

  appendBufferWirePair(inPt: DataPt, outPt: DataPt, dynamic: boolean): DataPt {
    return this._state.appendBufferWirePair(inPt, outPt, dynamic)
  }

  addReservedVariableToBufferIn(varName: ReservedVariable, value?: bigint, dynamic?: boolean, message?: string): DataPt {
    return this._bufferManager.addReservedVariableToBufferIn(varName, value, dynamic, message)
  }
  addReservedVariableToBufferOut(varName: ReservedVariable, symbolDataPt: DataPt, dynamic?: boolean, message?: string): DataPt {
    return this._bufferManager.addReservedVariableToBufferOut(varName, symbolDataPt, dynamic, message)
  }

  loadArbitraryStatic(
    value: bigint,
    dataPtType: DataPtType,
    desc?: string,
  ): DataPt {
    return this._bufferManager.loadArbitraryStatic(value, dataPtType, desc)
  }

  prepareMemoryLoadViewComposition(
    dataAliasGeometries: DataAliasGeometries,
    viewByteLength: number,
    basePlacementIndex: number,
  ): PreparedComposition {
    if (!Number.isInteger(viewByteLength) || viewByteLength < 1 || viewByteLength > 32) {
      throw new Error(`Synthesizer: MemoryLoad has an invalid view byte length ${viewByteLength}`)
    }
    if (dataAliasGeometries.length === 0) {
      throw new Error('Synthesizer: MemoryLoad requires at least one alias geometry')
    }
    const composition = this.subcircuitLibrary.placementCompositionManager.get('MemoryLoad')
    const step = composition.steps[0]
    if (step === undefined) {
      throw new Error('Synthesizer: MemoryLoad composition has no placement step')
    }
    const logicalInterface = this.subcircuitLibrary.subcircuitInfoByName
      .get(step.subcircuit)?.logicalInterface
    if (logicalInterface === undefined) {
      throw new Error(`Synthesizer: ${step.subcircuit} logical interface is unavailable`)
    }
    const inputTypes = logicalInterface.inputs.map(({ logicalType }) =>
      getDataPtTypeFromLogicalInterfaceType(logicalType),
    )
    const outputTypes = logicalInterface.outputs.map(({ logicalType }) =>
      getDataPtTypeFromLogicalInterfaceType(logicalType),
    )
    const [, shiftType, directionType, ownershipType, previousWordType,
      previousOwnershipType, coverageType, finalModeType] = inputTypes
    const [nextWordType, nextOwnershipType] = outputTypes
    if (shiftType === undefined || directionType === undefined || ownershipType === undefined
      || previousWordType === undefined || previousOwnershipType === undefined
      || coverageType === undefined || finalModeType === undefined
      || nextWordType === undefined || nextOwnershipType === undefined) {
      throw new Error(`Synthesizer: ${step.subcircuit} logical interface is incomplete`)
    }
    const dataAliasInfos = dataAliasGeometries.map((geometry) => Object.freeze({
      dataPt: geometry.dataPt,
      shiftPt: this.loadArbitraryStatic(BigInt(geometry.shiftMagnitude), shiftType, 'Memory-load byte shift magnitude'),
      directionPt: this.loadArbitraryStatic(BigInt(geometry.direction), directionType, 'Memory-load shift direction'),
      maskerPt: this.loadArbitraryStatic(geometry.ownershipMask, ownershipType, 'Memory-load byte ownership mask'),
    }))
    const expectedCoveragePt = this.loadArbitraryStatic(
      dataAliasInfos.reduce((coverage, { maskerPt }) => coverage | maskerPt.value, 0n),
      coverageType,
      'Memory-load final byte ownership',
    )
    const zeroWordPt = this.loadArbitraryStatic(0n, previousWordType, 'Memory-load initial word')
    const zeroOwnershipPt = this.loadArbitraryStatic(0n, previousOwnershipType, 'Memory-load initial byte ownership')
    const operands: DataPt[] = []
    const steps: PreparedComposition['steps'][number][] = []
    let previousWordPt = zeroWordPt
    let previousOwnershipPt = zeroOwnershipPt
    for (const [stepIndex, info] of dataAliasInfos.entries()) {
      const finalModePt = this.loadArbitraryStatic(
        stepIndex === dataAliasInfos.length - 1 ? 1n : 0n,
        finalModeType,
        'Memory-load final-mode flag',
      )
      const inPts = [info.dataPt, info.shiftPt, info.directionPt, info.maskerPt,
        previousWordPt, previousOwnershipPt, expectedCoveragePt, finalModePt]
      const [nextWordValue, nextOwnershipValue] = this.calculateSubcircuitOutputValues(
        'MemoryLoadStep', inPts.map(({ value }) => value),
      )
      if (nextWordValue === undefined || nextOwnershipValue === undefined) {
        throw new Error('Synthesizer: MemoryLoadStep did not produce both outputs')
      }
      const nextWordPt = DataPtFactory.create({
        source: basePlacementIndex + stepIndex, wireIndex: 0, dataPtType: nextWordType,
      }, nextWordValue)
      const nextOwnershipPt = DataPtFactory.create({
        source: basePlacementIndex + stepIndex, wireIndex: 1, dataPtType: nextOwnershipType,
      }, nextOwnershipValue)
      steps.push({ inPts, outPts: [nextWordPt, nextOwnershipPt] })
      operands.push(info.dataPt, info.shiftPt, info.directionPt, info.maskerPt)
      previousWordPt = nextWordPt
      previousOwnershipPt = nextOwnershipPt
    }
    operands.push(expectedCoveragePt)
    return { operation: 'MemoryLoad', operands, resultPts: [previousWordPt], steps }
  }

  prepareFixedGenericComposition(
    operation: Operator,
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition {
    const composition = this.subcircuitLibrary.placementCompositionManager.get(operation)
    if (composition.placementStrategy !== 'generic' || composition.numSteps === 'dynamic'
      || composition.numOperands === 'dynamic' || operands.length !== composition.numOperands) {
      throw new Error(`Synthesizer: ${operation} has an invalid fixed generic composition`)
    }
    const intermediateOutPts: Array<DataPt | undefined> = []
    const resultPts: Array<DataPt | undefined> = Array(composition.numResults)
    const steps: Array<PreparedComposition['steps'][number]> = []
    for (const [stepIndex, step] of composition.steps.entries()) {
      const inPts: DataPt[] = []
      for (const input of step.inputs) {
        switch (input.kind) {
          case 'operand': {
            const operand = operands[input.index]
            if (operand === undefined) throw new Error(`Synthesizer: ${operation} operand ${input.index} is unavailable`)
            inPts.push(operand)
            break
          }
          case 'step-output': {
            const output = intermediateOutPts[input.index]
            if (output === undefined) throw new Error(`Synthesizer: ${operation} intermediate ${input.index} is unavailable`)
            inPts.push(output)
            break
          }
          case 'constant': {
            const constant = composition.constants[input.index]
            if (constant === undefined) throw new Error(`Synthesizer: ${operation} constant ${input.index} is unavailable`)
            inPts.push(this.loadArbitraryStatic(constant.value, constant.dataPtType))
            break
          }
          case 'selector':
            if (typeof step.selector !== 'bigint') throw new Error(`Synthesizer: ${operation} requires a static selector`)
            inPts.push(this.loadArbitraryStatic(step.selector, UINT32_DATA_PT_TYPE,
              `ALU selector for ${operation} of ${step.subcircuit}`))
            break
        }
      }
      const logicalInterface = this.subcircuitLibrary.subcircuitInfoByName
        .get(step.subcircuit)?.logicalInterface
      if (logicalInterface === undefined) throw new Error(`Synthesizer: ${step.subcircuit} logical interface is unavailable`)
      const values = this.calculateSubcircuitOutputValues(
        step.subcircuit, inPts.map(({ value }) => value),
      )
      if (values.length !== logicalInterface.outputs.length) {
        throw new Error(`Synthesizer: ${step.subcircuit} produced ${values.length} outputs, but its logical interface declares ${logicalInterface.outputs.length}`)
      }
      const outPts = values.map((value, outputIndex) => DataPtFactory.create({
        source: basePlacementIndex + stepIndex,
        wireIndex: outputIndex,
        dataPtType: getDataPtTypeFromLogicalInterfaceType(logicalInterface.outputs[outputIndex]!.logicalType),
      }, value))
      for (const [outputIndex, output] of step.outputs.entries()) {
        const outPt = outPts[outputIndex]
        if (outPt === undefined) throw new Error(`Synthesizer: ${operation} step ${stepIndex} output ${outputIndex} is unavailable`)
        if (output.kind === 'step-output') intermediateOutPts[output.index] = outPt
        else if (output.kind === 'result') resultPts[output.index] = outPt
      }
      steps.push({ inPts, outPts })
    }
    if (resultPts.some((resultPt) => resultPt === undefined)) {
      throw new Error(`Synthesizer: ${operation} did not produce every declared result`)
    }
    return { operation, operands, resultPts: resultPts as DataPt[], steps }
  }

  preparePoseidonComposition(
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition {
    const composition = this.subcircuitLibrary.placementCompositionManager.get('Poseidon')
    const step = composition.steps[0]
    if (composition.placementStrategy !== 'poseidon' || composition.numSteps !== 'dynamic'
      || composition.numOperands !== 'dynamic' || composition.numResults !== 1
      || composition.steps.length !== 1 || step === undefined || step.subcircuit !== 'Poseidon'
      || step.selector !== 'dynamic' || step.inputs[0]?.kind !== 'selector') {
      throw new Error('Synthesizer: Poseidon has an invalid placement composition')
    }
    const logicalInterface = this.subcircuitLibrary.subcircuitInfoByName.get(step.subcircuit)?.logicalInterface
    const selectorPort = logicalInterface?.inputs[0]
    const valuePort = logicalInterface?.inputs[1]
    const resultPort = logicalInterface?.outputs[0]
    if (logicalInterface === undefined || logicalInterface.inputs.length !== step.inputs.length
      || logicalInterface.outputs.length !== 1 || selectorPort === undefined
      || valuePort === undefined || resultPort === undefined) {
      throw new Error('Synthesizer: Poseidon logical interface is unavailable')
    }
    const inputLimit = step.inputs.length - 1
    if (inputLimit < POSEIDON_INPUTS) throw new Error('Synthesizer: Poseidon input capacity is too small')
    const selectorType = getDataPtTypeFromLogicalInterfaceType(selectorPort.logicalType)
    const valueType = getDataPtTypeFromLogicalInterfaceType(valuePort.logicalType)
    const resultType = getDataPtTypeFromLogicalInterfaceType(resultPort.logicalType)
    const zeroPt = this.loadArbitraryStatic(0n, valueType)
    const steps: Array<PreparedComposition['steps'][number]> = []
    const prepareNormalized = (inputPts: DataPt[]): DataPt => {
      if (inputPts.length < POSEIDON_INPUTS || inputPts.length > inputLimit) {
        throw new Error(`Synthesizer: Poseidon expected between ${POSEIDON_INPUTS} and ${inputLimit} inputs, but got ${inputPts.length}`)
      }
      const finalInPts = [
        this.loadArbitraryStatic(1n << BigInt(inputPts.length - POSEIDON_INPUTS), selectorType, 'ALU selector for Poseidon'),
        ...inputPts,
        ...Array.from({ length: inputLimit - inputPts.length }, () => DataPtFactory.deepCopy(zeroPt)),
      ]
      const values = this.calculateSubcircuitOutputValues('Poseidon', finalInPts.map(({ value }) => value))
      if (values.length !== 1) throw new Error(`Synthesizer: Poseidon produced ${values.length} outputs`)
      const outPt = DataPtFactory.create({
        source: basePlacementIndex + steps.length, wireIndex: 0, dataPtType: resultType,
      }, values[0]!)
      steps.push({ inPts: finalInPts, outPts: [outPt] })
      return outPt
    }
    let chainInputs = operands.slice()
    if (chainInputs.length === 0) chainInputs = [DataPtFactory.deepCopy(zeroPt), DataPtFactory.deepCopy(zeroPt)]
    else if (chainInputs.length === 1) chainInputs.push(DataPtFactory.deepCopy(zeroPt))
    while (chainInputs.length > inputLimit) {
      chainInputs = [prepareNormalized(chainInputs.slice(0, inputLimit)), ...chainInputs.slice(inputLimit)]
    }
    const resultPt = prepareNormalized(chainInputs)
    return { operation: 'Poseidon', operands, resultPts: [resultPt], steps }
  }

}
