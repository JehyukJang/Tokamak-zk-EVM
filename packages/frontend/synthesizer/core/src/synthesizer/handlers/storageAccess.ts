import { DataPtFactory } from '../dataStructure/index.ts';
import type { DataPt } from '../types/index.ts';

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
