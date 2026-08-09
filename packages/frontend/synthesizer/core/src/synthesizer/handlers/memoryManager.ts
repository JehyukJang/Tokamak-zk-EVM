import {
  BIT_LIMB_DATA_PT_TYPE,
  DataAliasInfoEntry,
  DataAliasInfos,
  DataPt,
  DataPtType,
  EVM_WORD_DATA_PT_TYPE,
  ISynthesizerProvider,
  MemoryPtEntry,
  MemoryPts,
} from '../types/index.ts';
import { DataPtFactory, MemoryPt } from '../dataStructure/index.ts';
import { ArithmeticOperator } from '../../subcircuit/configuredTypes.ts';

const UINT5_LIMB_DATA_PT_TYPE = {
  valueDomain: { kind: 'uint', bits: 5 },
  wireLayout: { kind: 'limbs-128', count: 1 },
} as const satisfies DataPtType;

const UINT32_LIMB_DATA_PT_TYPE = {
  valueDomain: { kind: 'uint', bits: 32 },
  wireLayout: { kind: 'limbs-128', count: 1 },
} as const satisfies DataPtType;

const UINT256_MASK = (1n << 256n) - 1n;

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
    const outPts = this.parent.placeArithComposition('AND', [maskPt, dataPt])
    if (outPts.length !== 1 || outPts[0] === undefined) {
      throw new Error('Synthesizer: MSTORE8 masking must produce exactly one output')
    }
    if (outPts[0].value !== (dataPt.value & 0xffn)) {
      throw new Error('Synthesizer: MSTORE8 masking output mismatch')
    }
    return DataPtFactory.deepCopy(outPts[0])
  }

  public placeMemoryToStack(dataAliasInfos: DataAliasInfos, viewByteLength: number): DataPt {
    if (!Number.isInteger(viewByteLength) || viewByteLength < 1 || viewByteLength > 32) {
      throw new Error(`Synthesizer: placeMemoryToStack: Invalid view byte length ${viewByteLength}`)
    }
    if (dataAliasInfos.length === 0) {
      throw new Error(`Synthesizer: placeMemoryToStack: Noting tho load`);
    }
    return DataPtFactory.deepCopy(this.combineMemorySlices(dataAliasInfos));
  }

  public placeMemoryToMemory(dataAliasInfos: DataAliasInfos): DataPt[] {
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
    const [truncatedPt] = this.parent.placeArithComposition('SHR', [
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

  private _ownershipFromMasker(masker: string, viewByteLength: number): bigint {
    const normalizedMasker = masker.toLowerCase();
    const maskBytes = normalizedMasker.startsWith('0x') ? normalizedMasker.slice(2) : '';
    if (maskBytes.length !== viewByteLength * 2) {
      throw new Error(`Synthesizer: memory mask must contain exactly ${viewByteLength} bytes`);
    }

    let ownership = 0n;
    for (let viewIndex = 0; viewIndex < viewByteLength; viewIndex++) {
      const maskIndex = viewByteLength - viewIndex - 1;
      const maskByte = maskBytes.slice(maskIndex * 2, maskIndex * 2 + 2);
      if (maskByte === 'ff') {
        ownership |= 1n << BigInt(viewIndex);
      } else if (maskByte !== '00') {
        throw new Error('Synthesizer: memory mask bytes must be either FF or 00');
      }
    }
    if (ownership === 0n) {
      throw new Error('Synthesizer: memory fragments must own at least one byte');
    }
    return ownership;
  }

  private _placeMemoryLoadStep(
    info: DataAliasInfoEntry,
    viewByteLength: number,
    previousWordPt: DataPt,
    previousOwnershipPt: DataPt,
    expectedCoveragePt: DataPt,
    finalMode: boolean,
  ): { wordPt: DataPt; ownershipPt: DataPt } {
    const sourceLayout = info.dataPt.dataPtType.wireLayout;
    if (
      info.dataPt.dataPtType.valueDomain.kind !== 'uint' ||
      sourceLayout.kind !== 'limbs-128' ||
      sourceLayout.count !== 2
    ) {
      throw new Error('Synthesizer: memory fragments must use a two-limb uint layout');
    }
    if (!Number.isInteger(info.shift) || info.shift % 8 !== 0) {
      throw new Error('Synthesizer: memory fragment shifts must be byte-aligned integers');
    }

    const shiftMagnitude = Math.abs(info.shift) / 8;
    if (shiftMagnitude > 31) {
      throw new Error('Synthesizer: memory fragment byte shifts must not exceed 31');
    }
    const shiftDirection = info.shift < 0 ? 1n : 0n;
    const incomingOwnership = this._ownershipFromMasker(info.masker, viewByteLength);
    const nextRealOwnership = previousOwnershipPt.value + incomingOwnership;
    if ((previousOwnershipPt.value & incomingOwnership) !== 0n) {
      throw new Error('Synthesizer: memory fragment ownership must be disjoint');
    }
    if ((nextRealOwnership & ~expectedCoveragePt.value) !== 0n) {
      throw new Error('Synthesizer: memory fragment ownership exceeds the requested view');
    }

    const shiftBits = BigInt(shiftMagnitude * 8);
    const shiftedValue =
      shiftDirection === 0n ? (info.dataPt.value << shiftBits) & UINT256_MASK : info.dataPt.value >> shiftBits;
    let ownershipMask = 0n;
    for (let byte = 0; byte < 32; byte++) {
      if ((incomingOwnership & (1n << BigInt(byte))) !== 0n) {
        ownershipMask |= 0xffn << BigInt(byte * 8);
      }
    }
    const nextWord = previousWordPt.value + (shiftedValue & ownershipMask);
    if (nextWord > UINT256_MASK) {
      throw new Error('Synthesizer: memory-load accumulation exceeds 256 bits');
    }
    const nextOwnership = finalMode ? expectedCoveragePt.value : nextRealOwnership;

    const placementIndex = this.parent.placements.length;
    const wordPt = DataPtFactory.create(
      {
        source: placementIndex,
        wireIndex: 0,
        dataPtType: EVM_WORD_DATA_PT_TYPE,
      },
      nextWord,
    );
    const ownershipPt = DataPtFactory.create(
      {
        source: placementIndex,
        wireIndex: 1,
        dataPtType: UINT32_LIMB_DATA_PT_TYPE,
      },
      nextOwnership,
    );
    const stepInfo = this.parent.state.subcircuitInfoByName.get('MemoryLoadStep');
    if (stepInfo === undefined || stepInfo.NInWires !== 10 || stepInfo.NOutWires !== 3) {
      throw new Error('Synthesizer: MemoryLoadStep must expose 10 input wires and 3 output wires');
    }

    this.parent.place(
      'MemoryLoadStep',
      [
        info.dataPt,
        this.parent.loadArbitraryStatic(
          BigInt(shiftMagnitude),
          UINT5_LIMB_DATA_PT_TYPE,
          'Memory-load byte-shift magnitude',
        ),
        this.parent.loadArbitraryStatic(shiftDirection, BIT_LIMB_DATA_PT_TYPE, 'Memory-load shift direction'),
        this.parent.loadArbitraryStatic(incomingOwnership, UINT32_LIMB_DATA_PT_TYPE, 'Memory-load incoming ownership'),
        previousWordPt,
        previousOwnershipPt,
        expectedCoveragePt,
        this.parent.loadArbitraryStatic(finalMode ? 1n : 0n, BIT_LIMB_DATA_PT_TYPE, 'Memory-load final mode'),
      ],
      [wordPt, ownershipPt],
      'MemoryLoadStep',
    );
    return { wordPt, ownershipPt };
  }

  private _materializeMemoryView(dataAliasInfos: DataAliasInfos, viewByteLength: number): DataPt {
    if (!Number.isInteger(viewByteLength) || viewByteLength < 1 || viewByteLength > 32) {
      throw new Error(
        `Synthesizer: memory view byte length must be an integer between 1 and 32, got ${viewByteLength}`,
      );
    }
    if (dataAliasInfos.length === 0) {
      throw new Error('Synthesizer: memory view materialization requires at least one fragment');
    }

    let wordPt = this.parent.loadArbitraryStatic(0n, EVM_WORD_DATA_PT_TYPE, 'Memory-load initial word');
    let ownershipPt = this.parent.loadArbitraryStatic(0n, UINT32_LIMB_DATA_PT_TYPE, 'Memory-load initial ownership');
    const expectedCoveragePt = this.parent.loadArbitraryStatic(
      (1n << BigInt(viewByteLength)) - 1n,
      UINT32_LIMB_DATA_PT_TYPE,
      'Memory-load expected coverage',
    );

    for (const [index, info] of dataAliasInfos.entries()) {
      const nextState = this._placeMemoryLoadStep(
        info,
        viewByteLength,
        wordPt,
        ownershipPt,
        expectedCoveragePt,
        index === dataAliasInfos.length - 1,
      );
      wordPt = nextState.wordPt;
      ownershipPt = nextState.ownershipPt;
    }
    if (ownershipPt.value !== expectedCoveragePt.value) {
      throw new Error('Synthesizer: terminal memory-load ownership is incomplete');
    }
    return DataPtFactory.deepCopy(wordPt);
  }

  private combineMemorySlices(dataAliasInfos: DataAliasInfos): DataPt {
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
    const [accumulatedPt] = this.parent.placeArithComposition(
      'Accumulator',
      transformedSlices,
    );
    return accumulatedPt;
  }

  private transformMemorySlice(info: DataAliasInfoEntry): DataPt {
    const shiftedPt = this.applyShift(info);
    const modInfo: DataAliasInfoEntry = {
      dataPt: shiftedPt,
      masker: info.masker,
      shift: info.shift,
    };
    return this.applyMask(modInfo);
  }

  private applyShift(info: DataAliasInfoEntry): DataPt {
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
      outPts = this.parent.placeArithComposition(subcircuitName, inPts);
    }
    return outPts[0];
  }

  private applyMask(info: DataAliasInfoEntry, unshift?: boolean): DataPt {
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
    const outPts = this.parent.placeArithComposition('AND', inPts);
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
