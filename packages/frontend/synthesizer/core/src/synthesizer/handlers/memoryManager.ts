import {
  DataAliasGeometries,
  DataPt,
  ISynthesizerProvider,
  MemoryPtEntry,
  MemoryPts,
  UINT256_DATA_PT_TYPE,
} from '../types/index.ts';
import { DataPtFactory, MemoryPt } from '../dataStructure/index.ts';

export class MemoryManager {
  constructor(
    private parent: ISynthesizerProvider,
  ) {}

  public placeMSTORE8(dataPt: DataPt): DataPt {
    const maskPt = this.parent.loadArbitraryStatic(
      0xffn,
      UINT256_DATA_PT_TYPE,
      'Masker for MSTORE8',
    )
    const outPts = this.parent.placeComposition('AND', [maskPt, dataPt])
    if (outPts.length !== 1 || outPts[0] === undefined) {
      throw new Error('Synthesizer: MSTORE8 masking must produce exactly one output')
    }
    if (outPts[0].value !== (dataPt.value & 0xffn)) {
      throw new Error('Synthesizer: MSTORE8 masking output mismatch')
    }
    return DataPtFactory.deepCopy(outPts[0])
  }

  public placeMemoryToMemory(dataAliasInfos: DataAliasGeometries): DataPt[] {
    if (dataAliasInfos.length === 0) {
      throw new Error(`Synthesizer: placeMemoryToMemory: Nothing to load`);
    }
    const copiedDataPts: DataPt[] = [];
    for (const info of dataAliasInfos) {
      // the lower index, the older data
      copiedDataPts.push(this.applyMask(info, true));
    }
    return DataPtFactory.deepCopy(copiedDataPts);
  }

  private calculateViewAdjustment(
    memoryPt: MemoryPts[number],
    srcOffset: number,
    dstOffset: number,
    viewLength: number,
  ) {
    const { memByteOffset: containerOffset, containerByteSize } = memoryPt;
    const containerEndPos = containerOffset + containerByteSize;

    const actualOffset = Math.max(srcOffset, containerOffset);
    const actualEndPos = Math.min(srcOffset + viewLength, containerEndPos);

    const adjustedOffset = actualOffset - srcOffset + dstOffset;
    const actualContainerSize = actualEndPos - actualOffset;
    const endingGap = containerEndPos - actualEndPos;

    return { adjustedOffset, actualContainerSize, endingGap };
  }

  public adjustMemoryPts(
    dataPts: DataPt[],
    memoryPts: MemoryPts,
    srcOffset: number,
    dstOffset: number,
    viewLength: number,
  ): void {
    for (const [index, memoryPt] of memoryPts.entries()) {
      const { adjustedOffset, actualContainerSize, endingGap } =
        this.calculateViewAdjustment(
          memoryPt,
          srcOffset,
          dstOffset,
          viewLength,
        );

      memoryPt.memByteOffset = adjustedOffset;
      memoryPt.containerByteSize = actualContainerSize;
      memoryPt.dataPt = this.truncateDataPt(dataPts[index], endingGap);
    }
  }

  public copyMemoryPts(
    target: MemoryPts,
    srcOffset: bigint,
    length: bigint,
    dstOffset: bigint = 0n,
  ): MemoryPts {
    const srcOffsetNum = Number(srcOffset)
    const dstOffsetNum = Number(dstOffset)
    const lengthNum = Number(length)
    const simFromMemoryPt = MemoryPt.simulateMemoryPt(target)
    let toMemoryPts: MemoryPts = simFromMemoryPt.read(srcOffsetNum, lengthNum)
    const zeroMemoryPtEntry: MemoryPtEntry = {
      memByteOffset: dstOffsetNum,
      containerByteSize: lengthNum,
      dataPt: this.parent.loadArbitraryStatic(
        0n,
        UINT256_DATA_PT_TYPE,
      ),
    }
    if (toMemoryPts.length > 0) {
      const simToMemoryPt = MemoryPt.simulateMemoryPt(toMemoryPts)
      const dataAliasInfos = simToMemoryPt.getDataAlias(srcOffsetNum, lengthNum)
      if (dataAliasInfos.length > 0) {
        const resolvedDataPts = this.parent.placeMemoryToMemory(dataAliasInfos)
        this.adjustMemoryPts(
          resolvedDataPts,
          toMemoryPts,
          srcOffsetNum,
          dstOffsetNum,
          lengthNum,
        )
      } else {
        toMemoryPts.push(zeroMemoryPtEntry)
      }
    } else {
      toMemoryPts.push(zeroMemoryPtEntry)
    }
  
    return toMemoryPts
  }

  private truncateDataPt(dataPt: DataPt, endingGap: number): DataPt {
    if (endingGap <= 0) {
      return dataPt;
    }
    // SHR data to truncate the ending part
    const [truncatedPt] = this.parent.placeComposition('SHR', [
      this.parent.loadArbitraryStatic(
        BigInt(endingGap * 8),
        UINT256_DATA_PT_TYPE,
        'Shifter for memory manipulation',
      ),
      dataPt,
    ]);
    return truncatedPt;
  }

  private applyMask(info: DataAliasGeometries[number], unshift?: boolean): DataPt {
    let alignedMask = BigInt(info.masker);
    const { shift, dataPt } = info;
    if (unshift === true) {
      alignedMask =
        shift > 0
          ? alignedMask >> BigInt(Math.abs(shift))
          : alignedMask << BigInt(Math.abs(shift));
    }

    const effectiveMask = alignedMask & ((1n << 256n) - 1n);
    const inPts: DataPt[] = [
      this.parent.loadArbitraryStatic(
        effectiveMask,
        UINT256_DATA_PT_TYPE,
        'Masker for memory manipulation',
      ),
      dataPt,
    ];
    const outPts = this.parent.placeComposition('AND', inPts);
    if (outPts.length !== 1 || outPts[0] === undefined) {
      throw new Error(
        'Synthesizer: memory masking must produce exactly one output',
      );
    }
    if (outPts[0].value !== (dataPt.value & effectiveMask)) {
      throw new Error('Synthesizer: memory masking output mismatch');
    }
    return outPts[0];
  }

}
