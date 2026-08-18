import { InterpreterStep, Message } from '@ethereumjs/evm';
import {
  BIGINT_0,
  bigIntToHex,
  bytesToBigInt,
  setLengthRight,
} from '@ethereumjs/util';
import { DataPtFactory } from '../dataStructure/dataPt.ts';
import { TRANSACTION_INPUT_VARIABLES } from '../../subcircuit/configuredTypes.ts';
import { MemoryPt, StackPt } from '../dataStructure/index.ts';
import {
  UINT32_DATA_PT_TYPE,
  UINT256_DATA_PT_TYPE,
} from '../types/index.ts';
import type {
  DataPt,
  MemoryPts,
  ReservedVariable,
  StorageCacheEntries,
  StorageCacheEntry,
} from '../types/index.ts';
import type { PlacementManager } from './placementManager.ts';

export type MemoryCopyPlan = Readonly<{
  operands: readonly (readonly DataPt[])[];
  destinations: readonly Readonly<{
    memByteOffset: number;
    containerByteSize: number;
  }>[];
}>;

export const createMemoryCopyEntries = (
  plan: MemoryCopyPlan,
  dataPts: readonly DataPt[],
): MemoryPts => {
  if (plan.destinations.length !== dataPts.length) {
    throw new Error('Synthesizer: MemoryView result count does not match its copy destinations')
  }
  return plan.destinations.map((destination, index) => ({
    ...destination,
    dataPt: dataPts[index]!,
  }))
}

const copyStorageCacheEntry = (entry: StorageCacheEntry): StorageCacheEntry => ({
  canonicalAddressPt: DataPtFactory.deepCopy(entry.canonicalAddressPt),
  canonicalKeyPt: DataPtFactory.deepCopy(entry.canonicalKeyPt),
  latestValuePt: DataPtFactory.deepCopy(entry.latestValuePt),
  dirty: entry.dirty,
});

const copyStorageCacheEntries = (entries: StorageCacheEntries): StorageCacheEntries => new Map(
  Array.from(entries, ([address, entriesByKey]) => [
    address,
    new Map(
      Array.from(entriesByKey, ([key, entry]) => [key, copyStorageCacheEntry(entry)]),
    ),
  ]),
);

export class StorageCache {
  private _entries: StorageCacheEntries = new Map()
  private _snapshotsByDepth: Map<number, StorageCacheEntries> = new Map()

  public get dirtyEntries(): StorageCacheEntry[] {
    return Array.from(this._entries.values()).flatMap((entriesByKey) =>
      Array.from(entriesByKey.values())
        .filter((entry) => entry.dirty)
        .map(copyStorageCacheEntry),
    )
  }

  public reset(): void {
    this._entries = new Map()
    this._snapshotsByDepth = new Map()
  }

  public beginFrame(depth: number): void {
    if (this._snapshotsByDepth.has(depth)) {
      throw new Error(`Synthesizer: Storage cache snapshot already exists at call depth ${depth}`)
    }
    this._snapshotsByDepth.set(depth, copyStorageCacheEntries(this._entries))
  }

  public completeFrame(depth: number, succeeded: boolean): void {
    const snapshot = this._snapshotsByDepth.get(depth)
    if (snapshot === undefined) {
      throw new Error(`Synthesizer: Storage cache snapshot is missing at call depth ${depth}`)
    }
    if (!succeeded) {
      this._entries = snapshot
    }
    this._snapshotsByDepth.delete(depth)
  }

  public get(address: bigint, key: bigint): StorageCacheEntry | undefined {
    const entry = this._entries.get(address)?.get(key)
    return entry === undefined ? undefined : copyStorageCacheEntry(entry)
  }

  public set(address: bigint, key: bigint, entry: StorageCacheEntry): void {
    if (entry.canonicalAddressPt.value !== address || entry.canonicalKeyPt.value !== key) {
      throw new Error('Synthesizer: Storage cache identity does not match its host lookup key')
    }
    const entriesByKey = this._entries.get(address) ?? new Map<bigint, StorageCacheEntry>()
    entriesByKey.set(key, copyStorageCacheEntry(entry))
    this._entries.set(address, entriesByKey)
  }
}

export type InitialStorageRead = {
  addressPt: DataPt;
  keyPt: DataPt;
  valuePt: DataPt;
}

const copyInitialStorageRead = (entry: InitialStorageRead): InitialStorageRead => ({
  addressPt: DataPtFactory.deepCopy(entry.addressPt),
  keyPt: DataPtFactory.deepCopy(entry.keyPt),
  valuePt: DataPtFactory.deepCopy(entry.valuePt),
});

export class InitialStorageReadList {
  private _entries: InitialStorageRead[] = []

  public get entries(): InitialStorageRead[] {
    return this._entries.map(copyInitialStorageRead)
  }

  public reset(): void {
    this._entries = []
  }

  public get(address: bigint, key: bigint): InitialStorageRead | undefined {
    const entry = this._entries.find(
      (candidate) => candidate.addressPt.value === address && candidate.keyPt.value === key,
    )
    return entry === undefined ? undefined : copyInitialStorageRead(entry)
  }

  public add(address: bigint, key: bigint, entry: InitialStorageRead): void {
    if (entry.addressPt.value !== address || entry.keyPt.value !== key) {
      throw new Error('Synthesizer: Initial SLOAD identity does not match its host lookup key')
    }
    if (this.get(address, key) !== undefined) {
      throw new Error('Synthesizer: Initial SLOAD already exists for this storage location')
    }
    this._entries.push(copyInitialStorageRead(entry))
  }
}

export type MessageContext = {
  messageContextIdentity: number;
  codeContextIdentity: number;
  returnDataRevision: number;
  stackPt: StackPt;
  memoryPt: MemoryPt;
  callerPt: DataPt;
  codeAddressPt: DataPt;
  storageAddressPt: DataPt;
  returnDataMemoryPts: MemoryPts;
  returnDataByteLength: number;
  callDataMemoryPts: MemoryPts;
  callDataByteLength: number;
  prevInterpreterStep: InterpreterStep | null;
  resultMemoryPts: MemoryPts;
  resultDataByteLength: number;
}

export class LogCache {
  private _snapshotsByDepth: Map<number, number> = new Map()

  public reset(): void {
    this._snapshotsByDepth = new Map()
  }

  public beginFrame(depth: number, logOutLength: number): void {
    if (this._snapshotsByDepth.has(depth)) {
      throw new Error(`Synthesizer: LOG_OUT snapshot already exists at call depth ${depth}`)
    }
    this._snapshotsByDepth.set(depth, logOutLength)
  }

  public getFrameLength(depth: number): number {
    const logOutLength = this._snapshotsByDepth.get(depth)
    if (logOutLength === undefined) {
      throw new Error(`Synthesizer: LOG_OUT snapshot is missing at call depth ${depth}`)
    }
    return logOutLength
  }

  public completeFrame(depth: number): void {
    this.getFrameLength(depth)
    this._snapshotsByDepth.delete(depth)
  }
}

export class ContextManager {
  public readonly logCache = new LogCache()
  public readonly storageCache = new StorageCache()
  public readonly initialStorageReads = new InitialStorageReadList()
  public cachedOrigin: DataPt | undefined = undefined
  public contextByDepth: MessageContext[] = []
  private _messageCodeAddresses = new Set<string>()
  private _verifiedContractAddressPt: DataPt | undefined
  private _verifiedFunctionSelectorPt: DataPt | undefined
  private _verifiedTransactionInputPts: DataPt[] = []
  private _nextMessageContextIdentity = 0
  private _nextCodeContextIdentity = 0
  private _transactionIdentity = 0
  private _balanceRevision = 0
  private _codeContextIdentityByAddress = new Map<string, number>()

  constructor(private readonly placementManager: PlacementManager) {}

  public setVerifiedTransactionData(
    contractAddressPt: DataPt,
    functionSelectorPt: DataPt,
    originPt: DataPt,
    transactionInputPts: readonly DataPt[],
  ): void {
    if (transactionInputPts.length !== TRANSACTION_INPUT_VARIABLES.length) {
      throw new Error('Synthesizer: verified transaction input count is invalid')
    }
    this._verifiedContractAddressPt = DataPtFactory.deepCopy(contractAddressPt)
    this._verifiedFunctionSelectorPt = DataPtFactory.deepCopy(functionSelectorPt)
    this.cachedOrigin = DataPtFactory.deepCopy(originPt)
    this._verifiedTransactionInputPts = transactionInputPts.map((dataPt) =>
      DataPtFactory.deepCopy(dataPt),
    )
  }

  public prepareCodeMemoryEntries(
    code: Uint8Array<ArrayBufferLike>,
    targetAddress: bigint,
    memOffset: bigint,
    codeOffset: bigint = 0n,
    dataLength: bigint = BigInt(code.byteLength),
    codeSource: 'current-code' | 'external-code',
  ): MemoryPts {
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
      return setLengthRight(data, Number(length))
    }

    const memPts: MemoryPts = []
    const cachePolicy = codeSource === 'current-code'
      ? { kind: 'topology-fixed' as const, usage: 'codecopy-current-code-chunk' as const }
      : { kind: 'uncached' as const }
    const nChunks = Math.ceil(Number(dataLength) / 32)
    let accOffsetShift = 0n
    let lengthLeft = Number(dataLength)
    for (let i = 0; i < nChunks; i++) {
      const sliceLength = Math.min(32, lengthLeft)
      const dataSlice = bytesToBigInt(
        getDataSlice(code, codeOffset + accOffsetShift, BigInt(sliceLength)),
      )
      const desc = `Code of address: ${bigIntToHex(targetAddress)}, offset: ${Number(codeOffset)}, length: ${Number(dataLength)} bytes, chunk: ${i + 1} out of ${nChunks}.`
      const dataPt = this.placementManager.loadArbitraryStatic(
        dataSlice,
        UINT256_DATA_PT_TYPE,
        desc,
        cachePolicy,
      )
      memPts.push({
        memByteOffset: Number(memOffset + accOffsetShift),
        containerByteSize: sliceLength,
        dataPt,
      })
      lengthLeft -= sliceLength
      accOffsetShift += BigInt(sliceLength)
    }
    return memPts
  }

  public prepareMemoryCopy(
    sourceMemoryPt: MemoryPt,
    sourceOffset: bigint,
    length: bigint,
    destinationOffset: bigint = 0n,
  ): MemoryCopyPlan {
    if (length === BIGINT_0) {
      return { operands: [], destinations: [] }
    }
    const sourceOffsetNumber = Number(sourceOffset)
    const lengthNumber = Number(length)
    const sourceSnapshot = MemoryPt.simulateMemoryPt(
      sourceMemoryPt.read(sourceOffsetNumber, lengthNumber),
    )
    const operands = this.materializeMemoryViewOperands(
      sourceSnapshot,
      sourceOffset,
      length,
    )
    const destinations = operands.map((_, index) => ({
      memByteOffset: Number(destinationOffset) + 32 * index,
      containerByteSize: Math.min(32, lengthNumber - 32 * index),
    }))
    return { operands, destinations }
  }

  public materializeMemoryViewOperands(
    memoryPt: MemoryPt,
    offset: bigint,
    length: bigint,
  ): readonly (readonly DataPt[])[] {
    const offsetNum = Number(offset)
    const lengthNum = Number(length)
    if (lengthNum === 0) {
      return []
    }
    const nViews = Math.ceil(lengthNum / 32)
    const views: DataPt[][] = []
    let lengthLeft = lengthNum

    for (let i = 0; i < nViews; i++) {
      const viewOffset = offsetNum + 32 * i
      const viewLength = lengthLeft > 32 ? 32 : lengthLeft
      lengthLeft -= viewLength
      const dataAliasGeometries = memoryPt.getDataAlias(viewOffset, viewLength)
      if (dataAliasGeometries.length === 0) {
        views.push([])
        continue
      }
      const viewOperands: DataPt[] = []
      for (const geometry of dataAliasGeometries) {
        const encodedShiftPt = this.placementManager.loadArbitraryStatic(
          BigInt(geometry.shiftMagnitude + 32 * geometry.direction),
          UINT32_DATA_PT_TYPE,
          'Memory view encoded shift',
          { kind: 'topology-fixed', usage: 'memory-view-encoded-shift' },
        )
        const ownershipPt = this.placementManager.loadArbitraryStatic(
          geometry.ownershipMask,
          UINT32_DATA_PT_TYPE,
          'Memory view ownership mask',
          { kind: 'topology-fixed', usage: 'memory-view-ownership-mask' },
        )
        viewOperands.push(geometry.dataPt, encodedShiftPt, ownershipPt)
      }
      views.push(viewOperands)
    }
    return views
  }

  public materializeMessageContext(message: Message): void {
    this.recordMessageCodeAddress(message.codeAddress.toString())
    if (message.isCreate) {
      throw new Error('CREATE is not supported.')
    }
    if (message.isCompiled) {
      throw new Error('Precompiled functions are not supported.')
    }

    const depth = message.depth
    if (depth > 0) {
      this._balanceRevision += 1
    }
    let callDataMemoryPts: MemoryPts
    let callerPt: DataPt
    let codeAddressPt: DataPt
    let storageAddressPt: DataPt
    let callDataByteLength: number

    if (depth === 0) {
      const selectorPt = this._verifiedFunctionSelectorPt
      const verifiedContractAddressPt = this._verifiedContractAddressPt
      if (
        selectorPt === undefined
        || verifiedContractAddressPt === undefined
        || this.cachedOrigin === undefined
        || this._verifiedTransactionInputPts.length !== TRANSACTION_INPUT_VARIABLES.length
      ) {
        throw new Error('Synthesizer: verified transaction data is unavailable')
      }
      callDataMemoryPts = [
        { memByteOffset: 0, containerByteSize: 4, dataPt: selectorPt },
        ...this._verifiedTransactionInputPts.map((dataPt, index) => ({
          memByteOffset: 4 + 32 * index,
          containerByteSize: 32,
          dataPt,
        })),
      ]
      callDataByteLength = message.data.length
      callerPt = DataPtFactory.deepCopy(this.cachedOrigin)
      codeAddressPt = DataPtFactory.deepCopy(verifiedContractAddressPt)
      storageAddressPt = DataPtFactory.deepCopy(verifiedContractAddressPt)
    } else if (depth > 0) {
      const parentContext = this.contextByDepth[depth - 1]
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
      codeAddressPt = rawCodeAddressPt
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

      const memoryCopyPlan = this.prepareMemoryCopy(
        parentContext.memoryPt,
        inputOffset,
        inputLength,
        0n,
      )
      const callDataPts = this.placementManager.placeComposition(
        'MemoryView',
        memoryCopyPlan.operands,
      )
      callDataMemoryPts = createMemoryCopyEntries(memoryCopyPlan, callDataPts)
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

    const context: MessageContext = {
      messageContextIdentity: this._nextMessageContextIdentity++,
      codeContextIdentity: this._getCodeContextIdentity(message.codeAddress.toString()),
      returnDataRevision: 0,
      stackPt: new StackPt(),
      memoryPt: new MemoryPt(),
      callDataMemoryPts,
      callDataByteLength,
      callerPt,
      codeAddressPt,
      storageAddressPt,
      returnDataMemoryPts: [],
      returnDataByteLength: 0,
      prevInterpreterStep: null,
      resultMemoryPts: [],
      resultDataByteLength: 0,
    }
    this.beginFrame(depth)
    this.contextByDepth[depth] = context
  }

  public returnMessageCall(depth: number): void {
    if (depth === 0) {
      return
    }
    const parentContext = this.contextByDepth[depth - 1]
    const childContext = this.contextByDepth[depth]
    if (parentContext === undefined || childContext === undefined) {
      throw new Error('Synthesizer: message return context is unavailable')
    }
    parentContext.returnDataMemoryPts = childContext.resultMemoryPts.map((entry) => ({
      ...entry,
      dataPt: DataPtFactory.deepCopy(entry.dataPt),
    }))
    parentContext.returnDataByteLength = childContext.resultDataByteLength
    parentContext.returnDataRevision += 1
  }

  public get messageCodeAddresses(): readonly string[] {
    return Array.from(this._messageCodeAddresses)
  }

  public recordMessageCodeAddress(codeAddress: string): void {
    this._messageCodeAddresses.add(codeAddress)
  }

  public resetTransactionTracking(): void {
    this.storageCache.reset()
    this.initialStorageReads.reset()
    this.logCache.reset()
    this.cachedOrigin = undefined
    this._verifiedContractAddressPt = undefined
    this._verifiedFunctionSelectorPt = undefined
    this._verifiedTransactionInputPts = []
    this._messageCodeAddresses.clear()
    this._transactionIdentity += 1
  }

  private _getCodeContextIdentity(codeAddress: string): number {
    const existing = this._codeContextIdentityByAddress.get(codeAddress)
    if (existing !== undefined) {
      return existing
    }
    const identity = this._nextCodeContextIdentity++
    this._codeContextIdentityByAddress.set(codeAddress, identity)
    return identity
  }

  public beginFrame(depth: number): void {
    this.storageCache.beginFrame(depth)
    this.logCache.beginFrame(depth, this.placementManager.getLogOutWireLength())
  }

  public completeFrame(depth: number, succeeded: boolean): void {
    const logOutLength = this.logCache.getFrameLength(depth)
    const currentLogOutLength = this.placementManager.getLogOutWireLength()
    if (currentLogOutLength < logOutLength) {
      throw new Error('Synthesizer: LOG_OUT buffer is inconsistent with its frame snapshot')
    }
    if (!succeeded) {
      this.placementManager.truncateLogOut(logOutLength)
    }
    this.logCache.completeFrame(depth)
    this.storageCache.completeFrame(depth, succeeded)
  }
}
