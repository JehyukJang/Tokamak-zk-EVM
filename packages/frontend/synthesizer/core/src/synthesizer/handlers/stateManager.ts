import { InterpreterStep } from '@ethereumjs/evm';

import { DataPtFactory } from '../dataStructure/dataPt.ts';
import { MemoryPt, StackPt } from '../dataStructure/index.ts';
import type { DataPt, MemoryPts } from '../types/index.ts';
import type { PlacementManager } from './placementManager.ts';

export type StorageCacheEntry = {
  canonicalAddressPt: DataPt;
  canonicalKeyPt: DataPt;
  latestValuePt: DataPt;
  dirty: boolean;
}

type StorageCacheEntries = Map<bigint, Map<bigint, StorageCacheEntry>>;

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

export class StateManager {
  public readonly logCache = new LogCache()
  public readonly storageCache = new StorageCache()
  public readonly initialStorageReads = new InitialStorageReadList()
  public cachedEVMIn: Map<bigint, Map<string, DataPt>> = new Map()
  public cachedOrigin: DataPt | undefined = undefined
  public contextByDepth: MessageContext[] = []
  private _messageCodeAddresses = new Set<string>()

  constructor(private readonly placementManager: PlacementManager) {}

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
    this._messageCodeAddresses.clear()
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
