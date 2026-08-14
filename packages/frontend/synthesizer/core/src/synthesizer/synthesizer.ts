import { createVM, runTx, RunTxOpts, RunTxResult, VM, VMOpts } from '@ethereumjs/vm';

import { BlockData, BlockOptions, createBlock, HeaderData } from '@ethereumjs/block';
import { bigIntToBytes, bigIntToHex, bytesToHex, createAddressFromBigInt, setLengthLeft } from '@ethereumjs/util';

import { EVMResult, InterpreterStep } from '@ethereumjs/evm';
import { TRANSACTION_INPUT_VARIABLES } from '../subcircuit/configuredTypes.ts';
import {
  Placements,
  type ReservedVariable,
  SynthesizerInterface,
  SynthesizerOpts,
  SynthesizerStepLogEntry,
} from './types/index.ts';
import { ContextManager, InstructionHandler, PlacementManager } from './handlers/index.ts';
import type { ResolvedSubcircuitLibrary } from '../subcircuit/libraryTypes.ts';
import { TypedTransaction } from '@ethereumjs/tx';

/**
 * The Synthesizer class manages data related to subcircuits.
 * It acts as a facade, delegating tasks to various handler classes.
 */
export class Synthesizer implements SynthesizerInterface
{
  private _contextManager: ContextManager
  private _placementManager: PlacementManager
  protected _instructionHandlers: InstructionHandler
  private readonly _cachedOpts: SynthesizerOpts
  public readonly subcircuitLibrary: ResolvedSubcircuitLibrary
  private _eventHandlerError: unknown
  private _hasEventHandlerError: boolean
  private _stepLogs: SynthesizerStepLogEntry[]

  constructor(opts: SynthesizerOpts, subcircuitLibrary: ResolvedSubcircuitLibrary) {
    this._cachedOpts = opts
    this.subcircuitLibrary = subcircuitLibrary
    this._placementManager = new PlacementManager(this.subcircuitLibrary, this._cachedOpts)
    this._contextManager = new ContextManager(this._placementManager)
    this._instructionHandlers = new InstructionHandler(
      this._contextManager,
      this._placementManager,
      this.subcircuitLibrary,
      this._cachedOpts,
    )
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
          this._contextManager.initializeMessageContext(data);
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
          this._contextManager.returnMessageCall(stepData.depth);
          this._contextManager.completeFrame(
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
    this._contextManager.resetTransactionTracking()
    const transactionInputPts = TRANSACTION_INPUT_VARIABLES.map((variable) =>
      this._placementManager.getReservedVariableFromBuffer(variable),
    )
    const operands = [
      this._placementManager.getReservedVariableFromBuffer('EDDSA_RANDOMIZER_X'),
      this._placementManager.getReservedVariableFromBuffer('EDDSA_RANDOMIZER_Y'),
      this._placementManager.getReservedVariableFromBuffer('EDDSA_PUBLIC_KEY_X'),
      this._placementManager.getReservedVariableFromBuffer('EDDSA_PUBLIC_KEY_Y'),
      this._placementManager.getReservedVariableFromBuffer('TRANSACTION_NONCE'),
      ...transactionInputPts,
      this._placementManager.getReservedVariableFromBuffer('CONTRACT_ADDRESS'),
      this._placementManager.getReservedVariableFromBuffer('FUNCTION_SELECTOR'),
      this._placementManager.getReservedVariableFromBuffer('EDDSA_SIGNATURE'),
      this._placementManager.getReservedVariableFromBuffer('JUBJUB_POI_X'),
      this._placementManager.getReservedVariableFromBuffer('JUBJUB_POI_Y'),
    ]
    const verifiedTransactionPts = this._placementManager.placeComposition(
      'TransactionSignatureVerify',
      operands,
    )
    const verifiedContractAddressPt = verifiedTransactionPts[0]
    const verifiedFunctionSelectorPt = verifiedTransactionPts[1]
    const verifiedOriginPt = verifiedTransactionPts[2]
    if (
      verifiedContractAddressPt === undefined
      || verifiedFunctionSelectorPt === undefined
      || verifiedOriginPt === undefined
    ) {
      throw new Error('Synthesizer: TransactionSignatureVerify returned incomplete results')
    }

    const zeroFrPt = this._placementManager.getReservedVariableFromBuffer('CIRCOM_CONST_ZERO')
    const convertedTransactionInputPts = []
    for (let inputIndex = 0; inputIndex < transactionInputPts.length; inputIndex += 2) {
      const convertedPair = this._placementManager.placeComposition(
        'FrToLimbsPair',
        [transactionInputPts[inputIndex]!, transactionInputPts[inputIndex + 1] ?? zeroFrPt],
      )
      convertedTransactionInputPts.push(convertedPair[0]!)
      if (inputIndex + 1 < transactionInputPts.length) {
        convertedTransactionInputPts.push(convertedPair[1]!)
      }
    }
    this._contextManager.setVerifiedTransactionData(
      verifiedContractAddressPt,
      verifiedFunctionSelectorPt,
      verifiedOriginPt,
      convertedTransactionInputPts,
    )
  }

  private _finalizeStorageStore(): void {
    for (const entry of this._contextManager.storageCache.dirtyEntries) {
      this._placementManager.addReservedVariableToBufferOut('SSTORE_ADDRESS', entry.canonicalAddressPt, true)
      this._placementManager.addReservedVariableToBufferOut('SSTORE_KEY', entry.canonicalKeyPt, true)
      this._placementManager.addReservedVariableToBufferOut('SSTORE_VALUE', entry.latestValuePt, true)
    }
  }

  public async synthesizeTX(): Promise<RunTxResult> {
    const common = this._cachedOpts.stateManager.common;
    this._eventHandlerError = undefined
    this._hasEventHandlerError = false
    this._stepLogs = []

    const headerData: HeaderData = {
      parentHash: setLengthLeft(
        bigIntToBytes(this._placementManager.getReservedVariableFromBuffer('BLOCKHASH_1').value),
        32,
      ),
      coinbase: createAddressFromBigInt(this._placementManager.getReservedVariableFromBuffer('COINBASE').value),
      // difficulty = 0 for PoS blocks
      difficulty: 0n,
      number: this._placementManager.getReservedVariableFromBuffer('NUMBER').value,
      gasLimit: this._placementManager.getReservedVariableFromBuffer('GASLIMIT').value,
      timestamp: this._placementManager.getReservedVariableFromBuffer('TIMESTAMP').value,

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
    const thisContext = this._contextManager.contextByDepth[stepResult.depth];
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
    return this._contextManager.messageCodeAddresses
  }

  public get placements(): Placements {
    return this._placementManager.placements
  }

}
