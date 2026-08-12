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
