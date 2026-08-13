import {
  BIGINT_0,
  bigIntToHex,
  bytesToBigInt,
  setLengthRight,
} from '@ethereumjs/util';

import { MemoryPt } from '../dataStructure/index.ts';
import {
  type DataPt,
  type MemoryPts,
  type PreparedComposition,
  UINT256_DATA_PT_TYPE,
} from '../types/index.ts';
import type { PlacementManager } from './placementManager.ts';

export type PreparedMemoryRead = Readonly<{
  compositions: readonly PreparedComposition[];
  viewDataPts: DataPt[];
  recoveredValue: bigint;
}>;

export type PreparedMemoryCopy = Readonly<{
  compositions: readonly PreparedComposition[];
  destinationEntries: MemoryPts;
}>;

export class MemoryManager {
  constructor(private readonly placementManager: PlacementManager) {}

  public prepareCodeMemoryPts(
    code: Uint8Array<ArrayBufferLike>,
    targetAddress: bigint,
    memOffset: bigint,
    codeOffset: bigint = 0n,
    dataLength: bigint = BigInt(code.byteLength),
  ): MemoryPts {
    const getDataSlice = (data: Uint8Array, offset: bigint, length: bigint): Uint8Array => {
      const len = BigInt(data.length)
      if (offset > len) {
        offset = len
      }
      let end = offset + length
      if (end > len) {
        end = len
      }
      data = data.subarray(Number(offset), Number(end))
      return setLengthRight(data, Number(length))
    }

    const memPts: MemoryPts = []
    const nChunks = Math.ceil(Number(dataLength) / 32)
    let accOffsetShift = 0n
    let lengthLeft = Number(dataLength)
    for (let i = 0; i < nChunks; i++) {
      const sliceLength = Math.min(32, lengthLeft)
      const dataSlice = bytesToBigInt(
        getDataSlice(code, codeOffset + accOffsetShift, BigInt(sliceLength)),
      )
      const desc = `Code of address: ${bigIntToHex(targetAddress)}, offset: ${Number(codeOffset)}, length: ${Number(dataLength)} bytes, chunk: ${i + 1} out of ${nChunks}.`
      const dataPt = this.placementManager.loadArbitraryStatic(
        dataSlice,
        UINT256_DATA_PT_TYPE,
        desc,
      )
      memPts.push({
        memByteOffset: Number(memOffset + accOffsetShift),
        containerByteSize: sliceLength,
        dataPt,
      })
      lengthLeft -= sliceLength
      accOffsetShift += BigInt(sliceLength)
    }
    return memPts
  }

  public prepareMemoryCopy(
    sourceMemoryPt: MemoryPt,
    sourceOffset: bigint,
    length: bigint,
    destinationOffset: bigint = 0n,
    basePlacementIndex: number,
  ): PreparedMemoryCopy {
    if (length === BIGINT_0) {
      return { compositions: [], destinationEntries: [] }
    }
    const sourceOffsetNumber = Number(sourceOffset)
    const lengthNumber = Number(length)
    const sourceSnapshot = MemoryPt.simulateMemoryPt(
      sourceMemoryPt.read(sourceOffsetNumber, lengthNumber),
    )
    const preparedMemoryRead = this.prepareMemoryRead(
      sourceSnapshot,
      sourceOffset,
      length,
      basePlacementIndex,
    )
    const destinationEntries = preparedMemoryRead.viewDataPts.map((dataPt, index) => ({
      memByteOffset: Number(destinationOffset) + 32 * index,
      containerByteSize: Math.min(32, lengthNumber - 32 * index),
      dataPt,
    }))
    return {
      compositions: preparedMemoryRead.compositions,
      destinationEntries,
    }
  }

  public prepareMemoryRead(
    memoryPt: MemoryPt,
    offset: bigint,
    length: bigint,
    basePlacementIndex: number,
  ): PreparedMemoryRead {
    const offsetNum = Number(offset)
    const lengthNum = Number(length)
    const nViews = lengthNum > 32 ? Math.ceil(lengthNum / 32) : 1
    const viewDataPts: DataPt[] = []
    const compositions: PreparedComposition[] = []
    let recoveredValue = 0n
    let lengthLeft = lengthNum
    let nextPlacementIndex = basePlacementIndex

    for (let i = 0; i < nViews; i++) {
      const viewOffset = offsetNum + 32 * i
      const viewLength = lengthLeft > 32 ? 32 : lengthLeft
      lengthLeft -= viewLength
      const dataAliasGeometries = memoryPt.getDataAlias(viewOffset, viewLength)
      if (dataAliasGeometries.length > 0) {
        const preparedComposition = this.placementManager.prepareComposition(
          {
            operation: 'MemoryLoad',
            dataAliasGeometries,
            viewByteLength: viewLength,
          },
          nextPlacementIndex,
        )
        compositions.push(preparedComposition)
        nextPlacementIndex += preparedComposition.steps.length
        viewDataPts[i] = preparedComposition.resultPts[0]!
      } else {
        viewDataPts[i] = this.placementManager.loadArbitraryStatic(
          0n,
          UINT256_DATA_PT_TYPE,
        )
      }
      recoveredValue += viewDataPts[i].value << BigInt(lengthLeft * 8)
    }
    return { compositions, viewDataPts, recoveredValue }
  }
}
