
import { BIT_DATA_PT_TYPE, DataAliasGeometries, DataAliasInfos, getDataPtTypeFromLogicalInterfaceType, ISynthesizerProvider, MemoryPts, PreparedComposition, synthesizerOpcodeByName, SynthesizerOpts, SynthesizerSupportedArithOpcodes, SynthesizerSupportedBlkInfOpcodes, SynthesizerSupportedEnvInfOpcodes, SynthesizerSupportedLogOpcodes, SynthesizerSupportedSysFlowOpcodes, type DataPt, type ReservedVariable, type SynthesizerSupportedOpcodes, UINT256_DATA_PT_TYPE, UINT32_DATA_PT_TYPE } from '../types/index.ts';

import {
  Address,
  BIGINT_0,
  bytesToBigInt,
  setLengthRight,
  createAddressFromBigInt,
  bigIntToHex,
  setLengthLeft,
  bigIntToBytes,
} from '@ethereumjs/util'
import { InterpreterStep, Message } from '@ethereumjs/evm'
import { FUNCTION_INPUT_LENGTH, POSEIDON_INPUTS } from 'tokamak-l2js'
import { DataPtFactory, MemoryPt, StackPt } from '../dataStructure/index.ts';
import { ArithmeticOperator, type ArithmeticSubcircuit } from '../../subcircuit/configuredTypes.ts';
import { ContextManager, type ContextConstructionData } from './stateManager.ts';

export interface HandlerOpts {
  op: SynthesizerSupportedOpcodes,
  pc: bigint,
  thisAddress: Address,
  codeAddress: Address,
  originAddress: Address,
  callerAddress: Address,
  callDepth: number,
  thisContext: ContextManager,
  prevStepResult: InterpreterStep,
  stackPt: StackPt,
  memoryPt: MemoryPt,
  memOut?: Uint8Array,
}

export interface SynthesizerOpHandler {
  (context: ContextManager, stepResult: InterpreterStep): void | Promise<void>
}

/**
 * Side-effect-free preparation for a read over consecutive memory views. The
 * caller records each composition before consuming the corresponding value.
 */
type PreparedMemoryRead = Readonly<{
  compositions: readonly PreparedComposition[]
  viewDataPts: DataPt[]
  recoveredValue: bigint
}>

/**
 * Side-effect-free preparation for a memory copy. The caller records the
 * compositions in order before writing the destination entries to MemoryPt.
 */
type PreparedMemoryCopy = Readonly<{
  compositions: readonly PreparedComposition[]
  destinationEntries: MemoryPts
}>

const checkRequiredInput = (...input: unknown[]): void => {
  if (input.some(v => v === undefined)) throw new Error('Required inputs are missing')
}

export class InstructionHandler {
  public synthesizerHandlers!: Map<number, SynthesizerOpHandler>
  private cachedOpts: SynthesizerOpts
  constructor(
    private parent: ISynthesizerProvider,
  ) {
    this.cachedOpts = parent.cachedOpts
    this._createSynthesizerHandlers()
  }

  public initializeMessageContext(message: Message): void {
    this.parent.messageCodeAddresses.add(message.codeAddress.toString())
    if (message.isCreate) {
      throw new Error('CREATE is not supported.')
    }
    if (message.isCompiled) {
      throw new Error('Precompiled functions are not supported.')
    }

    const depth = message.depth
    let callDataMemoryPts: MemoryPts
    let callerPt: DataPt
    let codeAddressPt: DataPt
    let storageAddressPt: DataPt
    let callDataByteLength: number

    if (depth === 0) {
      const selectorPt = this.parent.getReservedVariableFromBuffer('FUNCTION_SELECTOR')
      const inputPts: DataPt[] = Array.from({ length: FUNCTION_INPUT_LENGTH }, (_, index) =>
        this.parent.getReservedVariableFromBuffer(
          `TRANSACTION_INPUT${index}` as ReservedVariable,
        ),
      )
      callDataMemoryPts = [
        { memByteOffset: 0, containerByteSize: 4, dataPt: selectorPt },
        ...inputPts.map((dataPt, index) => ({
          memByteOffset: 4 + 32 * index,
          containerByteSize: 32,
          dataPt,
        })),
      ]
      callDataByteLength = message.data.length
      if (this.parent.state.cachedOrigin === undefined) {
        throw new Error('Sender address must be verified first')
      }
      callerPt = DataPtFactory.deepCopy(this.parent.state.cachedOrigin)
      const contractAddressPt = this.parent.getReservedVariableFromBuffer('CONTRACT_ADDRESS')
      codeAddressPt = DataPtFactory.deepCopy(contractAddressPt)
      storageAddressPt = DataPtFactory.deepCopy(contractAddressPt)
    } else if (depth > 0) {
      const parentContext = this.parent.state.contextByDepth[depth - 1]
      if (parentContext === undefined) {
        throw new Error('Debug: No parent context')
      }
      const callingStep = parentContext.prevInterpreterStep
      if (callingStep === null) {
        throw new Error('Debug: A child context is called but no relevant interpreter step in the parent context')
      }

      let rawCodeAddress: bigint
      let rawCodeAddressPt: DataPt
      let inputOffset: bigint
      let inputLength: bigint
      switch (callingStep.opcode.name) {
        case 'CALL':
        case 'CALLCODE': {
          const inputs = callingStep.stack.slice(0, 7)
          rawCodeAddress = inputs[1]
          rawCodeAddressPt = DataPtFactory.deepCopy(parentContext.stackPt.peek(7)[1])
          inputOffset = inputs[3]
          inputLength = inputs[4]
          break
        }
        case 'DELEGATECALL':
        case 'STATICCALL': {
          const inputs = callingStep.stack.slice(0, 6)
          rawCodeAddress = inputs[1]
          rawCodeAddressPt = DataPtFactory.deepCopy(parentContext.stackPt.peek(6)[1])
          inputOffset = inputs[2]
          inputLength = inputs[3]
          break
        }
        default:
          throw new Error(`Debug: Unsupported message call opcode: ${callingStep.opcode.name}`)
      }

      if (rawCodeAddress !== rawCodeAddressPt.value) {
        throw new Error('Debug: Raw address to call mismatch between EVM and Synthesizer')
      }
      const addressMaskPt = this.parent.getReservedVariableFromBuffer('ADDRESS_MASK')
      const preparedTargetMask = this._prepareSingleStepArithmeticComposition(
        'AND',
        [rawCodeAddressPt, addressMaskPt],
        this.parent.placements.length,
      )
      this.parent.placeComposition(preparedTargetMask)
      const maskedAddressPt = preparedTargetMask.resultPts[0]
      if (maskedAddressPt === undefined) {
        throw new Error('Synthesizer: CALL target mask produced no address')
      }
      codeAddressPt = maskedAddressPt
      const codeAddress = BigInt(message.codeAddress.toString())
      if (codeAddress !== codeAddressPt.value) {
        throw new Error('Debug: Address to call mismatch between EVM and Synthesizer')
      }
      if (codeAddress >= 1n && codeAddress <= 10n) {
        throw new Error('Precompiles are not implemented in Synthesizer.')
      }

      switch (callingStep.opcode.name) {
        case 'CALL':
        case 'STATICCALL':
          callerPt = DataPtFactory.deepCopy(parentContext.storageAddressPt)
          storageAddressPt = DataPtFactory.deepCopy(codeAddressPt)
          break
        case 'CALLCODE':
          callerPt = DataPtFactory.deepCopy(parentContext.storageAddressPt)
          storageAddressPt = DataPtFactory.deepCopy(parentContext.storageAddressPt)
          break
        case 'DELEGATECALL':
          callerPt = DataPtFactory.deepCopy(parentContext.callerPt)
          storageAddressPt = DataPtFactory.deepCopy(parentContext.storageAddressPt)
          break
      }

      const preparedMemoryCopy = this._prepareMemoryCopy(
        parentContext.memoryPt,
        inputOffset,
        inputLength,
        0n,
        this.parent.placements.length,
      )
      for (const preparedComposition of preparedMemoryCopy.compositions) {
        this.parent.placeComposition(preparedComposition)
      }
      callDataMemoryPts = preparedMemoryCopy.destinationEntries
      callDataByteLength = Number(inputLength)
      const simulatedCallDataMemoryPt = MemoryPt.simulateMemoryPt(callDataMemoryPts)
      const synthesizedCallData = simulatedCallDataMemoryPt.viewMemory(0, Number(inputLength))
      const actualCallData = callingStep.memory.subarray(
        Number(inputOffset),
        Number(inputOffset) + Number(inputLength),
      )
      if (bytesToBigInt(synthesizedCallData) !== bytesToBigInt(actualCallData)) {
        throw new Error('Debug: Mismatch between calldata memory and memoryPt of the parent context')
      }
    } else {
      throw new Error(`Debug: Invalid call depth: ${depth}`)
    }

    const contextData: ContextConstructionData = {
      callDataMemoryPts,
      callDataByteLength,
      callerPt,
      codeAddressPt,
      storageAddressPt,
    }
    this.parent.state.beginFrame(depth)
    this.parent.state.contextByDepth[depth] = new ContextManager(contextData)
  }

  private _createHandlerOpts(opName: SynthesizerSupportedOpcodes, context: ContextManager): HandlerOpts {
    const prevStepResult = context.prevInterpreterStep;
    if (prevStepResult === null) {
      throw new Error('Debug: previous interpreter step is not set')
    }
    const depth = prevStepResult.depth;
    const callerAddr = context.callerPt.value;
    const originAddr = this.parent.state.cachedOrigin?.value
    if (originAddr === undefined) {
      throw new Error('Debug: Origin address is not verified')
    }
    return {
      op: opName,
      pc: BigInt(prevStepResult.pc - 1),
      codeAddress: prevStepResult.codeAddress ?? prevStepResult.address,
      thisAddress: prevStepResult.address,
      originAddress: createAddressFromBigInt(originAddr),
      callerAddress: createAddressFromBigInt(callerAddr),
      callDepth: depth,
      prevStepResult,
      thisContext: context,
      stackPt: context.stackPt,
      memoryPt: context.memoryPt,
    }
  }

  private _createSynthesizerHandlers(): void {
    this.synthesizerHandlers = new Map<number, SynthesizerOpHandler>()
    const __createArithHandler = (opName: SynthesizerSupportedArithOpcodes): void => {
      const op: number = synthesizerOpcodeByName[opName]
      this.synthesizerHandlers.set(
        op,
        (context, stepResult) => {
          const out: bigint | null = stepResult.stack[0] ?? null
          const opts = this._createHandlerOpts(opName, context)
          let nIns: number
          // based on https://www.evm.codes/
          switch(opName){
            case 'ISZERO':
            case 'NOT':
              nIns = 1
              break
            case 'ADDMOD':
            case 'MULMOD':
              nIns = 3
              break
            case 'KECCAK256': 
              nIns = 2
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[0]
                const dataLength = ins[1]
                opts.memOut = opts.prevStepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            default:
              nIns = 2
              break            
          }
          const ins = opts.prevStepResult.stack.slice(0, nIns)
          
          this.handleArith(ins, out, opts)
        },
      )
    }
    const __createEnvInfHandler = (opName: SynthesizerSupportedEnvInfOpcodes): void => {
      const op: number = synthesizerOpcodeByName[opName]
      this.synthesizerHandlers.set(
        op,
        (context, stepResult) => {
          const out: bigint | null = stepResult.stack[0] ?? null
          const opts = this._createHandlerOpts(opName, context);
          // based on https://www.evm.codes/
          let nIns: number
          switch(opName) {
            case 'BALANCE':
            case 'CALLDATALOAD':
            case 'EXTCODESIZE':
            case 'EXTCODEHASH':
              nIns = 1
              break
            case 'CALLDATACOPY':
            case 'CODECOPY':
            case 'RETURNDATACOPY':
              nIns = 3
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[0]
                const dataLength = ins[2]
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            case 'EXTCODECOPY': 
              nIns = 4
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[1]
                const dataLength = ins[3]
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            default:
              nIns = 0
              break
          }
          const ins = opts.prevStepResult.stack.slice(0, nIns)
          this.handleEnvInf(ins, out, opts)
        },
      )
    }
    const __createBlkInfHandler = (opName: SynthesizerSupportedBlkInfOpcodes): void => {
      const op: number = synthesizerOpcodeByName[opName]
      this.synthesizerHandlers.set(
        op,
        (context, stepResult) => {
          const opts = this._createHandlerOpts(opName, context);
          const inVal = opName === 'BLOCKHASH' ? opts.prevStepResult.stack[0] : undefined
          const outVal: bigint | null = stepResult.stack[0] ?? null
          this.handleBlkInf(opName, inVal, outVal, opts)
        },
      )
    }
    const __createSysFlowHandlers = (opName: SynthesizerSupportedSysFlowOpcodes): void => {
      const op: number = synthesizerOpcodeByName[opName]
      this.synthesizerHandlers.set(
        op,
        async (context, stepResult) => {
          const out: bigint | null = stepResult.stack[0] ?? null
          const opts = this._createHandlerOpts(opName, context)
          // based on https://www.evm.codes/
          let nIns: number
          switch(opName) {
            case 'POP':
            case 'MLOAD':
            case 'SLOAD':
            case 'JUMP':
              nIns = 1
              break
            case 'MSTORE':
            case 'MSTORE8':
              nIns = 2
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[0]
                const dataLength = opName === 'MSTORE' ? 32 : 1
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + dataLength)
              }
              break
            case 'SSTORE':
            case 'JUMPI':
              nIns = 2
              break
            case 'RETURN':
            case 'REVERT':
              nIns = 2
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[0]
                const dataLength = ins[1]
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            case 'MCOPY':
              nIns = 3
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[0]
                const dataLength = ins[2]
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            case 'CALL':
            case 'CALLCODE':
              nIns = 7
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[5]
                const dataLength = ins[6]
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            case 'DELEGATECALL':
            case 'STATICCALL':
              nIns = 6
              {
                const ins = opts.prevStepResult.stack.slice(0, nIns)
                const memOffset = ins[4]
                const dataLength = ins[5]
                opts.memOut = stepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength))
              }
              break
            default:
              nIns = 0
              break
          }
          const ins = opts.prevStepResult.stack.slice(0, nIns)
          await this.handleSysFlow(ins, out, opts)
        },
      )
    }
    const __createLoggerHandlers = (opName: SynthesizerSupportedLogOpcodes): void => {
      const op: number = synthesizerOpcodeByName[opName]
      this.synthesizerHandlers.set(
        op,
        (context, stepResult) => {
          const out: bigint | null = stepResult.stack[0] ?? null
          const opts = this._createHandlerOpts(opName, context)
          const nTopics = opts.prevStepResult.opcode.code - 0xa0
          const ins = opts.prevStepResult.stack.slice(0, nTopics + 2)

          this.handleLoggers(ins, out, opts)
        },
      )
    }

    // Start creating handlers
    this.synthesizerHandlers.set(synthesizerOpcodeByName['STOP'], function(){})
    ;([
      'ADD',
      'MUL',
      'SUB',
      'DIV',
      'SDIV',
      'MOD',
      'SMOD',
      'ADDMOD',
      'MULMOD',
      'EXP',
      'SIGNEXTEND',
      'LT',
      'GT',
      'SLT',
      'SGT',
      'EQ',
      'ISZERO',
      'AND',
      'OR',
      'XOR',
      'NOT',
      'BYTE',
      'SHL',
      'SHR',
      'SAR',
      'KECCAK256',
    ] satisfies SynthesizerSupportedOpcodes[]).forEach(__createArithHandler)
    ;([
      'ADDRESS',
      'BALANCE',
      'ORIGIN',
      'CALLER',
      'CALLVALUE',
      'CALLDATALOAD',
      'CALLDATASIZE',
      'CALLDATACOPY',
      'CODESIZE',
      'CODECOPY',
      'GASPRICE',
      'EXTCODESIZE',
      'EXTCODECOPY',
      'RETURNDATASIZE',
      'RETURNDATACOPY',
      'EXTCODEHASH',
    ] satisfies SynthesizerSupportedOpcodes[]).forEach(__createEnvInfHandler)
    ;([
      'BLOCKHASH',
      'COINBASE',
      'TIMESTAMP',
      'NUMBER',
      'PREVRANDAO',
      'GASLIMIT',
      'CHAINID',
      'SELFBALANCE',
      'BASEFEE',
    ] satisfies SynthesizerSupportedOpcodes[]).forEach(__createBlkInfHandler)
    ;(['POP'
      ,'MLOAD'
      , 'MSTORE'
      , 'MSTORE8'
      , 'SLOAD'
      , 'SSTORE'
      , 'JUMP'
      , 'JUMPI'
      , 'PC'
      , 'MSIZE'
      , 'GAS'
      , 'JUMPDEST'
      , 'MCOPY'
      , 'CALL'
      , 'CALLCODE'
      , 'RETURN'
      , 'DELEGATECALL'
      , 'STATICCALL'
      , 'REVERT'
    ] satisfies SynthesizerSupportedOpcodes[]).forEach(__createSysFlowHandlers)
    ;([
      'LOG0',
      'LOG1',
      'LOG2',
      'LOG3',
      'LOG4',
    ] satisfies SynthesizerSupportedOpcodes[]).forEach(__createLoggerHandlers)

    // PUSHs
    this.synthesizerHandlers.set(
      synthesizerOpcodeByName['PUSH0'],
      (context, stepResult) => {
        const opts = this._createHandlerOpts('PUSH0', context);
        const out: bigint = stepResult.stack[0]
        const numToPush = opts.prevStepResult.opcode.code - 0x5f
        const staticInDesc = `Static input for PUSH${numToPush} instruction at PC ${opts.pc} of code address ${opts.thisAddress} (depth: ${opts.callDepth})`
        opts.stackPt.push(this.parent.loadArbitraryStatic(
          out,
          UINT256_DATA_PT_TYPE,
          staticInDesc,
        ))
        if (opts.stackPt.peek(1)[0].value !== out) {
          throw new Error(`Synthesizer: PUSH${numToPush}: Output data mismatch`)
        }
      },
    )
    const pushFn = this.synthesizerHandlers.get(synthesizerOpcodeByName['PUSH0'])!
    for (let i = 0x60; i <= 0x7f; i++) {
      this.synthesizerHandlers.set(i, pushFn);
    }
    // DUPs
    this.synthesizerHandlers.set(
      synthesizerOpcodeByName['DUP1'],
      (context, stepResult) => {
        const opts = this._createHandlerOpts('DUP1', context);
        const stackPos = opts.prevStepResult.opcode.code - 0x7f
        opts.stackPt.dup(stackPos)
        if (opts.stackPt.peek(1)[0].value !== stepResult.stack[0]) {
          throw new Error(`Synthesizer: DUP${stackPos}: Output data mismatch`)
        }
      },
    )
    const dupFn = this.synthesizerHandlers.get(synthesizerOpcodeByName['DUP1'])!
    for (let i = 0x81; i <= 0x8f; i++) {
      this.synthesizerHandlers.set(i, dupFn)
    }
    // SWAPs
    this.synthesizerHandlers.set(
      synthesizerOpcodeByName['SWAP1'],
      (context, stepResult) => {
        const opts = this._createHandlerOpts('SWAP1', context);
        const stackPos = opts.prevStepResult.opcode.code - 0x8f
        opts.stackPt.swap(stackPos)
        if (opts.stackPt.peek(1)[0].value !== stepResult.stack[0]) {
          throw new Error(`Synthesizer: SWAP${stackPos}: Output data mismatch`)
        }
      },
    )
    const swapFn = this.synthesizerHandlers.get(synthesizerOpcodeByName['SWAP1'])!
    for (let i = 0x91; i <= 0x9f; i++) {
      this.synthesizerHandlers.set(i, swapFn)
    }

  }

  private _prepareFixedMultiStepArithmeticComposition(
    operation: ArithmeticOperator,
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition {
    const composition = this.parent.subcircuitLibrary
      .placementCompositionManager.get(operation)
    if (
      composition.placementStrategy !== 'generic'
      || composition.numSteps === 'dynamic'
      || composition.numOperands === 'dynamic'
      || composition.numResults !== 1
      || operands.length !== composition.numOperands
    ) {
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
            inPts.push(this.parent.loadArbitraryStatic(constant.value, constant.dataPtType))
            break
          }
          case 'selector':
            if (typeof step.selector !== 'bigint') {
              throw new Error(`Synthesizer: ${operation} requires a static selector`)
            }
            inPts.push(this.parent.loadArbitraryStatic(
              step.selector,
              UINT32_DATA_PT_TYPE,
              `ALU selector for ${operation} of ${step.subcircuit}`,
            ))
            break
        }
      }

      const logicalInterface = this.parent.subcircuitLibrary.subcircuitInfoByName
        .get(step.subcircuit)?.logicalInterface
      if (logicalInterface === undefined) {
        throw new Error(`Synthesizer: ${step.subcircuit} logical interface is unavailable`)
      }
      const values = this.parent.calculateSubcircuitOutputValues(
        step.subcircuit as ArithmeticSubcircuit,
        inPts.map(({ value }) => value),
      )
      if (values.length !== logicalInterface.outputs.length) {
        throw new Error(
          `Synthesizer: ${step.subcircuit} produced ${values.length} outputs, but its logical interface declares ${logicalInterface.outputs.length}`,
        )
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
        if (output.kind === 'step-output') {
          intermediateOutPts[output.index] = outPt
        } else if (output.kind === 'result') {
          resultPts[output.index] = outPt
        }
      }
      steps.push({ inPts, outPts })
    }

    if (resultPts.some((resultPt) => resultPt === undefined)) {
      throw new Error(`Synthesizer: ${operation} did not produce every declared result`)
    }
    const preparedComposition: PreparedComposition = {
      operation,
      operands,
      resultPts: resultPts as DataPt[],
      steps,
    }
    return preparedComposition
  }

  private _preparePoseidonComposition(
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition {
    const composition = this.parent.subcircuitLibrary
      .placementCompositionManager.get('Poseidon')
    const step = composition.steps[0]
    if (
      composition.placementStrategy !== 'poseidon'
      || composition.numSteps !== 'dynamic'
      || composition.numOperands !== 'dynamic'
      || composition.numResults !== 1
      || composition.steps.length !== 1
      || step === undefined
      || step.subcircuit !== 'Poseidon'
      || step.selector !== 'dynamic'
      || step.inputs[0]?.kind !== 'selector'
    ) {
      throw new Error('Synthesizer: Poseidon has an invalid placement composition')
    }

    const logicalInterface = this.parent.subcircuitLibrary.subcircuitInfoByName
      .get(step.subcircuit)?.logicalInterface
    const selectorPort = logicalInterface?.inputs[0]
    const valuePort = logicalInterface?.inputs[1]
    const resultPort = logicalInterface?.outputs[0]
    if (
      logicalInterface === undefined
      || logicalInterface.inputs.length !== step.inputs.length
      || logicalInterface.outputs.length !== 1
      || selectorPort === undefined
      || valuePort === undefined
      || resultPort === undefined
    ) {
      throw new Error('Synthesizer: Poseidon logical interface is unavailable')
    }

    const inputLimit = step.inputs.length - 1
    if (inputLimit < POSEIDON_INPUTS) {
      throw new Error('Synthesizer: Poseidon input capacity is too small')
    }
    const selectorType = getDataPtTypeFromLogicalInterfaceType(selectorPort.logicalType)
    const valueType = getDataPtTypeFromLogicalInterfaceType(valuePort.logicalType)
    const resultType = getDataPtTypeFromLogicalInterfaceType(resultPort.logicalType)
    const zeroPt = this.parent.loadArbitraryStatic(0n, valueType)
    const steps: Array<PreparedComposition['steps'][number]> = []

    const prepareNormalized = (inputPts: DataPt[]): DataPt => {
      if (inputPts.length < POSEIDON_INPUTS || inputPts.length > inputLimit) {
        throw new Error(
          `Synthesizer: Poseidon expected between ${POSEIDON_INPUTS} and ${inputLimit} inputs, but got ${inputPts.length}`,
        )
      }
      const selector = 1n << BigInt(inputPts.length - POSEIDON_INPUTS)
      const finalInPts = [
        this.parent.loadArbitraryStatic(
          selector,
          selectorType,
          'ALU selector for Poseidon',
        ),
        ...inputPts,
        ...Array.from(
          { length: inputLimit - inputPts.length },
          () => DataPtFactory.deepCopy(zeroPt),
        ),
      ]
      const values = this.parent.calculateSubcircuitOutputValues(
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
      steps.push({ inPts: finalInPts, outPts: [outPt] })
      return outPt
    }

    let chainInputs = operands.slice()
    if (chainInputs.length === 0) {
      chainInputs = [DataPtFactory.deepCopy(zeroPt), DataPtFactory.deepCopy(zeroPt)]
    } else if (chainInputs.length === 1) {
      chainInputs.push(DataPtFactory.deepCopy(zeroPt))
    }
    while (chainInputs.length > inputLimit) {
      const prefixHash = prepareNormalized(chainInputs.slice(0, inputLimit))
      chainInputs = [prefixHash, ...chainInputs.slice(inputLimit)]
    }
    const resultPt = prepareNormalized(chainInputs)
    const preparedComposition: PreparedComposition = {
      operation: 'Poseidon',
      operands,
      resultPts: [resultPt],
      steps,
    }
    return preparedComposition
  }

  private _prepareSingleStepArithmeticComposition(
    operation: ArithmeticOperator,
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition {
    const composition = this.parent.subcircuitLibrary
      .placementCompositionManager.get(operation)
    const step = composition.steps[0]
    if (
      composition.placementStrategy !== 'generic'
      || composition.numSteps !== 1
      || composition.numResults !== 1
      || step === undefined
    ) {
      throw new Error(
        `Synthesizer: ${operation} is not a supported single-step arithmetic composition`,
      )
    }

    const finalInPts: DataPt[] = []
    for (const input of step.inputs) {
      switch (input.kind) {
        case 'selector':
          if (typeof step.selector !== 'bigint') {
            throw new Error(`Synthesizer: ${operation} requires a static selector`)
          }
          finalInPts.push(this.parent.loadArbitraryStatic(
            step.selector,
            UINT32_DATA_PT_TYPE,
            `ALU selector for ${operation} of ${step.subcircuit}`,
          ))
          break
        case 'operand': {
          const operand = operands[input.index]
          if (operand === undefined) {
            throw new Error(
              `Synthesizer: ${operation} operand ${input.index} is unavailable`,
            )
          }
          finalInPts.push(operand)
          break
        }
        case 'constant': {
          const constant = composition.constants[input.index]
          if (constant === undefined) {
            throw new Error(
              `Synthesizer: ${operation} constant ${input.index} is unavailable`,
            )
          }
          finalInPts.push(this.parent.loadArbitraryStatic(
            constant.value,
            constant.dataPtType,
          ))
          break
        }
        case 'step-output':
          throw new Error(
            `Synthesizer: ${operation} single-step composition cannot consume an intermediate output`,
          )
      }
    }

    const values = this.parent.calculateSubcircuitOutputValues(
      step.subcircuit as ArithmeticSubcircuit,
      finalInPts.map(({ value }) => value),
    )
    const value = values[0]
    if (value === undefined) {
      throw new Error(
        `Synthesizer: ${operation} did not produce a first subcircuit output`,
      )
    }

    const resultPt = DataPtFactory.create({
      source: basePlacementIndex,
      wireIndex: 0,
      dataPtType: UINT256_DATA_PT_TYPE,
    }, value)
    const preparedComposition: PreparedComposition = {
      operation,
      operands,
      resultPts: [resultPt],
      steps: [{ inPts: finalInPts, outPts: [resultPt] }],
    }
    return preparedComposition
  }

  private _assertStorageAddress(
    address: Address,
    addressPt: DataPt,
  ): void {
    if (addressPt.value !== bytesToBigInt(address.bytes)) {
      throw new Error('Synthesizer: Storage address mismatch between EVM and storageAddressPt')
    }
  }

  private _constrainStorageLocationEquality(
    currentAddressPt: DataPt,
    currentKeyPt: DataPt,
    canonicalAddressPt: DataPt,
    canonicalKeyPt: DataPt,
  ): void {
    const inPts = [
      currentAddressPt,
      currentKeyPt,
      canonicalAddressPt,
      canonicalKeyPt,
    ]
    const preparedComposition: PreparedComposition = {
      operation: 'StorageAccess',
      operands: inPts,
      resultPts: [],
      steps: [{ inPts, outPts: [] }],
    }
    this.parent.placeComposition(preparedComposition)
  }

  private _getCachedStorageEntry(
    addressValue: bigint,
    keyValue: bigint,
    addressPt: DataPt,
    keyPt: DataPt,
  ) {
    // The cache-entry and retained-initial-read branches are mutually exclusive,
    // so each lookup places EqualBatch at most once.
    const cachedEntry = this.parent.state.storageCache.get(addressValue, keyValue)
    if (cachedEntry !== undefined) {
      this._constrainStorageLocationEquality(
        addressPt,
        keyPt,
        cachedEntry.canonicalAddressPt,
        cachedEntry.canonicalKeyPt,
      )
      return cachedEntry
    }

    const initialRead = this.parent.state.initialStorageReads.get(addressValue, keyValue)
    if (initialRead === undefined) {
      return undefined
    }
    this._constrainStorageLocationEquality(
      addressPt,
      keyPt,
      initialRead.addressPt,
      initialRead.keyPt,
    )
    return {
      canonicalAddressPt: initialRead.addressPt,
      canonicalKeyPt: initialRead.keyPt,
      latestValuePt: initialRead.valuePt,
      dirty: false,
    }
  }

  private async loadStorage(
    addressPt: DataPt,
    keyPt: DataPt,
    valueGiven?: bigint,
  ): Promise<DataPt> {
    const addressValue = addressPt.value
    const keyValue = keyPt.value
    const address = createAddressFromBigInt(addressValue)
    const valueStored = bytesToBigInt(
      await this.cachedOpts.stateManager.getStorage(
        address,
        setLengthLeft(bigIntToBytes(keyPt.value), 32),
      ),
    );
    if (valueGiven !== undefined && valueGiven !== valueStored) {
      throw new Error('Mismatch in storage values');
    }

    const cachedEntry = this._getCachedStorageEntry(addressValue, keyValue, addressPt, keyPt)
    if (cachedEntry !== undefined) {
      if (cachedEntry.latestValuePt.value !== valueStored) {
        throw new Error('Synthesizer: Cached storage value does not match EVM storage')
      }
      this.parent.state.storageCache.set(addressValue, keyValue, cachedEntry)
      return DataPtFactory.deepCopy(cachedEntry.latestValuePt)
    }

    this.parent.addReservedVariableToBufferOut(
      'SLOAD_ADDRESS',
      addressPt,
      true,
      ` of address: ${address}`,
    );
    this.parent.addReservedVariableToBufferOut(
      'SLOAD_KEY',
      keyPt,
      true,
      ` of address: ${address}`,
    );
    const valuePt = this.parent.addReservedVariableToBufferIn(
      'SLOAD_VALUE',
      valueStored,
      true,
      ` of address: ${address}`,
    );
    const initialRead = {
      addressPt: DataPtFactory.deepCopy(addressPt),
      keyPt: DataPtFactory.deepCopy(keyPt),
      valuePt: DataPtFactory.deepCopy(valuePt),
    }
    this.parent.state.initialStorageReads.add(addressValue, keyValue, initialRead)
    this.parent.state.storageCache.set(addressValue, keyValue, {
      canonicalAddressPt: initialRead.addressPt,
      canonicalKeyPt: initialRead.keyPt,
      latestValuePt: initialRead.valuePt,
      dirty: false,
    })
    return DataPtFactory.deepCopy(valuePt);
  }

  private async storeStorage(
    addressPt: DataPt,
    keyPt: DataPt,
    symbolDataPt: DataPt,
  ): Promise<void> {
    const addressValue = addressPt.value
    const keyValue = keyPt.value
    const address = createAddressFromBigInt(addressValue)
    const valueStored = bytesToBigInt(
      await this.cachedOpts.stateManager.getStorage(
        address,
        setLengthLeft(bigIntToBytes(keyPt.value), 32),
      ),
    );
    if (valueStored !== symbolDataPt.value) {
      throw new Error('Mismatch in storage values between MPT and EVM stack');
    }

    const cachedEntry = this._getCachedStorageEntry(addressValue, keyValue, addressPt, keyPt)
    this.parent.state.storageCache.set(addressValue, keyValue, {
      canonicalAddressPt: cachedEntry?.canonicalAddressPt ?? addressPt,
      canonicalKeyPt: cachedEntry?.canonicalKeyPt ?? keyPt,
      latestValuePt: symbolDataPt,
      dirty: true,
    })
  }

  public handleArith = (
    ins: bigint[],
    out: bigint,
    opts: HandlerOpts,
  ): void => {
    const inPts = this._popStackPtAndCheckInputConsistency(opts.stackPt, ins)
    let preparedComposition: PreparedComposition;
    const op = opts.op as SynthesizerSupportedArithOpcodes
    switch (op) {
      case 'DIV':
      case 'SDIV':
      case 'MOD':
      case 'SMOD':
      case 'ADDMOD':
      case 'MULMOD':
      case 'EXP':
        preparedComposition = this._prepareFixedMultiStepArithmeticComposition(
          op,
          inPts,
          this.parent.placements.length,
        )
        break
      case 'KECCAK256': {
          checkRequiredInput(opts.memOut)
          const memOffset = ins[0]
          const dataLength = ins[1]
          const preparedMemoryRead = this._prepareMemoryRead(
            opts.memoryPt,
            memOffset,
            dataLength,
            this.parent.placements.length,
          )
          for (const preparedComposition of preparedMemoryRead.compositions) {
            this.parent.placeComposition(preparedComposition)
          }
          const { viewDataPts, recoveredValue } = preparedMemoryRead
          if (bytesToBigInt(opts.memOut!) !== recoveredValue) {
            throw new Error(`Synthesizer: ${op}: Memory data to load mismatch`)
          }
          preparedComposition = this._preparePoseidonComposition(
            viewDataPts,
            this.parent.placements.length,
          )
        }
        break
      default:
        preparedComposition = this._prepareSingleStepArithmeticComposition(
          op as ArithmeticOperator,
          inPts,
          this.parent.placements.length,
        );
        break;
    }
    this.parent.placeComposition(preparedComposition)
    const outPts = preparedComposition.resultPts
    if (outPts.length !== 1 || outPts[0].value !== out) {
      throw new Error(`Synthesizer: ${op}: Output data mismatch`);
    }
    opts.stackPt.push(outPts[0]);
  }

  public handleBlkInf = (
    op: SynthesizerSupportedBlkInfOpcodes,
    inVal: bigint | undefined,
    out: bigint,
    opts: HandlerOpts,
  ): void => {
    const stackPt = opts.stackPt
    let dataPt: DataPt;
    switch (op) {
      case 'COINBASE':
      case 'TIMESTAMP':
      case 'NUMBER':
      case 'GASLIMIT':
      case 'CHAINID':
      case 'SELFBALANCE':
      case 'BASEFEE': {
        dataPt = this.parent.getReservedVariableFromBuffer(op)
        break
      }
      case 'BLOCKHASH': {
        const blockNumber = inVal;
        if (blockNumber === undefined) {
          throw new Error('Debug: BLOCKHASH requires an input block number')
        }
        this._popStackPtAndCheckInputConsistency(opts.stackPt, [blockNumber]);
        const blockNumberDiff = this.parent.getReservedVariableFromBuffer('NUMBER').value - blockNumber;
        if (blockNumberDiff <= 0n || blockNumberDiff > 256n) {
          dataPt = this.parent.loadArbitraryStatic(
            0n,
            UINT256_DATA_PT_TYPE,
          )
          break
        }
        if (blockNumberDiff > BigInt(this.parent.subcircuitLibrary.numberOfPrevBlockHashes)) {
          throw new Error(
            `Synthesizer: BLOCKHASH requires ${blockNumberDiff.toString()} previous block hashes, but qap-compiler nPrevBlockHashes is ${this.parent.subcircuitLibrary.numberOfPrevBlockHashes}. Increase qap-compiler nPrevBlockHashes.`,
          )
        }
        dataPt = this.parent.getReservedVariableFromBuffer(`BLOCKHASH_${blockNumberDiff}` as ReservedVariable)
        break
      }
      default:
        throw new Error(
          `Synthesizer: ${op} is unimplemented.`,
        );
    }
    stackPt.push(dataPt);
    if (stackPt.peek(1)[0].value !== out) {
      throw new Error(`Synthesizer: ${op}: Output data mismatch`);
    }
  }

  private _getStaticInDataPt = (output: bigint, opts: HandlerOpts, targetAddress?: bigint): DataPt => {
    const value = output
    const staticInDesc = `Static input for ${opts.op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth : ${opts.callDepth})`
    let targetDesc = targetAddress === undefined ? `` : `(target: ${createAddressFromBigInt(targetAddress).toString()})`
    return this.parent.loadArbitraryStatic(
      value,
      UINT256_DATA_PT_TYPE,
      staticInDesc + targetDesc,
    )
  }

  private _popStackPtAndCheckInputConsistency = (stackPt: StackPt, ins: bigint[]): DataPt[] => {
    const nIns = ins.length  
    const dataPts = stackPt.popN(nIns)
      for (var i = 0; i < nIns; i++) {
        if (ins[i] !== dataPts[i].value){
          throw new Error(`Synthesizer: Handler: The ${i}-th input data mismatch`)
        }
      }
      return dataPts
    }

  public handleEnvInf(
    ins: bigint[],
    out: bigint | null,
    opts: HandlerOpts,
  ): void {
    const _retrieveOriginAddressPt = (): DataPt => {
      checkRequiredInput(opts.originAddress)
      const dataPt = this.parent.state.cachedOrigin
      if (dataPt === undefined) {
        throw new Error('Synthesizer: Origin address is not populated by TransactionSignatureVerify')
      }
      if (dataPt.value !== bytesToBigInt(opts.originAddress!.bytes)) {
        throw new Error("Mismatch of the origin between EVM and Synthesizer")
      }
      return dataPt
    }
    
    const stackPt = opts.stackPt;
    const memoryPt = opts.memoryPt;
    this._popStackPtAndCheckInputConsistency(opts.stackPt, ins)
    const op = opts.op as SynthesizerSupportedEnvInfOpcodes
    switch (op) {
      case 'ADDRESS': 
        {
          const cache = opts.thisContext.storageAddressPt;
          if (cache === undefined) {
            throw new Error(`No cache for storage address`)
          }
          stackPt.push(DataPtFactory.deepCopy(cache))
        }
        break
      case 'BALANCE': 
        {
          const targetAddress = ins[0]
          stackPt.push(this._getStaticInDataPt(out!, opts, targetAddress))
        }
        break
      case 'ORIGIN': 
        stackPt.push(_retrieveOriginAddressPt())
        break
      case 'CALLER': 
        {
          const cache = opts.thisContext.callerPt;
          if (cache === undefined) {
            throw new Error(`No cache for caller address`)
          }
          stackPt.push(DataPtFactory.deepCopy(cache))
        }
        break
      case 'CALLVALUE': 
        stackPt.push(this._getStaticInDataPt(out!, opts))
        break
      case 'CALLDATALOAD': 
        {
          const srcOffset = ins[0]
          const i = Number(srcOffset);
          const calldataMemoryPts = opts.thisContext.callDataMemoryPts;
          if (calldataMemoryPts.length > 0) {
            const calldataMemoryPt = MemoryPt.simulateMemoryPt(calldataMemoryPts);
            const dataAliasInfos = calldataMemoryPt.getDataAlias(i, 32);
            if (dataAliasInfos.length > 0) {
              const preparedComposition = this._prepareMemoryLoadViewComposition(
                dataAliasInfos,
                32,
                this.parent.placements.length,
              )
              this.parent.placeComposition(preparedComposition)
              stackPt.push(preparedComposition.resultPts[0]!)
            } else {
              stackPt.push(this.parent.loadArbitraryStatic(
                0n,
                UINT256_DATA_PT_TYPE,
              ))
            }
          } else {
            stackPt.push(this.parent.loadArbitraryStatic(
              0n,
              UINT256_DATA_PT_TYPE,
            ))
          }   
        }
        break
      case 'CALLDATASIZE':
        stackPt.push(this._getStaticInDataPt(out!, opts))
        break
      case 'CALLDATACOPY':
        {
          const memOffset = ins[0]
          const dataOffset = ins[1]
          const dataLength = ins[2]
          checkRequiredInput(opts.memOut)
          if (dataLength !== BIGINT_0) {
            const preparedMemoryCopy = this._prepareMemoryCopy(
              MemoryPt.simulateMemoryPt(opts.thisContext.callDataMemoryPts),
              dataOffset,
              dataLength,
              memOffset,
              this.parent.placements.length,
            )
            for (const preparedComposition of preparedMemoryCopy.compositions) {
              this.parent.placeComposition(preparedComposition)
            }
            memoryPt.writeBatch(preparedMemoryCopy.destinationEntries)
          }
          const _outData = memoryPt.viewMemory(
            Number(memOffset),
            Number(dataLength),
          )
          if (bytesToBigInt(_outData) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          }
        }
        break
      case 'CODESIZE':
        stackPt.push(this._getStaticInDataPt(out!, opts))
        break
      case 'CODECOPY':
        {
          const memOffset = ins[0]
          const dataLength = ins[2]
          checkRequiredInput(opts.memOut)
          const thisAddress = opts.thisAddress ?? this.cachedOpts.signedTransaction.to
          if (dataLength !== BIGINT_0) {
            const memPts: MemoryPts = this._prepareCodeMemoryPts(
              opts.memOut!,
              bytesToBigInt(thisAddress.toBytes()),
              memOffset,
              0n,
              dataLength,
            )
            memoryPt.writeBatch(memPts)
          }

          const _outData = memoryPt.viewMemory(
            Number(memOffset),
            Number(dataLength),
          )
          if (bytesToBigInt(_outData) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          }
        }
        break
      case 'GASPRICE': 
        stackPt.push(this._getStaticInDataPt(out!, opts))
        break
      case 'EXTCODESIZE': 
        {
          const targetAdderss = ins[0]
          stackPt.push(this._getStaticInDataPt(out!, opts, targetAdderss))  
        }
        break
      case 'EXTCODECOPY':
        {
          const addressBigInt = ins[0]
          const memOffset = ins[1]
          const dataLength = ins[3]
          checkRequiredInput(opts.memOut)
          if (dataLength !== BIGINT_0) {
            const memPts: MemoryPts = this._prepareCodeMemoryPts(
              opts.memOut!,
              addressBigInt,
              memOffset,
              0n,
              dataLength,
            )
            memoryPt.writeBatch(memPts)
          }
          const _outData = memoryPt.viewMemory(
            Number(memOffset),
            Number(dataLength),
          )
          
          if (bytesToBigInt(_outData) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          }
        }
        break
      case 'RETURNDATASIZE': 
        stackPt.push(this._getStaticInDataPt(out!, opts))
        break
      case 'RETURNDATACOPY':
        {
          const memOffset = ins[0]
          const returnDataOffset = ins[1]
          const dataLength = ins[2]
          checkRequiredInput(opts.memOut)
          if (returnDataOffset + dataLength > BigInt(opts.thisContext.returnDataByteLength)) {
            throw new Error(`Synthesizer: ${op}: requested range exceeds return data`)
          }
          if (dataLength !== BIGINT_0) {
            const preparedMemoryCopy = this._prepareMemoryCopy(
              MemoryPt.simulateMemoryPt(opts.thisContext.returnDataMemoryPts),
              returnDataOffset,
              dataLength,
              memOffset,
              this.parent.placements.length,
            )
            for (const preparedComposition of preparedMemoryCopy.compositions) {
              this.parent.placeComposition(preparedComposition)
            }
            memoryPt.writeBatch(preparedMemoryCopy.destinationEntries)
          }
          const _outData = memoryPt.viewMemory(
            Number(memOffset),
            Number(dataLength),
          );
          if (bytesToBigInt(_outData) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          }
        }
        break
      case 'EXTCODEHASH': 
        {
          const targetAdderss = ins[0]
          stackPt.push(this._getStaticInDataPt(out!, opts, targetAdderss))
        }
        break
      default:
        throw new Error(
          `Synthesizer: ${op} is not implemented.`,
        )
    }
    if (out === null) {
      if (stackPt.length !== 0) {
        throw new Error(`Synthesizer: ${op}: Output data mismatch`);
      }
    } else {
      if (stackPt.peek(1)[0].value !== out) {
        throw new Error(`Synthesizer: ${op}: Output data mismatch`);
      }
    }
  }

  public handleLoggers(
    ins: bigint[],
    out: bigint | null,
    opts: HandlerOpts,
  ): void {
    const inPts = this._popStackPtAndCheckInputConsistency(opts.stackPt, ins)
    const op = opts.op as SynthesizerSupportedLogOpcodes
    const [memOffset, dataLength] = ins
    const topicPts = inPts.slice(2)
    const nTopics = opts.prevStepResult.opcode.code - 0xa0
    if (topicPts.length !== nTopics) {
      throw new Error(`Synthesizer: ${op}: Topic count mismatch`)
    }

    for (const [index, topicPt] of topicPts.entries()) {
      this.parent.addReservedVariableToBufferOut(
        'LOG_TOPIC',
        topicPt,
        true,
        ` for ${op} instruction, topic index: ${index}`,
      )
    }

    const preparedMemoryRead = this._prepareMemoryRead(
      opts.memoryPt,
      memOffset,
      dataLength,
      this.parent.placements.length,
    )
    for (const preparedComposition of preparedMemoryRead.compositions) {
      this.parent.placeComposition(preparedComposition)
    }
    const { viewDataPts, recoveredValue } = preparedMemoryRead
    const expectedLogData = bytesToBigInt(
      opts.prevStepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength)),
    )
    if (recoveredValue !== expectedLogData) {
      throw new Error(`Synthesizer: ${op}: Log data mismatch`)
    }

    for (const [index, viewDataPt] of viewDataPts.entries()) {
      this.parent.addReservedVariableToBufferOut(
        'LOG_VALUE',
        viewDataPt,
        true,
        ` for ${op} instruction, data index: ${index}`,
      )
    }

    if (out === null) {
      if (opts.stackPt.length !== 0) {
        throw new Error(`Synthesizer: ${op}: Output data mismatch`)
      }
    } else {
      if (opts.stackPt.peek(1)[0].value !== out) {
        throw new Error(`Synthesizer: ${op}: Output data mismatch`)
      }
    }
  }

  public async handleSysFlow(
    ins: bigint[],
    out: bigint | null,
    opts: HandlerOpts,
  ): Promise<void> {
    const op = opts.op as SynthesizerSupportedSysFlowOpcodes;
    const inPts = this._popStackPtAndCheckInputConsistency(opts.stackPt, ins);
    switch (op) {
      case 'POP': 
        break
      case 'MLOAD':
        {
          const pos = ins[0]
          const dataAliasInfos = opts.memoryPt.getDataAlias(
            Number(pos),
            32,
          )
          let mutDataPt: DataPt
          if (dataAliasInfos.length === 0) {
            mutDataPt = this.parent.loadArbitraryStatic(
              0n,
              UINT256_DATA_PT_TYPE,
            )
          } else {
            const preparedComposition = this._prepareMemoryLoadViewComposition(
              dataAliasInfos,
              32,
              this.parent.placements.length,
            )
            this.parent.placeComposition(preparedComposition)
            mutDataPt = preparedComposition.resultPts[0]!
          }
          opts.stackPt.push(mutDataPt)
        }
        break
      case 'MSTORE': 
      case 'MSTORE8': 
        {
          checkRequiredInput(opts.memOut)
          const offsetNum = Number(ins[0])
          const originalDataPt = inPts[1]
          let dataPtToStore = originalDataPt
          if (op === 'MSTORE8') {
            const preparedComposition = this._prepareSingleStepArithmeticComposition(
              'AND',
              [
                this.parent.loadArbitraryStatic(
                  0xffn,
                  UINT256_DATA_PT_TYPE,
                  'Masker for MSTORE8',
                ),
                originalDataPt,
              ],
              this.parent.placements.length,
            )
            this.parent.placeComposition(preparedComposition)
            dataPtToStore = preparedComposition.resultPts[0]!
          }
          const byteSize = op === 'MSTORE8' ? 1 : 32
          const _out = opts.memoryPt.write(offsetNum, byteSize, dataPtToStore)
          if ( bytesToBigInt(_out) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          } 
        }
        break
      case 'SLOAD': 
        {
          const keyPt = inPts[0]
          const addressPt = opts.thisContext.storageAddressPt
          this._assertStorageAddress(opts.thisAddress, addressPt)
          opts.stackPt.push(await this.loadStorage(
            addressPt,
            keyPt,
            out!,
          ))
        }
        break
      case 'SSTORE': 
        {
          const keyPt = inPts[0]
          const dataPt = inPts[1]
          const addressPt = opts.thisContext.storageAddressPt
          this._assertStorageAddress(opts.thisAddress, addressPt)
          await this.storeStorage(
            addressPt,
            keyPt,
            dataPt,
          )
          if ( dataPt.value !== ins[1] ) {
            throw new Error(`Synthesizer: ${op}: Output storage data mismatch`)
          } 
        }
        break
      case 'JUMP': 
      case 'JUMPI': 
        break
      case 'PC': 
      case 'MSIZE':
      case 'GAS':
        {
          const staticInDesc = `Static input for ${opts.op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth: ${opts.callDepth})`
          opts.stackPt.push(this.parent.loadArbitraryStatic(
            out!,
            UINT256_DATA_PT_TYPE,
            staticInDesc,
          ))
        }
        break
      case 'JUMPDEST': 
        break
      case 'MCOPY': 
        {
          const [dstOffset, srcOffset, length] = ins
          checkRequiredInput(opts.memOut)
          const preparedMemoryCopy = this._prepareMemoryCopy(
            opts.memoryPt,
            srcOffset,
            length,
            dstOffset,
            this.parent.placements.length,
          )
          for (const preparedComposition of preparedMemoryCopy.compositions) {
            this.parent.placeComposition(preparedComposition)
          }
          const _out = opts.memoryPt.writeBatch(preparedMemoryCopy.destinationEntries)
          if (bytesToBigInt(_out) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          }
        }
        break
      case 'CALL':
      case 'CALLCODE':
      case 'DELEGATECALL':
      case 'STATICCALL':
        // Only post-tasks after executing an interpreter call are listed here. See "preTasksForCalls" for the pre-tasks.
        {
          checkRequiredInput(opts.memOut)
          const toAddr = ins[1]
          const outOffset = op === 'DELEGATECALL' || op === 'STATICCALL' ? ins[4] : ins[5]
          const outLength = op === 'DELEGATECALL' || op === 'STATICCALL' ? ins[5] : ins[6]
          if (toAddr >= 1n && toAddr <= 10n) {
            throw new Error(
              `Synthesizer: Precompiles are not implemented in Synthesizer.`,
            )
          }
          const copiedLength = outLength < BigInt(opts.thisContext.returnDataByteLength)
            ? outLength
            : BigInt(opts.thisContext.returnDataByteLength)
          if (copiedLength !== BIGINT_0) {
            const preparedMemoryCopy = this._prepareMemoryCopy(
              MemoryPt.simulateMemoryPt(opts.thisContext.returnDataMemoryPts),
              0n,
              copiedLength,
              outOffset,
              this.parent.placements.length,
            )
            for (const preparedComposition of preparedMemoryCopy.compositions) {
              this.parent.placeComposition(preparedComposition)
            }
            opts.memoryPt.writeBatch(preparedMemoryCopy.destinationEntries)
          }
          const _out = opts.memoryPt.viewMemory(Number(outOffset), Number(outLength))
          if (bytesToBigInt(_out) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(
              `Synthesizer: ${op}: Return memory data mismatch`,
            )
          }
          opts.stackPt.push(this.parent.loadArbitraryStatic(
            out!,
            UINT256_DATA_PT_TYPE,
            `Call result of ${op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth: ${opts.callDepth})`,
          ))
        }
        break
      case 'RETURN':
      case 'REVERT':
        {
          checkRequiredInput(opts.memOut)
          const [offset, length] = ins;
          const preparedMemoryCopy = this._prepareMemoryCopy(
            opts.memoryPt,
            offset,
            length,
            0n,
            this.parent.placements.length,
          )
          for (const preparedComposition of preparedMemoryCopy.compositions) {
            this.parent.placeComposition(preparedComposition)
          }
          opts.thisContext.resultMemoryPts = preparedMemoryCopy.destinationEntries
          opts.thisContext.resultDataByteLength = Number(length)
          
          const simMemoryPt = MemoryPt.simulateMemoryPt(opts.thisContext.resultMemoryPts);
          const _out = simMemoryPt.viewMemory(0, Number(length));
          if (bytesToBigInt(_out) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(`Synthesizer: ${op}: Output memory data mismatch`)
          }
        }
        break
      default:
        throw new Error(`Synthesizer: ${op} is not implemented.`)
    }
    if (out === null) {
      if (opts.stackPt.length !== 0) {
        throw new Error(`Synthesizer: ${op}: Output data mismatch`)
      }
    } else {
      if (opts.stackPt.peek(1)[0].value !== out) {
        throw new Error(`Synthesizer: ${op}: Output data mismatch`)
      }
    }
  }

  private _prepareCodeMemoryPts(
    code: Uint8Array<ArrayBufferLike>,
    targetAddress: bigint,
    memOffset: bigint,
    codeOffset: bigint = 0n,
    dataLength: bigint = BigInt(code.byteLength),
  ): MemoryPts {
    // Copied from @ethereumjs/evm/src/opcdes/util.ts
    const getDataSlice = (data: Uint8Array, offset: bigint, length: bigint): Uint8Array => {
      const len = BigInt(data.length)
      if (offset > len) {
        offset = len
      }
      let end = offset + length
      if (end > len) {
        end = len
      }
      data = data.subarray(Number(offset), Number(end))
      // Right-pad with zeros to fill dataLength bytes
      data = setLengthRight(data, Number(length))
      return data
    }

    let memPts: MemoryPts = []
    const nChunks = Math.ceil(Number(dataLength) / 32)
    let accOffsetShift = 0n
    let lengthLeft = Number(dataLength)
    for (let i = 0; i < nChunks; i++){
      const sliceLength = Math.min(32, lengthLeft)
      const dataSlice = bytesToBigInt(getDataSlice(code, codeOffset + accOffsetShift, BigInt(sliceLength)))
      const desc = `Code of address: ${bigIntToHex(targetAddress)}, offset: ${Number(codeOffset)}, length: ${Number(dataLength)} bytes, chunk: ${i+1} out of ${nChunks}.`
      const dataPt = this.parent.loadArbitraryStatic(
        dataSlice,
        UINT256_DATA_PT_TYPE,
        desc,
      )
      memPts.push({
        memByteOffset: Number(memOffset + accOffsetShift),
        containerByteSize: sliceLength,
        dataPt
      })
      lengthLeft -= sliceLength
      accOffsetShift += BigInt(sliceLength)
    }
    
    return memPts
  }

  private _prepareMemoryLoadViewComposition(
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

    const composition = this.parent.subcircuitLibrary
      .placementCompositionManager.get('MemoryLoad')
    const step = composition.steps[0]
    if (step === undefined) {
      throw new Error('Synthesizer: MemoryLoad composition has no placement step')
    }
    const logicalInterface = this.parent.subcircuitLibrary.subcircuitInfoByName
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
    const [
      sourceWordType,
      shiftType,
      directionType,
      ownershipType,
      previousWordType,
      previousOwnershipType,
      coverageType,
      finalModeType,
    ] = inputTypes
    const [nextWordType, nextOwnershipType] = outputTypes
    if (
      sourceWordType === undefined
      || shiftType === undefined
      || directionType === undefined
      || ownershipType === undefined
      || previousWordType === undefined
      || previousOwnershipType === undefined
      || coverageType === undefined
      || finalModeType === undefined
      || nextWordType === undefined
      || nextOwnershipType === undefined
    ) {
      throw new Error(`Synthesizer: ${step.subcircuit} logical interface is incomplete`)
    }

    const dataAliasInfos = this._createDataAliasInfos(
      dataAliasGeometries,
      shiftType,
      directionType,
      ownershipType,
    )
    const expectedCoveragePt = this.parent.loadArbitraryStatic(
      dataAliasInfos.reduce(
        (coverage, { maskerPt }) => coverage | maskerPt.value,
        0n,
      ),
      coverageType,
      'Memory-load final byte ownership',
    )
    const zeroWordPt = this.parent.loadArbitraryStatic(
      0n,
      previousWordType,
      'Memory-load initial word',
    )
    const zeroOwnershipPt = this.parent.loadArbitraryStatic(
      0n,
      previousOwnershipType,
      'Memory-load initial byte ownership',
    )
    const operands: DataPt[] = []
    const steps: PreparedComposition['steps'][number][] = []
    let previousWordPt = zeroWordPt
    let previousOwnershipPt = zeroOwnershipPt

    for (const [stepIndex, info] of dataAliasInfos.entries()) {
      const isFinalStep = stepIndex === dataAliasInfos.length - 1
      const finalModePt = this.parent.loadArbitraryStatic(
        isFinalStep ? 1n : 0n,
        finalModeType,
        'Memory-load final-mode flag',
      )
      const nextWordValue = previousWordPt.value
        + info.maskedFragmentValue
      if (nextWordValue >= 1n << 256n) {
        throw new Error('Synthesizer: MemoryLoad fragment sum exceeds an EVM word')
      }
      const nextOwnershipValue = isFinalStep
        ? expectedCoveragePt.value
        : previousOwnershipPt.value + info.maskerPt.value
      const nextWordPt = DataPtFactory.create({
        source: basePlacementIndex + stepIndex,
        wireIndex: 0,
        dataPtType: nextWordType,
      }, nextWordValue)
      const nextOwnershipPt = DataPtFactory.create({
        source: basePlacementIndex + stepIndex,
        wireIndex: 1,
        dataPtType: nextOwnershipType,
      }, nextOwnershipValue)
      steps.push({
        inPts: [
          info.dataPt,
          info.shiftPt,
          info.directionPt,
          info.maskerPt,
          previousWordPt,
          previousOwnershipPt,
          expectedCoveragePt,
          finalModePt,
        ],
        outPts: [nextWordPt, nextOwnershipPt],
      })
      operands.push(info.dataPt, info.shiftPt, info.directionPt, info.maskerPt)
      previousWordPt = nextWordPt
      previousOwnershipPt = nextOwnershipPt
    }
    operands.push(expectedCoveragePt)

    const preparedComposition: PreparedComposition = {
      operation: 'MemoryLoad',
      operands,
      resultPts: [previousWordPt],
      steps,
    }
    return preparedComposition
  }

  private _createDataAliasInfos(
    dataAliasGeometries: DataAliasGeometries,
    shiftType: DataPt['dataPtType'],
    directionType: DataPt['dataPtType'],
    ownershipType: DataPt['dataPtType'],
  ): DataAliasInfos {
    return dataAliasGeometries.map((geometry) => {
      return Object.freeze({
        dataPt: geometry.dataPt,
        shiftPt: this.parent.loadArbitraryStatic(
          BigInt(geometry.shiftMagnitude),
          shiftType,
          'Memory-load byte shift magnitude',
        ),
        directionPt: this.parent.loadArbitraryStatic(
          BigInt(geometry.direction),
          directionType,
          'Memory-load shift direction',
        ),
        maskerPt: this.parent.loadArbitraryStatic(
          geometry.ownershipMask,
          ownershipType,
          'Memory-load byte ownership mask',
        ),
        maskedFragmentValue: geometry.maskedFragmentValue,
      })
    })
  }

  private _prepareMemoryCopy(
    sourceMemoryPt: MemoryPt,
    sourceOffset: bigint,
    length: bigint,
    destinationOffset: bigint = 0n,
    basePlacementIndex: number,
  ): PreparedMemoryCopy {
    if (length === BIGINT_0) {
      return { compositions: [], destinationEntries: [] }
    }
    const sourceOffsetNumber = Number(sourceOffset)
    const lengthNumber = Number(length)
    const sourceSnapshot = MemoryPt.simulateMemoryPt(
      sourceMemoryPt.read(sourceOffsetNumber, lengthNumber),
    )
    const preparedMemoryRead = this._prepareMemoryRead(
      sourceSnapshot,
      sourceOffset,
      length,
      basePlacementIndex,
    )
    const destinationEntries = preparedMemoryRead.viewDataPts.map((dataPt, index) => ({
      memByteOffset: Number(destinationOffset) + 32 * index,
      containerByteSize: Math.min(32, lengthNumber - 32 * index),
      dataPt,
    }))
    return {
      compositions: preparedMemoryRead.compositions,
      destinationEntries,
    }
  }

  private _prepareMemoryRead(
    memoryPt: MemoryPt,
    offset: bigint,
    length: bigint,
    basePlacementIndex: number,
  ): PreparedMemoryRead {
    const offsetNum = Number(offset);
    const lengthNum = Number(length);
    const nViews = lengthNum > 32 ? Math.ceil(lengthNum / 32) : 1;
  
    const viewDataPts: DataPt[] = [];
    const compositions: PreparedComposition[] = []
    let recoveredValue = 0n;
    let lengthLeft = lengthNum;
    let nextPlacementIndex = basePlacementIndex
  
    for (let i = 0; i < nViews; i++) {
      const _offset = offsetNum + 32 * i;
      const _length = lengthLeft > 32 ? 32 : lengthLeft;
      lengthLeft -= _length;
  
      const dataAliasInfos = memoryPt.getDataAlias(_offset, _length);
      if (dataAliasInfos.length > 0) {
        const preparedComposition = this._prepareMemoryLoadViewComposition(
          dataAliasInfos,
          _length,
          nextPlacementIndex,
        )
        compositions.push(preparedComposition)
        nextPlacementIndex += preparedComposition.steps.length
        viewDataPts[i] = preparedComposition.resultPts[0]!
      } else {
        viewDataPts[i] = this.parent.loadArbitraryStatic(
          0n,
          UINT256_DATA_PT_TYPE,
        );
      }
  
      recoveredValue += viewDataPts[i].value << BigInt(lengthLeft * 8);
    }
  
    return { compositions, viewDataPts, recoveredValue };
  }
}
