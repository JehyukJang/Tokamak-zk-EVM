
import { BIT_DATA_PT_TYPE, MemoryPts, synthesizerOpcodeByName, SynthesizerOpts, SynthesizerSupportedArithOpcodes, SynthesizerSupportedBlkInfOpcodes, SynthesizerSupportedEnvInfOpcodes, SynthesizerSupportedLogOpcodes, SynthesizerSupportedSysFlowOpcodes, type DataPt, type ReservedVariable, type SynthesizerSupportedOpcodes, UINT256_DATA_PT_TYPE } from '../types/index.ts';

import {
  Address,
  BIGINT_0,
  bytesToBigInt,
  createAddressFromBigInt,
  setLengthLeft,
  bigIntToBytes,
} from '@ethereumjs/util'
import { InterpreterStep } from '@ethereumjs/evm'
import { DataPtFactory, MemoryPt, StackPt } from '../dataStructure/index.ts';
import type { PlacementManager } from './placementManager.ts';
import {
  createMemoryCopyEntries,
  type ContextManager,
  type MessageContext,
} from './contextManager.ts';
import type { ResolvedSubcircuitLibrary } from '../../subcircuit/libraryTypes.ts';

export interface HandlerOpts {
  op: SynthesizerSupportedOpcodes,
  pc: bigint,
  thisAddress: Address,
  codeAddress: Address,
  originAddress: Address,
  callerAddress: Address,
  callDepth: number,
  thisContext: MessageContext,
  prevStepResult: InterpreterStep,
  stackPt: StackPt,
  memoryPt: MemoryPt,
  memOut?: Uint8Array,
}

export interface SynthesizerOpHandler {
  (context: MessageContext, stepResult: InterpreterStep): void | Promise<void>
}

const checkRequiredInput = (...input: unknown[]): void => {
  if (input.some(v => v === undefined)) throw new Error('Required inputs are missing')
}

const recoverMemoryValue = (
  viewDataPts: readonly DataPt[],
  byteLength: bigint,
): bigint => {
  let value = 0n
  let lengthLeft = Number(byteLength)
  for (const viewDataPt of viewDataPts) {
    lengthLeft -= Math.min(32, lengthLeft)
    value += viewDataPt.value << BigInt(lengthLeft * 8)
  }
  return value
}

export class InstructionHandler {
  public synthesizerHandlers!: Map<number, SynthesizerOpHandler>
  constructor(
    private readonly contextManager: ContextManager,
    private readonly placementManager: PlacementManager,
    private readonly subcircuitLibrary: ResolvedSubcircuitLibrary,
    private readonly cachedOpts: SynthesizerOpts,
  ) {
    this._createSynthesizerHandlers()
  }

  private _createHandlerOpts(opName: SynthesizerSupportedOpcodes, context: MessageContext): HandlerOpts {
    const prevStepResult = context.prevInterpreterStep;
    if (prevStepResult === null) {
      throw new Error('Debug: previous interpreter step is not set')
    }
    const depth = prevStepResult.depth;
    const callerAddr = context.callerPt.value;
    const originAddr = this.contextManager.cachedOrigin?.value
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
        opts.stackPt.push(this.placementManager.loadArbitraryStatic(
          out,
          UINT256_DATA_PT_TYPE,
          staticInDesc,
          { kind: 'topology-fixed', usage: 'push-immediate' },
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
    this.placementManager.placeComposition('StorageAccess', inPts)
  }

  private _getCachedStorageEntry(
    addressValue: bigint,
    keyValue: bigint,
    addressPt: DataPt,
    keyPt: DataPt,
  ) {
    // The cache-entry and retained-initial-read branches are mutually exclusive,
    // so each lookup places StorageAccess at most once.
    const cachedEntry = this.contextManager.storageCache.get(addressValue, keyValue)
    if (cachedEntry !== undefined) {
      this._constrainStorageLocationEquality(
        addressPt,
        keyPt,
        cachedEntry.canonicalAddressPt,
        cachedEntry.canonicalKeyPt,
      )
      return cachedEntry
    }

    const initialRead = this.contextManager.initialStorageReads.get(addressValue, keyValue)
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
      this.contextManager.storageCache.set(addressValue, keyValue, cachedEntry)
      return DataPtFactory.deepCopy(cachedEntry.latestValuePt)
    }

    this.placementManager.addReservedVariableToBufferOut(
      'SLOAD_ADDRESS',
      addressPt,
      true,
      ` of address: ${address}`,
    );
    this.placementManager.addReservedVariableToBufferOut(
      'SLOAD_KEY',
      keyPt,
      true,
      ` of address: ${address}`,
    );
    const valuePt = this.placementManager.addReservedVariableToBufferIn(
      'STORAGE_READ',
      valueStored,
      true,
      ` of address: ${address}`,
    );
    this.placementManager.addReservedVariableToBufferOut(
      'SLOAD_VALUE',
      valuePt,
      true,
      ` of address: ${address}`,
    );
    const initialRead = {
      addressPt: DataPtFactory.deepCopy(addressPt),
      keyPt: DataPtFactory.deepCopy(keyPt),
      valuePt: DataPtFactory.deepCopy(valuePt),
    }
    this.contextManager.initialStorageReads.add(addressValue, keyValue, initialRead)
    this.contextManager.storageCache.set(addressValue, keyValue, {
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
    this.contextManager.storageCache.set(addressValue, keyValue, {
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
    const op = opts.op as SynthesizerSupportedArithOpcodes
    let outPts: readonly DataPt[]
    switch (op) {
      case 'KECCAK256': {
          checkRequiredInput(opts.memOut)
          const memOffset = ins[0]
          const dataLength = ins[1]
          const memoryOperands = this.contextManager.materializeMemoryViewOperands(
            opts.memoryPt,
            memOffset,
            dataLength,
          )
          const viewDataPts = this.placementManager.placeComposition('MemoryView', memoryOperands)
          const recoveredValue = recoverMemoryValue(viewDataPts, dataLength)
          if (bytesToBigInt(opts.memOut!) !== recoveredValue) {
            throw new Error(`Synthesizer: ${op}: Memory data to load mismatch`)
          }
          outPts = this.placementManager.placeComposition('Poseidon', viewDataPts)
        }
        break
      default:
        outPts = this.placementManager.placeComposition(op, inPts)
        break;
    }
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
        dataPt = this.placementManager.getReservedVariableFromBuffer(op)
        break
      }
      case 'BLOCKHASH': {
        const blockNumber = inVal;
        if (blockNumber === undefined) {
          throw new Error('Debug: BLOCKHASH requires an input block number')
        }
        this._popStackPtAndCheckInputConsistency(opts.stackPt, [blockNumber]);
        const blockNumberDiff = this.placementManager.getReservedVariableFromBuffer('NUMBER').value - blockNumber;
        if (blockNumberDiff <= 0n || blockNumberDiff > 256n) {
          dataPt = this.placementManager.getReservedVariableFromBuffer('EVM_CONST_ZERO')
          break
        }
        if (blockNumberDiff > BigInt(this.subcircuitLibrary.numberOfPrevBlockHashes)) {
          throw new Error(
            `Synthesizer: BLOCKHASH requires ${blockNumberDiff.toString()} previous block hashes, but qap-compiler nPrevBlockHashes is ${this.subcircuitLibrary.numberOfPrevBlockHashes}. Increase qap-compiler nPrevBlockHashes.`,
          )
        }
        dataPt = this.placementManager.getReservedVariableFromBuffer(`BLOCKHASH_${blockNumberDiff}` as ReservedVariable)
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
      const dataPt = this.contextManager.cachedOrigin
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
    const inPts = this._popStackPtAndCheckInputConsistency(opts.stackPt, ins)
    const op = opts.op as SynthesizerSupportedEnvInfOpcodes
    const staticInDesc = `Static input for ${opts.op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth : ${opts.callDepth})`
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
          stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
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
        stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
        break
      case 'CALLDATALOAD': 
        {
          const srcOffset = ins[0]
          const i = Number(srcOffset);
          const calldataMemoryPts = opts.thisContext.callDataMemoryPts;
          const calldataMemoryPt = MemoryPt.simulateMemoryPt(calldataMemoryPts)
          const memoryOperands = this.contextManager.materializeMemoryViewOperands(
            calldataMemoryPt,
            BigInt(i),
            32n,
          )
          const dataPt = this.placementManager.placeComposition('MemoryView', memoryOperands)[0]
          if (dataPt === undefined) {
            throw new Error('Synthesizer: CALLDATALOAD produced no result')
          }
          stackPt.push(dataPt)
        }
        break
      case 'CALLDATASIZE':
        stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
        break
      case 'CALLDATACOPY':
        {
          const memOffset = ins[0]
          const dataOffset = ins[1]
          const dataLength = ins[2]
          checkRequiredInput(opts.memOut)
          if (dataLength !== BIGINT_0) {
            const memoryCopyPlan = this.contextManager.prepareMemoryCopy(
              MemoryPt.simulateMemoryPt(opts.thisContext.callDataMemoryPts),
              dataOffset,
              dataLength,
              memOffset,
            )
            const resultPts = this.placementManager.placeComposition(
              'MemoryView',
              memoryCopyPlan.operands,
            )
            memoryPt.writeBatch(createMemoryCopyEntries(memoryCopyPlan, resultPts))
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
        stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
        break
      case 'CODECOPY':
        {
          const memOffset = ins[0]
          const dataLength = ins[2]
          checkRequiredInput(opts.memOut)
          const thisAddress = opts.thisAddress ?? this.cachedOpts.signedTransaction.to
          if (dataLength !== BIGINT_0) {
            const memPts: MemoryPts = this.contextManager.prepareCodeMemoryEntries(
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
        stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
      break
      case 'EXTCODESIZE': 
        {
          stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
        }
        break
      case 'EXTCODECOPY':
        {
          const addressBigInt = ins[0]
          const memOffset = ins[1]
          const dataLength = ins[3]
          checkRequiredInput(opts.memOut)
          if (dataLength !== BIGINT_0) {
            const memPts: MemoryPts = this.contextManager.prepareCodeMemoryEntries(
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
        stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
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
            const memoryCopyPlan = this.contextManager.prepareMemoryCopy(
              MemoryPt.simulateMemoryPt(opts.thisContext.returnDataMemoryPts),
              returnDataOffset,
              dataLength,
              memOffset,
            )
            const resultPts = this.placementManager.placeComposition(
              'MemoryView',
              memoryCopyPlan.operands,
            )
            memoryPt.writeBatch(createMemoryCopyEntries(memoryCopyPlan, resultPts))
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
          stackPt.push(this.placementManager.loadArbitraryStatic(out!, UINT256_DATA_PT_TYPE, staticInDesc, { kind: 'uncached' }))
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
      this.placementManager.addReservedVariableToBufferOut(
        'LOG_TOPIC',
        topicPt,
        true,
        ` for ${op} instruction, topic index: ${index}`,
      )
    }

    const memoryOperands = this.contextManager.materializeMemoryViewOperands(
      opts.memoryPt,
      memOffset,
      dataLength,
    )
    const viewDataPts = this.placementManager.placeComposition('MemoryView', memoryOperands)
    const recoveredValue = recoverMemoryValue(viewDataPts, dataLength)
    const expectedLogData = bytesToBigInt(
      opts.prevStepResult.memory.subarray(Number(memOffset), Number(memOffset) + Number(dataLength)),
    )
    if (recoveredValue !== expectedLogData) {
      throw new Error(`Synthesizer: ${op}: Log data mismatch`)
    }

    for (const [index, viewDataPt] of viewDataPts.entries()) {
      this.placementManager.addReservedVariableToBufferOut(
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
          const memoryOperands = this.contextManager.materializeMemoryViewOperands(
            opts.memoryPt,
            pos,
            32n,
          )
          const mutDataPt = this.placementManager.placeComposition('MemoryView', memoryOperands)[0]
          if (mutDataPt === undefined) {
            throw new Error('Synthesizer: MLOAD produced no result')
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
          const byteSize = op === 'MSTORE8' ? 1 : 32
          const _out = opts.memoryPt.write(offsetNum, byteSize, originalDataPt)
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
        {
          const staticInDesc = `Static input for ${opts.op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth: ${opts.callDepth})`
          opts.stackPt.push(this.placementManager.loadArbitraryStatic(
            out!,
            UINT256_DATA_PT_TYPE,
            staticInDesc,
            { kind: 'uncached' },
          ))
        }
        break
      case 'MSIZE':
        {
          const staticInDesc = `Static input for ${opts.op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth: ${opts.callDepth})`
          opts.stackPt.push(this.placementManager.loadArbitraryStatic(
            out!,
            UINT256_DATA_PT_TYPE,
            staticInDesc,
            { kind: 'uncached' },
          ))
        }
        break
      case 'GAS':
        {
          const staticInDesc = `Static input for ${opts.op} instruction at PC ${opts.pc} of code address ${opts.codeAddress} (depth: ${opts.callDepth})`
          opts.stackPt.push(this.placementManager.loadArbitraryStatic(
            out!,
            UINT256_DATA_PT_TYPE,
            staticInDesc,
            { kind: 'uncached' },
          ))
        }
        break
      case 'JUMPDEST': 
        break
      case 'MCOPY': 
        {
          const [dstOffset, srcOffset, length] = ins
          checkRequiredInput(opts.memOut)
          const memoryCopyPlan = this.contextManager.prepareMemoryCopy(
            opts.memoryPt,
            srcOffset,
            length,
            dstOffset,
          )
          const resultPts = this.placementManager.placeComposition(
            'MemoryView',
            memoryCopyPlan.operands,
          )
          const _out = opts.memoryPt.writeBatch(createMemoryCopyEntries(memoryCopyPlan, resultPts))
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
            const memoryCopyPlan = this.contextManager.prepareMemoryCopy(
              MemoryPt.simulateMemoryPt(opts.thisContext.returnDataMemoryPts),
              0n,
              copiedLength,
              outOffset,
            )
            const resultPts = this.placementManager.placeComposition(
              'MemoryView',
              memoryCopyPlan.operands,
            )
            opts.memoryPt.writeBatch(createMemoryCopyEntries(memoryCopyPlan, resultPts))
          }
          const _out = opts.memoryPt.viewMemory(Number(outOffset), Number(outLength))
          if (bytesToBigInt(_out) !== bytesToBigInt(opts.memOut!)) {
            throw new Error(
              `Synthesizer: ${op}: Return memory data mismatch`,
            )
          }
          opts.stackPt.push(this.placementManager.getReservedVariableFromBuffer(
            out === 0n ? 'EVM_CONST_ZERO' : 'EVM_CONST_ONE',
          ))
        }
        break
      case 'RETURN':
      case 'REVERT':
        {
          checkRequiredInput(opts.memOut)
          const [offset, length] = ins;
          const memoryCopyPlan = this.contextManager.prepareMemoryCopy(
            opts.memoryPt,
            offset,
            length,
            0n,
          )
          const resultPts = this.placementManager.placeComposition(
            'MemoryView',
            memoryCopyPlan.operands,
          )
          opts.thisContext.resultMemoryPts = createMemoryCopyEntries(memoryCopyPlan, resultPts)
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

}
