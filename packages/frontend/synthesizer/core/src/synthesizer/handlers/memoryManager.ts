import { DataAliasGeometries, DataAliasInfos, DataPt, ISynthesizerProvider, MemoryPtEntry, MemoryPts } from '../types/index.ts';
import { DataPtFactory, MemoryPt } from '../dataStructure/index.ts';
import { ArithmeticOperator } from '../../subcircuit/configuredTypes.ts';

export class MemoryManager {
  constructor(
    private parent: ISynthesizerProvider,
  ) {}

  public placeMSTORE8(dataPt: DataPt): DataPt {
    const maskPt = this.parent.loadArbitraryStatic(
      0xffn,
      {
        valueDomain: { kind: 'uint', bits: 256 },
        wireLayout: { kind: 'limbs-128', count: 2 },
      },
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
    return DataPtFactory.deepCopy(this.combineMemorySlices(dataAliasInfos));
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
      const direction = shift < 0 ? 1n : 0n;
      const shiftMagnitude = BigInt(Math.abs(shift) / 8);
      const ownershipMask = this._createOwnershipMask(masker);
      return Object.freeze({
        dataPt,
        shiftPt: this.parent.loadArbitraryStatic(
          shiftMagnitude,
          { valueDomain: { kind: 'uint', bits: 5 }, wireLayout: { kind: 'limbs-128', count: 1 } },
          'Memory-load byte shift magnitude',
        ),
        directionPt: this.parent.loadArbitraryStatic(
          direction,
          { valueDomain: { kind: 'uint', bits: 1 }, wireLayout: { kind: 'limbs-128', count: 1 } },
          'Memory-load shift direction',
        ),
        maskerPt: this.parent.loadArbitraryStatic(
          ownershipMask,
          { valueDomain: { kind: 'uint', bits: 32 }, wireLayout: { kind: 'limbs-128', count: 1 } },
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
        {
          valueDomain: { kind: 'uint', bits: 256 },
          wireLayout: { kind: 'limbs-128', count: 2 },
        },
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
        {
          valueDomain: { kind: 'uint', bits: 256 },
          wireLayout: { kind: 'limbs-128', count: 2 },
        },
        'Shifter for memory manipulation',
      ),
      dataPt,
    ]);
    return truncatedPt;
  }

  private combineMemorySlices(dataAliasInfos: DataAliasGeometries): DataPt {
    const transformedSlices = dataAliasInfos.map((info) =>
      this.transformMemorySlice(info),
    );

    if (transformedSlices.length === 1) {
      return transformedSlices[0];
    }

    if (transformedSlices.length > this.parent.subcircuitLibrary.accumulatorInputLimit) {
      throw new Error(
        `Synthesizer: Go to qap-compiler and unlimit the number of inputs for the Accumulator.`,
      );
    }

    // Arithmetic compositions return arrays, while Accumulator produces one output.
    const [accumulatedPt] = this.parent.placeComposition(
      'Accumulator',
      transformedSlices,
    );
    return accumulatedPt;
  }

  private transformMemorySlice(info: DataAliasGeometries[number]): DataPt {
    const shiftedPt = this.applyShift(info);
    const modInfo: DataAliasGeometries[number] = {
      dataPt: shiftedPt,
      masker: info.masker,
      shift: info.shift,
    };
    return this.applyMask(modInfo);
  }

  private applyShift(info: DataAliasGeometries[number]): DataPt {
    const { dataPt: dataPt, shift: shift } = info;
    let outPts = [dataPt];
    if (Math.abs(shift) > 0) {
      // The relationship between shift value and shift direction is defined in MemoryPt
      const subcircuitName: ArithmeticOperator = shift > 0 ? 'SHL' : 'SHR';
      const absShift = Math.abs(shift);
      const inPts: DataPt[] = [
        this.parent.loadArbitraryStatic(
          BigInt(absShift),
          {
            valueDomain: { kind: 'uint', bits: 256 },
            wireLayout: { kind: 'limbs-128', count: 2 },
          },
          'Shifter for memory manipulation',
        ),
        dataPt,
      ];
      outPts = this.parent.placeComposition(subcircuitName, inPts);
    }
    return outPts[0];
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
        {
          valueDomain: { kind: 'uint', bits: 256 },
          wireLayout: { kind: 'limbs-128', count: 2 },
        },
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
}
