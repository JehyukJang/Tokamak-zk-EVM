import {
  BIT_DATA_PT_TYPE,
  DataAliasGeometries,
  DataAliasInfos,
  DataPt,
  ISynthesizerProvider,
  MemoryPtEntry,
  MemoryPts,
  PreparedComposition,
  UINT256_DATA_PT_TYPE,
  UINT32_DATA_PT_TYPE,
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

  public placeMemoryToStack(dataAliasInfos: DataAliasGeometries, viewByteLength: number): DataPt {
    if (!Number.isInteger(viewByteLength) || viewByteLength < 1 || viewByteLength > 32) {
      throw new Error(`Synthesizer: placeMemoryToStack: Invalid view byte length ${viewByteLength}`)
    }
    if (dataAliasInfos.length === 0) {
      throw new Error(`Synthesizer: placeMemoryToStack: Noting tho load`);
    }
    return DataPtFactory.deepCopy(
      this._placeMemoryLoadComposition(this.createDataAliasInfos(dataAliasInfos)),
    );
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

  public createDataAliasInfos(dataAliasGeometries: DataAliasGeometries): DataAliasInfos {
    return dataAliasGeometries.map(({ dataPt, shift, masker }) => {
      if (!Number.isInteger(shift) || shift % 8 !== 0 || Math.abs(shift) > 31 * 8) {
        throw new Error('Synthesizer: memory-load shift must be a byte-aligned value from -248 to 248')
      }
      const direction = shift < 0 ? 1n : 0n;
      const shiftMagnitude = BigInt(Math.abs(shift) / 8);
      const ownershipMask = this._createOwnershipMask(masker);
      return Object.freeze({
        dataPt,
        shiftPt: this.parent.loadArbitraryStatic(
          shiftMagnitude,
          UINT32_DATA_PT_TYPE,
          'Memory-load byte shift magnitude',
        ),
        directionPt: this.parent.loadArbitraryStatic(
          direction,
          BIT_DATA_PT_TYPE,
          'Memory-load shift direction',
        ),
        maskerPt: this.parent.loadArbitraryStatic(
          ownershipMask,
          UINT32_DATA_PT_TYPE,
          'Memory-load byte ownership mask',
        ),
      });
    });
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

  private _placeMemoryLoadComposition(dataAliasInfos: DataAliasInfos): DataPt {
    const basePlacementIndex = this.parent.placements.length
    const expectedCoverageValue = dataAliasInfos.reduce(
      (coverage, { maskerPt }) => coverage | maskerPt.value,
      0n,
    )
    const expectedCoveragePt = this.parent.loadArbitraryStatic(
      expectedCoverageValue,
      UINT32_DATA_PT_TYPE,
      'Memory-load final byte ownership',
    )
    const zeroWordPt = this.parent.loadArbitraryStatic(
      0n,
      UINT256_DATA_PT_TYPE,
      'Memory-load initial word',
    )
    const zeroOwnershipPt = this.parent.loadArbitraryStatic(
      0n,
      UINT32_DATA_PT_TYPE,
      'Memory-load initial byte ownership',
    )
    const operands: DataPt[] = []
    const steps: PreparedComposition['steps'][number][] = []
    let previousWordPt = zeroWordPt
    let previousOwnershipPt = zeroOwnershipPt

    for (const [stepIndex, info] of dataAliasInfos.entries()) {
      const isFinalStep = stepIndex === dataAliasInfos.length - 1
      const finalModePt = this.parent.loadArbitraryStatic(
        isFinalStep ? 1n : 0n,
        BIT_DATA_PT_TYPE,
        'Memory-load final-mode flag',
      )
      const shiftedValue = info.directionPt.value === 0n
        ? (info.dataPt.value << (info.shiftPt.value * 8n))
        : info.dataPt.value >> (info.shiftPt.value * 8n)
      const maskedValue = shiftedValue & this._expandOwnershipMask(info.maskerPt.value)
      const nextWordValue = previousWordPt.value + maskedValue
      if (nextWordValue >= 1n << 256n) {
        throw new Error('Synthesizer: memory-load fragment sum exceeds an EVM word')
      }
      const nextOwnershipValue = isFinalStep
        ? expectedCoveragePt.value
        : previousOwnershipPt.value + info.maskerPt.value
      const nextWordPt = DataPtFactory.create({
        source: basePlacementIndex + stepIndex,
        wireIndex: 0,
        dataPtType: UINT256_DATA_PT_TYPE,
      }, nextWordValue)
      const nextOwnershipPt = DataPtFactory.create({
        source: basePlacementIndex + stepIndex,
        wireIndex: 1,
        dataPtType: UINT32_DATA_PT_TYPE,
      }, nextOwnershipValue)
      steps.push({
        inPts: [
          info.dataPt,
          info.shiftPt,
          info.directionPt,
          info.maskerPt,
          previousWordPt,
          previousOwnershipPt,
          expectedCoveragePt,
          finalModePt,
        ],
        outPts: [nextWordPt, nextOwnershipPt],
      })
      operands.push(info.dataPt, info.shiftPt, info.directionPt, info.maskerPt)
      previousWordPt = nextWordPt
      previousOwnershipPt = nextOwnershipPt
    }
    operands.push(expectedCoveragePt)

    const preparedComposition: PreparedComposition = {
      operation: 'MemoryLoad',
      operands,
      resultPts: [previousWordPt],
      steps,
    }
    this.parent.placeComposition(preparedComposition)
    return previousWordPt
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

  private _createOwnershipMask(masker: string): bigint {
    if (masker.length % 2 !== 0) {
      throw new Error('Synthesizer: memory ownership mask must contain whole bytes');
    }
    let ownershipMask = 0n;
    for (let byteIndex = 0; byteIndex < masker.length / 2; byteIndex++) {
      const byte = masker.slice(byteIndex * 2, byteIndex * 2 + 2);
      if (byte === 'ff' || byte === 'FF') {
        ownershipMask |= 1n << BigInt(masker.length / 2 - byteIndex - 1);
      } else if (byte !== '00') {
        throw new Error('Synthesizer: memory ownership mask must contain only FF or 00 bytes');
      }
    }
    return ownershipMask;
  }

  private _expandOwnershipMask(ownershipMask: bigint): bigint {
    let wordMask = 0n
    for (let byteIndex = 0; byteIndex < 32; byteIndex++) {
      if ((ownershipMask & (1n << BigInt(byteIndex))) !== 0n) {
        wordMask |= 0xffn << BigInt(byteIndex * 8)
      }
    }
    return wordMask
  }
}
