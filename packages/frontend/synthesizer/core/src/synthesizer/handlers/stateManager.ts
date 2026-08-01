import { DataPtFactory } from '../../synthesizer/dataStructure/dataPt.ts';
import {
  ISynthesizerProvider,
  MemoryPts,
  PlacementEntry,
  placementsDeepCopy,
  type DataPt,
  type Placements,
} from '../types/index.ts';
import { MemoryPt, StackPt } from '../dataStructure/index.ts';
import { SubcircuitInfoByName, SubcircuitNames } from '../../subcircuit/configuredTypes.ts';
import { InterpreterStep } from '@ethereumjs/evm';

// export type CachedStorageEntry = {
//   addressIndex: number,
//   indexPt: DataPt | null,
//   keyPt: DataPt,
//   valuePt: DataPt,
//   access: 'Read' | 'Write'
// }

export type ContextConstructionData = {
  callerPt: DataPt;
  codeAddressPt: DataPt;
  storageAddressPt: DataPt;
  callDataMemoryPts: MemoryPts;
}

export type CachedMerkleProof = {
  indexPt: DataPt;
  siblingPts: DataPt[][];
}

export type StorageCacheEntry = {
  canonicalAddressPt: DataPt;
  canonicalKeyPt: DataPt;
  latestValuePt: DataPt;
  dirty: boolean;
}

export type InitialStorageRead = {
  addressPt: DataPt;
  keyPt: DataPt;
  valuePt: DataPt;
}

type StorageCache = Map<bigint, Map<bigint, StorageCacheEntry>>;

const copyStorageCacheEntry = (entry: StorageCacheEntry): StorageCacheEntry => ({
  canonicalAddressPt: DataPtFactory.deepCopy(entry.canonicalAddressPt),
  canonicalKeyPt: DataPtFactory.deepCopy(entry.canonicalKeyPt),
  latestValuePt: DataPtFactory.deepCopy(entry.latestValuePt),
  dirty: entry.dirty,
});

const copyStorageCache = (cache: StorageCache): StorageCache => new Map(
  Array.from(cache, ([address, entriesByKey]) => [
    address,
    new Map(
      Array.from(entriesByKey, ([key, entry]) => [key, copyStorageCacheEntry(entry)]),
    ),
  ]),
);

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
  private _storageCache: StorageCache = new Map()
  private _initialStorageReads: InitialStorageRead[] = []
  private _storageCacheSnapshotsByDepth: Map<number, StorageCache> = new Map()

  // public verifiedStorageMTIndices: [number, number][] = [] // [ADDRESS_INDEX, LEAF_INDEX]
  // public cachedStorage: Map<string, Map<bigint, CachedStorageEntry[]>> = new Map() // Map<ADDRESS_STRING, Map<KEY, ENTRY>>
  public subcircuitInfoByName: SubcircuitInfoByName;

  public cachedEVMIn: Map<bigint, Map<number, DataPt>> = new Map()
  public cachedOrigin: DataPt | undefined = undefined
  public cachedRoots: Map<bigint, DataPt[]> = new Map()
  public cachedMerkleProof: CachedMerkleProof | null = null

  public contextByDepth: ContextManager[] = [];

  constructor(parent: ISynthesizerProvider) {
    this.subcircuitInfoByName = parent.subcircuitLibrary.subcircuitInfoByName
  }

  public get placements(): Placements {
    // placements are protected and can be manipulated only by this.place and this.addWirePairToBufferIn
    return placementsDeepCopy(this._placements)
  }

  public get initialStorageReads(): InitialStorageRead[] {
    return this._initialStorageReads.map((entry) => ({
      addressPt: DataPtFactory.deepCopy(entry.addressPt),
      keyPt: DataPtFactory.deepCopy(entry.keyPt),
      valuePt: DataPtFactory.deepCopy(entry.valuePt),
    }))
  }

  public resetStorageAccessTracking(): void {
    this._storageCache = new Map()
    this._initialStorageReads = []
    this._storageCacheSnapshotsByDepth = new Map()
  }

  public beginStorageFrame(depth: number): void {
    if (this._storageCacheSnapshotsByDepth.has(depth)) {
      throw new Error(`Synthesizer: Storage cache snapshot already exists at call depth ${depth}`)
    }
    this._storageCacheSnapshotsByDepth.set(depth, copyStorageCache(this._storageCache))
  }

  public completeStorageFrame(depth: number, succeeded: boolean): void {
    const snapshot = this._storageCacheSnapshotsByDepth.get(depth)
    if (snapshot === undefined) {
      throw new Error(`Synthesizer: Storage cache snapshot is missing at call depth ${depth}`)
    }
    if (!succeeded) {
      this._storageCache = snapshot
    }
    this._storageCacheSnapshotsByDepth.delete(depth)
  }

  public getStorageCacheEntry(address: bigint, key: bigint): StorageCacheEntry | undefined {
    const entry = this._storageCache.get(address)?.get(key)
    return entry === undefined ? undefined : copyStorageCacheEntry(entry)
  }

  public setStorageCacheEntry(address: bigint, key: bigint, entry: StorageCacheEntry): void {
    if (entry.canonicalAddressPt.value !== address || entry.canonicalKeyPt.value !== key) {
      throw new Error('Synthesizer: Storage cache identity does not match its host lookup key')
    }
    const entriesByKey = this._storageCache.get(address) ?? new Map<bigint, StorageCacheEntry>()
    entriesByKey.set(key, copyStorageCacheEntry(entry))
    this._storageCache.set(address, entriesByKey)
  }

  public getInitialStorageRead(address: bigint, key: bigint): InitialStorageRead | undefined {
    const entry = this._initialStorageReads.find(
      (candidate) => candidate.addressPt.value === address && candidate.keyPt.value === key,
    )
    return entry === undefined
      ? undefined
      : {
          addressPt: DataPtFactory.deepCopy(entry.addressPt),
          keyPt: DataPtFactory.deepCopy(entry.keyPt),
          valuePt: DataPtFactory.deepCopy(entry.valuePt),
        }
  }

  public addInitialStorageRead(address: bigint, key: bigint, entry: InitialStorageRead): void {
    if (entry.addressPt.value !== address || entry.keyPt.value !== key) {
      throw new Error('Synthesizer: Initial SLOAD identity does not match its host lookup key')
    }
    if (this.getInitialStorageRead(address, key) !== undefined) {
      throw new Error('Synthesizer: Initial SLOAD already exists for this storage location')
    }
    const copiedEntry: InitialStorageRead = {
      addressPt: DataPtFactory.deepCopy(entry.addressPt),
      keyPt: DataPtFactory.deepCopy(entry.keyPt),
      valuePt: DataPtFactory.deepCopy(entry.valuePt),
    }
    this._initialStorageReads.push(copiedEntry)
  }

  public place(
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
