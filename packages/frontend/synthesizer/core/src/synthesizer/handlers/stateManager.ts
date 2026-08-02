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
import {
  BUFFER_LIST,
  SubcircuitInfoByName,
  SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import { InterpreterStep } from '@ethereumjs/evm';
import { InitialStorageReadList, StorageCache } from './storageAccess.ts';

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
  private _logOutLengthsByDepth: Map<number, number> = new Map()
  public readonly storageCache = new StorageCache()
  public readonly initialStorageReads = new InitialStorageReadList()

  // public verifiedStorageMTIndices: [number, number][] = [] // [ADDRESS_INDEX, LEAF_INDEX]
  // public cachedStorage: Map<string, Map<bigint, CachedStorageEntry[]>> = new Map() // Map<ADDRESS_STRING, Map<KEY, ENTRY>>
  public subcircuitInfoByName: SubcircuitInfoByName;

  public cachedEVMIn: Map<bigint, Map<number, DataPt>> = new Map()
  public cachedOrigin: DataPt | undefined = undefined

  public contextByDepth: ContextManager[] = [];

  constructor(parent: ISynthesizerProvider) {
    this.subcircuitInfoByName = parent.subcircuitLibrary.subcircuitInfoByName
  }

  public get placements(): Placements {
    // placements are protected and can be manipulated only by this.place and this.addWirePairToBufferIn
    return placementsDeepCopy(this._placements)
  }

  private _getLogOutPlacement(): PlacementEntry {
    const placement = this._placements[BUFFER_LIST.indexOf('LOG_OUT')]
    if (placement === undefined) {
      throw new Error('Synthesizer: LOG_OUT buffer placement is missing')
    }
    return placement
  }

  public resetTransactionTracking(): void {
    this.storageCache.reset()
    this.initialStorageReads.reset()
    this._logOutLengthsByDepth = new Map()
  }

  public beginFrame(depth: number): void {
    if (this._logOutLengthsByDepth.has(depth)) {
      throw new Error(`Synthesizer: LOG_OUT snapshot already exists at call depth ${depth}`)
    }
    const logOutPlacement = this._getLogOutPlacement()
    if (logOutPlacement.inPts.length !== logOutPlacement.outPts.length) {
      throw new Error('Synthesizer: LOG_OUT input and output lengths do not match')
    }
    this.storageCache.beginFrame(depth)
    this._logOutLengthsByDepth.set(depth, logOutPlacement.inPts.length)
  }

  public completeFrame(depth: number, succeeded: boolean): void {
    const logOutLength = this._logOutLengthsByDepth.get(depth)
    if (logOutLength === undefined) {
      throw new Error(`Synthesizer: LOG_OUT snapshot is missing at call depth ${depth}`)
    }
    const logOutPlacement = this._getLogOutPlacement()
    if (
      logOutPlacement.inPts.length !== logOutPlacement.outPts.length
      || logOutPlacement.inPts.length < logOutLength
    ) {
      throw new Error('Synthesizer: LOG_OUT buffer is inconsistent with its frame snapshot')
    }
    this.storageCache.completeFrame(depth, succeeded)
    if (!succeeded) {
      logOutPlacement.inPts.length = logOutLength
      logOutPlacement.outPts.length = logOutLength
    }
    this._logOutLengthsByDepth.delete(depth)
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
