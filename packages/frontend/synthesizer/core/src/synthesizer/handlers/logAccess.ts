import { BUFFER_LIST } from '../../subcircuit/configuredTypes.ts';
import type { PlacementEntry, Placements } from '../types/index.ts';

export class LogCache {
  private _snapshotsByDepth: Map<number, number> = new Map()
  private readonly _placements: Placements

  constructor(placements: Placements) {
    this._placements = placements
  }

  private _getLogOutPlacement(): PlacementEntry {
    const placement = this._placements[BUFFER_LIST.indexOf('LOG_OUT')]
    if (placement === undefined) {
      throw new Error('Synthesizer: LOG_OUT buffer placement is missing')
    }
    return placement
  }

  public reset(): void {
    this._snapshotsByDepth = new Map()
  }

  public beginFrame(depth: number): void {
    if (this._snapshotsByDepth.has(depth)) {
      throw new Error(`Synthesizer: LOG_OUT snapshot already exists at call depth ${depth}`)
    }
    const logOutPlacement = this._getLogOutPlacement()
    if (logOutPlacement.inPts.length !== logOutPlacement.outPts.length) {
      throw new Error('Synthesizer: LOG_OUT input and output lengths do not match')
    }
    this._snapshotsByDepth.set(depth, logOutPlacement.inPts.length)
  }

  public completeFrame(depth: number, succeeded: boolean): void {
    const logOutLength = this._snapshotsByDepth.get(depth)
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
    if (!succeeded) {
      logOutPlacement.inPts.length = logOutLength
      logOutPlacement.outPts.length = logOutLength
    }
    this._snapshotsByDepth.delete(depth)
  }
}
