import {
  BIGINT_0,
  BIGINT_1,
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  setLengthLeft,
} from "@synthesizer-libs/util"
import { keccak256 } from 'ethereum-cryptography/keccak.js'

import { EOFBYTES, isEOF } from '../../eof/util.js'
import { createAddressFromStackBigInt, getDataSlice } from '../../opcodes/util.js'
import {
  DEFAULT_SOURCE_SIZE,
  INITIAL_PLACEMENT_INDEX,
  KECCAK_IN_PLACEMENT,
  KECCAK_IN_PLACEMENT_INDEX,
  KECCAK_OUT_PLACEMENT,
  KECCAK_OUT_PLACEMENT_INDEX,
  LOAD_PLACEMENT,
  LOAD_PLACEMENT_INDEX,
  RETURN_PLACEMENT,
  RETURN_PLACEMENT_INDEX,
  STORAGE_IN_PLACEMENT,
  STORAGE_IN_PLACEMENT_INDEX,
  STORAGE_OUT_PLACEMENT,
  STORAGE_OUT_PLACEMENT_INDEX,
} from '../constant/index.js'
import { subcircuits } from '../resources/index.js'
import { OPERATION_MAPPING } from '../operations/index.js'
import { DataPointFactory, simulateMemoryPt } from '../pointers/index.js'
import { addPlacement } from '../utils/utils.js'
import {
  InvalidInputCountError,
  SynthesizerError,
  SynthesizerValidator,
} from '../validation/index.js'

import type { RunState } from '../../interpreter.js'
import type { DataAliasInfoEntry, DataAliasInfos, MemoryPts } from '../pointers/index.js'
import type {
  ArithmeticOperator,
  Auxin,
  CreateDataPointParams,
  DataPt,
  Placements,
  SubcircuitInfoByName,
  SubcircuitInfoByNameEntry,
} from '../types/index.js'

export const synthesizerArith = (
  op: ArithmeticOperator,
  ins: bigint[],
  out: bigint,
  runState: RunState,
): void => {
  const inPts = runState.stackPt.popN(ins.length)

  for (let i = 0; i < ins.length; i++) {
    if (inPts[i].value !== ins[i]) {
      const stackValue = BigInt(inPts[i].value)
      const inputValue = BigInt(ins[i])
      console.log(`Value mismatch at index ${i}:`)
      console.log(`Stack value: ${stackValue}`)
      console.log(`Input value: ${inputValue}`)
      throw new Error(`Synthesizer: ${op}: Input data mismatch`)
    }
  }
  let outPts: DataPt[]
  switch (op) {
    case 'DecToBit':
      throw new Error(`Synthesizer: ${op}: Cannot be called by "synthesizerArith"`)
    case 'EXP':
      outPts = [runState.synthesizer.placeEXP(inPts)]
      break
    default:
      outPts = runState.synthesizer.placeArith(op, inPts)
      break
  }
  if (outPts.length !== 1 || outPts[0].value !== out) {
    throw new Error(`Synthesizer: ${op}: Output data mismatch`)
  }
  runState.stackPt.push(outPts[0])
}

export const synthesizerBlkInf = (op: string, runState: RunState, target?: bigint): void => {
  let dataPt: DataPt
  switch (op) {
    case 'BLOCKHASH':
    case 'BLOBHASH':
      // These opcodes have one input and one output
      if (target === undefined) {
        throw new Error(`Synthesizer: ${op}: Must have an input block number`)
      }
      if (target !== runState.stackPt.pop().value) {
        throw new Error(`Synthesizer: ${op}: Input data mismatch`)
      }
      dataPt = runState.synthesizer.loadBlkInf(target, op, runState.stack.peek(1)[0])
      break
    case 'COINBASE':
    case 'TIMESTAMP':
    case 'NUMBER':
    case 'DIFFICULTY':
    case 'GASLIMIT':
    case 'CHAINID':
    case 'SELFBALANCE':
    case 'BASEFEE':
    case 'BLOBBASEFEE':
      // These opcodes have no input and one output
      dataPt = runState.synthesizer.loadBlkInf(
        runState.env.block.header.number,
        op,
        runState.stack.peek(1)[0],
      )
      break
    default:
      throw new Error(`Synthesizer: Dealing with invalid block information instruction`)
  }
  runState.stackPt.push(dataPt)
  if (runState.stackPt.peek(1)[0].value !== runState.stack.peek(1)[0]) {
    throw new Error(`Synthesizer: ${op}: Output data mismatch`)
  }
}

export async function prepareEXTCodePt(
  runState: RunState,
  target: bigint,
  _offset?: bigint,
  _size?: bigint,
): Promise<DataPt> {
  const address = createAddressFromStackBigInt(target)
  let code = await runState.stateManager.getCode(address)
  let codeType = 'EXTCode'
  if (isEOF(code)) {
    // In legacy code, the target code is treated as to be "EOFBYTES" code
    code = EOFBYTES
    codeType = 'EXTCode(EOF)'
  }
  const codeOffset = _offset ?? 0n
  const dataLength = _size ?? BigInt(code.byteLength)
  const data = getDataSlice(code, codeOffset, dataLength)
  const dataBigint = bytesToBigInt(data)
  const codeOffsetNum = Number(codeOffset)
  const dataPt = runState.synthesizer.loadEnvInf(
    address.toString(),
    codeType,
    dataBigint,
    codeOffsetNum,
    Number(dataLength),
  )
  return dataPt
}

export async function synthesizerEnvInf(
  op: string,
  runState: RunState,
  target?: bigint,
  offset?: bigint,
): Promise<void> {
  // Handles only cases where Environment information is loaded to Stack. Other cases (~COPY) are handled directly in functionst.ts.
  let dataPt: DataPt
  switch (op) {
    case 'CALLDATALOAD': {
      // These opcodes have one input and one output
      if (offset === undefined) {
        throw new Error(`Synthesizer: ${op}: Must have an input offset`)
      }
      if (offset !== runState.stackPt.pop().value) {
        throw new Error(`Synthesizer: ${op}: Input data mismatch`)
      }
      const i = Number(offset)
      const calldataMemoryPts = runState.interpreter._env.callMemoryPts
      if (calldataMemoryPts.length > 0) {
        // Case: The calldata is originated from the parent context
        // Simulate a MemoryPt for the calldata
        const calldataMemoryPt = simulateMemoryPt(calldataMemoryPts)
        // View the memory and get the alias info
        const dataAliasInfos = calldataMemoryPt.getDataAlias(i, 32)
        if (dataAliasInfos.length > 0) {
          // Case: Data exists in the scope of view
          dataPt = runState.synthesizer.placeMemoryToStack(dataAliasInfos)
        } else {
          // Case: Data does not exist in the scope of view => 0 is loaded
          dataPt = runState.synthesizer.loadEnvInf(
            runState.env.address.toString(),
            'Calldata(Empty)',
            runState.stack.peek(1)[0],
            i,
          )
        }
      } else {
        // Case: The calldata is originated from the user (transciton) input
        dataPt = runState.synthesizer.loadEnvInf(
          runState.env.address.toString(),
          'Calldata(User)',
          runState.stack.peek(1)[0],
          i,
        )
      }
      break
    }
    case 'BALANCE':
    case 'EXTCODESIZE': {
      // These opcodes have one input and one output
      if (target === undefined) {
        throw new Error(`Synthesizer: ${op}: Must have an input address`)
      }
      if (target !== runState.stackPt.pop().value) {
        throw new Error(`Synthesizer: ${op}: Input data mismatch`)
      }
      dataPt = runState.synthesizer.loadEnvInf(target.toString(16), op, runState.stack.peek(1)[0])
      break
    }
    case 'EXTCODEHASH': {
      // These opcode has one input and one output
      if (target === undefined) {
        throw new Error(`Synthesizer: ${op}: Must have an input address`)
      }
      if (target !== runState.stackPt.pop().value) {
        throw new Error(`Synthesizer: ${op}: Input data mismatch`)
      }
      const codePt = await prepareEXTCodePt(runState, target)
      if (codePt.value === BIGINT_0) {
        dataPt = runState.synthesizer.loadAuxin(BIGINT_0)
      } else {
        dataPt = runState.synthesizer.loadKeccak([codePt], runState.stack.peek(1)[0])
      }
      break
    }
    case 'ADDRESS':
    case 'ORIGIN':
    case 'CALLER':
    case 'CALLVALUE':
    case 'CALLDATASIZE':
    case 'CODESIZE':
    case 'GASPRICE':
    case 'RETURNDATASIZE':
      // These opcodes have no input and one output
      dataPt = runState.synthesizer.loadEnvInf(
        runState.env.address.toString(),
        op,
        runState.stack.peek(1)[0],
      )
      break
    default:
      throw new Error(`Synthesizer: Dealing with invalid environment information instruction`)
  }
  runState.stackPt.push(dataPt)
  if (runState.stackPt.peek(1)[0].value !== runState.stack.peek(1)[0]) {
    throw new Error(`Synthesizer: ${op}: Output data mismatch`)
  }
}

/**
 * The Synthesizer class manages data related to subcircuits.
 *
 * @property {Placements} placements - Map storing subcircuit placement information.
 * @property {bigint[]} auxin - Array storing auxiliary input data.
 * @property {number} placementIndex - Current placement index.
 * @property {string[]} subcircuitNames - Array storing subcircuit names.
 */
export class Synthesizer {
  public placements: Placements
  public auxin: Auxin
  public envInf: Map<string, { value: bigint; wireIndex: number }>
  public blkInf: Map<string, { value: bigint; wireIndex: number }>
  public storagePt: Map<string, DataPt>
  public logPt: { topicPts: DataPt[]; valPt: DataPt }[]
  public TStoragePt: Map<string, Map<bigint, DataPt>>
  protected placementIndex: number
  private subcircuitNames
  readonly subcircuitInfoByName: SubcircuitInfoByName

  constructor() {
    this.auxin = new Map()
    this.envInf = new Map()
    this.blkInf = new Map()
    this.storagePt = new Map()
    this.logPt = []
    this.TStoragePt = new Map()
    // @ts-ignore
    this.subcircuitNames = subcircuits.map((circuit) => circuit.name)
    this.subcircuitInfoByName = new Map()
    for (const subcircuit of subcircuits) {
      const entryObject: SubcircuitInfoByNameEntry = {
        id: subcircuit.id,
        NWires: subcircuit.Nwires,
        NInWires: subcircuit.In_idx[1],
        NOutWires: subcircuit.Out_idx[1],
        inWireIndex: subcircuit.In_idx[0],
        outWireIndex: subcircuit.Out_idx[0],
      }
      this.subcircuitInfoByName.set(subcircuit.name, entryObject)
    }

    this.placements = new Map()
    this.placements.set(STORAGE_IN_PLACEMENT_INDEX, {
      ...STORAGE_IN_PLACEMENT,
      'subcircuitId': this.subcircuitInfoByName.get(STORAGE_IN_PLACEMENT.name)!.id
    })
    this.placements.set(STORAGE_OUT_PLACEMENT_INDEX, {
      ...STORAGE_OUT_PLACEMENT,
      'subcircuitId': this.subcircuitInfoByName.get(STORAGE_OUT_PLACEMENT.name)!.id
    })
    this.placements.set(LOAD_PLACEMENT_INDEX, {
      ...LOAD_PLACEMENT,
      'subcircuitId': this.subcircuitInfoByName.get(LOAD_PLACEMENT.name)!.id
    })
    this.placements.set(RETURN_PLACEMENT_INDEX, {
      ...RETURN_PLACEMENT,
      'subcircuitId': this.subcircuitInfoByName.get(RETURN_PLACEMENT.name)!.id
    })
    this.placements.set(KECCAK_IN_PLACEMENT_INDEX, {
      ...KECCAK_IN_PLACEMENT,
      'subcircuitId': this.subcircuitInfoByName.get(KECCAK_IN_PLACEMENT.name)!.id
    })
    this.placements.set(KECCAK_OUT_PLACEMENT_INDEX, {
      ...KECCAK_OUT_PLACEMENT,
      'subcircuitId': this.subcircuitInfoByName.get(KECCAK_OUT_PLACEMENT.name)!.id
    })
    
    this.placementIndex = INITIAL_PLACEMENT_INDEX
  }

  /**
   * Adds a new input-output pair to the LOAD subcircuit.
   * @param pointerIn - Input data point
   * @returns Generated output data point
   * @private
   */
  private _addWireToLoadPlacement(pointerIn: DataPt, storage?: boolean): DataPt {
    const targetPlacementIndex = storage === true ? STORAGE_IN_PLACEMENT_INDEX : LOAD_PLACEMENT_INDEX
    // Use the length of existing output list as index for new output
    if (
      this.placements.get(targetPlacementIndex)!.inPts.length !==
      this.placements.get(targetPlacementIndex)!.outPts.length
    ) {
      throw new Error(`Mismatches in the Load wires`)
    }
    const outWireIndex = this.placements.get(targetPlacementIndex)!.outPts.length

    // Create output data point
    const outPtRaw: CreateDataPointParams = {
      source: targetPlacementIndex,
      wireIndex: outWireIndex,
      value: pointerIn.value,
      sourceSize: DEFAULT_SOURCE_SIZE,
    }
    const pointerOut = DataPointFactory.create(outPtRaw)

    // Add input-output pair to the LOAD subcircuit
    this.placements.get(targetPlacementIndex)!.inPts.push(pointerIn)
    this.placements.get(targetPlacementIndex)!.outPts.push(pointerOut)

    return this.placements.get(targetPlacementIndex)!.outPts[outWireIndex]
  }

  /**
   * Adds a new input-output pair to the LOAD placement caused by the PUSH instruction.
   *
   * @param {string} codeAddress - Address of the code where PUSH was executed.
   * @param {number} programCounter - Program counter of the PUSH input argument.
   * @param {bigint} value - Value of the PUSH input argument.
   * @returns {void}
   */
  public loadPUSH(
    codeAddress: string,
    programCounter: number,
    value: bigint,
    size: number,
  ): DataPt {
    const inPtRaw: CreateDataPointParams = {
      source: `code: ${codeAddress}`,
      type: 'hardcoded',
      offset: programCounter + 1,
      value,
      sourceSize: size,
    }
    const pointerIn: DataPt = DataPointFactory.create(inPtRaw)

    return this._addWireToLoadPlacement(pointerIn)
  }

  public loadAuxin(value: bigint): DataPt {
    if (this.auxin.has(value)) {
      return this.placements.get(LOAD_PLACEMENT_INDEX)!.outPts[this.auxin.get(value)!]
    }
    const inPtRaw: CreateDataPointParams = {
      source: 'auxin',
      value,
      sourceSize: DEFAULT_SOURCE_SIZE,
    }
    const pointerIn = DataPointFactory.create(inPtRaw)
    const outPt = this._addWireToLoadPlacement(pointerIn)
    this.auxin.set(value, outPt.wireIndex!)
    return outPt
  }

  public loadEnvInf(
    codeAddress: string,
    type: string,
    value: bigint,
    _offset?: number,
    size?: number,
  ): DataPt {
    const offset = _offset ?? 0
    const whereItFrom = {
      source: `code: ${codeAddress}`,
      type,
      offset,
      length: size,
    }
    const key = JSON.stringify(whereItFrom)
    // if (this.envInf.has(key)) {
    //   return this.placements.get(LOAD_PLACEMENT_INDEX)!.outPts[this.envInf.get(key)!.wireIndex]
    // }
    const sourceSize = size ?? DEFAULT_SOURCE_SIZE
    const inPtRaw: CreateDataPointParams = {
      ...whereItFrom,
      value,
      sourceSize,
    }
    const pointerIn = DataPointFactory.create(inPtRaw)
    const outPt = this._addWireToLoadPlacement(pointerIn)
    const envInfEntry = {
      value,
      wireIndex: outPt.wireIndex!,
    }
    this.envInf.set(key, envInfEntry)
    return outPt
  }

  public loadStorage(codeAddress: string, key: bigint, value: bigint): DataPt {
    const keyString = JSON.stringify({ address: codeAddress, key: Number(key) })
    let outPt: DataPt
    if (this.storagePt.has(keyString)) {
      outPt = this.storagePt.get(keyString)!
    } else {
      const inPtRaw: CreateDataPointParams = {
        source: `storage: ${codeAddress}`,
        key,
        value,
        sourceSize: DEFAULT_SOURCE_SIZE,
      }
      const inPt = DataPointFactory.create(inPtRaw)
      outPt = this._addWireToLoadPlacement(inPt, true)
      this.storagePt.set(keyString, outPt)
    }
    return outPt
  }

  public storeStorage(codeAddress: string, key: bigint, inPt: DataPt): void {
    const keyString = JSON.stringify({ address: codeAddress, key: Number(key) })
    this.storagePt.set(keyString, inPt)
    const outWireIndex = this.placements.get(RETURN_PLACEMENT_INDEX)!.outPts.length
    // Create output data point
    const outPtRaw: CreateDataPointParams = {
      dest: `storage: ${codeAddress}`,
      key,
      value: inPt.value,
      sourceSize: DEFAULT_SOURCE_SIZE,
    }
    const outPt = DataPointFactory.create(outPtRaw)
    // Add input-output pair to the ReturnBuffer
    this.placements.get(STORAGE_OUT_PLACEMENT_INDEX)!.inPts.push(inPt)
    this.placements.get(STORAGE_OUT_PLACEMENT_INDEX)!.outPts.push(outPt)
  }

  public storeLog(valPt: DataPt, topicPts: DataPt[]): void {
    this.logPt.push({ valPt, topicPts })
    let outWireIndex = this.placements.get(RETURN_PLACEMENT_INDEX)!.outPts.length
    const inWireIndex = this.placements.get(RETURN_PLACEMENT_INDEX)!.inPts.length
    // Create output data point
    const outPtRaw: CreateDataPointParams = {
      dest: 'LOG',
      pairedInputWireIndices: [inWireIndex],
      wireIndex: outWireIndex++,
      value: valPt.value,
      sourceSize: DEFAULT_SOURCE_SIZE,
    }
    const valOutPt = DataPointFactory.create(outPtRaw)
    // Add input-output pair to the ReturnBuffer
    this.placements.get(RETURN_PLACEMENT_INDEX)!.inPts.push(valPt)
    this.placements.get(RETURN_PLACEMENT_INDEX)!.outPts.push(valOutPt)

    // Create output data point for topics
    for (const topicPt of topicPts) {
      const outPtRaw: CreateDataPointParams = {
        dest: 'LOG',
        pairedInputWireIndices: [inWireIndex],
        wireIndex: outWireIndex++,
        value: topicPt.value,
        sourceSize: DEFAULT_SOURCE_SIZE,
      }
      const topicOutPt = DataPointFactory.create(outPtRaw)
      this.placements.get(RETURN_PLACEMENT_INDEX)!.inPts.push(topicPt)
      this.placements.get(RETURN_PLACEMENT_INDEX)!.outPts.push(topicOutPt)
    }
  }

  public loadBlkInf(blkNumber: bigint, type: string, value: bigint): DataPt {
    const whereItFrom = {
      source: `block number: ${Number(blkNumber)}`,
      type,
    }
    const key = JSON.stringify(whereItFrom)
    if (this.blkInf.has(key)) {
      return this.placements.get(LOAD_PLACEMENT_INDEX)!.outPts[this.blkInf.get(key)!.wireIndex]
    }
    const inPtRaw: CreateDataPointParams = {
      ...whereItFrom,
      value,
      sourceSize: DEFAULT_SOURCE_SIZE,
    }
    const pointerIn = DataPointFactory.create(inPtRaw)
    const outPt = this._addWireToLoadPlacement(pointerIn)
    const blkInfEntry = {
      value,
      wireIndex: outPt.wireIndex!,
    }
    this.blkInf.set(key, blkInfEntry)
    return outPt
  }

  public loadKeccak(inPts: DataPt[], outValue: bigint, length?: bigint): DataPt {
    // Execute operation
    const nChunks = inPts.length
    let value = BIGINT_0
    for (let i = 0; i < nChunks; i++) {
      value += inPts[i].value << BigInt((nChunks - i - 1) * 32 * 8)
    }
    const valueInBytes = bigIntToBytes(value)
    const data = setLengthLeft(valueInBytes, Number(length) ?? valueInBytes.length)
    const _outValue = BigInt(bytesToHex(keccak256(data)))
    if (_outValue !== outValue) {
      throw new Error(`Synthesizer: loadKeccak: The Keccak hash may be customized`)
    }
    const inWireIndex = this.placements.get(KECCAK_IN_PLACEMENT_INDEX)!.inPts.length
    const pairedInputWireIndices = Array.from({ length: nChunks }, (_, i) => inWireIndex + i)
    const outWireIndex = this.placements.get(KECCAK_OUT_PLACEMENT_INDEX)!.outPts.length
    // Create output data point
    const outPtRaw: CreateDataPointParams = {
      source: KECCAK_OUT_PLACEMENT_INDEX,
      wireIndex: outWireIndex,
      pairedInputWireIndices,
      value: outValue,
      sourceSize: DEFAULT_SOURCE_SIZE,
    }
    const outPt = DataPointFactory.create(outPtRaw)

    // Add input-output pairs to the keccakBuffer subcircuit
    for (let i = 0; i < nChunks; i++) {
      this.placements.get(KECCAK_IN_PLACEMENT_INDEX)!.inPts[pairedInputWireIndices[i]] = inPts[i]
      this.placements.get(KECCAK_IN_PLACEMENT_INDEX)!.outPts[pairedInputWireIndices[i]] = inPts[i]
    }
    this.placements.get(KECCAK_OUT_PLACEMENT_INDEX)!.inPts.push(outPt)
    this.placements.get(KECCAK_OUT_PLACEMENT_INDEX)!.outPts.push(outPt)

    return this.placements.get(KECCAK_OUT_PLACEMENT_INDEX)!.outPts[outWireIndex]
  }

  /**
   * Adds a new MSTORE placement.
   * MSTORE is one of the Ethereum Virtual Machine (EVM) opcodes, which stores 32 bytes (256 bits) of data into memory.
   * EVM opcode description
   * MSTORE:
   * Function: Stores 32 bytes of data into memory at a specific memory location.
   * Stack operations: Pops two values from the stack. The first value is the memory address, and the second value is the data to be stored.
   * Example: MSTORE pops the memory address and data from the stack and stores the data at the specified memory address.
   *
   * @param {DataPt} inPt - Input data point.
   * @param {DataPt} outPt - Output data point.
   * @returns {void}
   * This method adds a new MSTORE placement by simulating the MSTORE opcode. If truncSize is less than dataPt.actualSize,
   * only the lower bytes of data are stored, and the upper bytes are discarded. The modified data point is returned.
   */
  public placeMSTORE(dataPt: DataPt, truncSize: number): DataPt {
    // MSTORE8 is used as truncSize=1, storing only the lowest 1 byte of data and discarding the rest.
    if (truncSize < dataPt.sourceSize) {
      // Since there is a modification in the original data, create a virtual operation to track this in Placements.
      // MSTORE8's modification is possible with AND operation (= AND(data, 0xff))
      const maskerString = '0x' + 'FF'.repeat(truncSize)

      const outValue = dataPt.value & BigInt(maskerString)
      if (dataPt.value !== outValue) {
        const subcircuitName = 'AND'
        const inPts: DataPt[] = [this.loadAuxin(BigInt(maskerString)), dataPt]
        const rawOutPt: CreateDataPointParams = {
          source: this.placementIndex,
          wireIndex: 0,
          value: outValue,
          sourceSize: truncSize,
        }
        const outPts: DataPt[] = [DataPointFactory.create(rawOutPt)]
        this._place(subcircuitName, inPts, outPts)

        return outPts[0]
      }
    }
    const outPt = dataPt
    outPt.sourceSize = truncSize
    return outPt
  }

  public placeEXP(inPts: DataPt[]): DataPt {
    SynthesizerValidator.validateSubcircuitName('SubEXP', this.subcircuitNames)
    // a^b
    const aPt = inPts[0]
    const bPt = inPts[1]
    const bNum = Number(bPt.value)
    const k = Math.floor(Math.log2(bNum)) + 1 //bit length of b

    const bitifyOutPts = this.placeArith('DecToBit', [bPt]).reverse()
    // LSB at index 0

    const chPts: DataPt[] = []
    const ahPts: DataPt[] = []
    chPts.push(this.loadAuxin(BIGINT_1))
    ahPts.push(aPt)

    for (let i = 1; i <= k; i++) {
      const _inPts = [chPts[i - 1], ahPts[i - 1], bitifyOutPts[i - 1]]
      const _outPts = this.placeArith('SubEXP', _inPts)
      chPts.push(_outPts[0])
      ahPts.push(_outPts[1])
    }

    return chPts[chPts.length - 1]
  }

  /**
   * Adds a new MLOAD placement.
   *
   * MLOAD is one of the Ethereum Virtual Machine (EVM) opcodes, which loads 32 bytes (256 bits) of data from memory.
   * @param {DataAliasInfos} dataAliasInfos - Array containing data source and modification information.
   * @returns {DataPt} Generated data point.
   */
  public placeMemoryToStack(dataAliasInfos: DataAliasInfos): DataPt {
    if (dataAliasInfos.length === 0) {
      throw new Error(`Synthesizer: placeMemoryToStack: Noting tho load`)
    }
    return this._resolveDataAlias(dataAliasInfos)
  }

  public placeMemoryToMemory(dataAliasInfos: DataAliasInfos): DataPt[] {
    if (dataAliasInfos.length === 0) {
      throw new Error(`Synthesizer: placeMemoryToMemory: Nothing to load`)
    }
    const copiedDataPts: DataPt[] = []
    for (const info of dataAliasInfos) {
      // the lower index, the older data
      copiedDataPts.push(this._applyMask(info, true))
    }
    return copiedDataPts
  }


  /**
  @todo: Validation needed for newDataPt size variable
   */
  private static readonly REQUIRED_INPUTS: Partial<Record<string, number>> = {
    ADDMOD: 3,
    MULMOD: 3,
    ISZERO: 1,
    NOT: 1,
    DecToBit: 1,
    SubEXP: 3,
  } as const
  private validateOperation(name: ArithmeticOperator, inPts: DataPt[]): void {
    // Default is 2, check REQUIRED_INPUTS only for exceptional cases
    const requiredInputs = Synthesizer.REQUIRED_INPUTS[name] ?? 2
    SynthesizerValidator.validateInputCount(name, inPts.length, requiredInputs)
    SynthesizerValidator.validateInputs(inPts)
  }

  private executeOperation(name: ArithmeticOperator, values: bigint[]): bigint | bigint[] {
    const operation = OPERATION_MAPPING[name]
    return operation(...values)
  }

  private createOutputPoint(value: bigint, _wireIndex?: number): DataPt {
    const wireIndex = _wireIndex ?? 0
    return DataPointFactory.create({
      source: this.placementIndex,
      wireIndex,
      value,
      sourceSize: DEFAULT_SOURCE_SIZE,
    })
  }

  private handleBinaryOp(name: ArithmeticOperator, inPts: DataPt[]): DataPt[] {
    try {
      // 1. Validate inputs
      this.validateOperation(name, inPts)

      // 2. Execute operation
      const values = inPts.map((pt) => pt.value)
      const outValue = this.executeOperation(name, values)

      // 3. Generate output
      let wireIndex = 0
      const outPts = Array.isArray(outValue)
        ? outValue.map((value) => this.createOutputPoint(value, wireIndex++))
        : [this.createOutputPoint(outValue)]

      // 4. Add placement
      this._place(name, inPts, outPts)

      return outPts
    } catch (error) {
      if (error instanceof InvalidInputCountError) {
        /*eslint-disable*/
        console.error(`Invalid input count for ${name}: ${error.message}`)
      }
      if (error instanceof SynthesizerError) {
        /*eslint-disable*/
        console.error(`Synthesizer error in ${name}: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Adds a new arithmetic placement.
   *
   * @param {string} name - Name of the placement. Examples: 'ADD', 'SUB', 'MUL', 'DIV'.
   * @param {DataPt[]} inPts - Array of input data points.
   * @returns {DataPt[]} Array of generated output data points.
   * @throws {Error} If an undefined subcircuit name is provided.
   */
  public placeArith(name: ArithmeticOperator, inPts: DataPt[]): DataPt[] {
    SynthesizerValidator.validateSubcircuitName(name, this.subcircuitNames)
    SynthesizerValidator.validateImplementedOpcode(name)
    return this.handleBinaryOp(name, inPts)
  }

  public adjustMemoryPts = (
    dataPts: DataPt[],
    memoryPts: MemoryPts,
    srcOffset: number,
    dstOffset: number,
    viewLength: number,
  ): void => {
    for (const [index, memoryPt] of memoryPts.entries()) {
      const containerOffset = memoryPt.memOffset
      const containerSize = memoryPt.containerSize
      const containerEndPos = containerOffset + containerSize
      const actualOffset = Math.max(srcOffset, containerOffset)
      const actualEndPos = Math.min(srcOffset + viewLength, containerEndPos)
      const actualContainerSize = actualEndPos - actualOffset
      const adjustedOffset = actualOffset - srcOffset + dstOffset
      memoryPt.memOffset = adjustedOffset
      memoryPt.containerSize = actualContainerSize

      const endingGap = containerEndPos - actualEndPos
      let outPts = [dataPts[index]]
      if (endingGap > 0) {
        // SHR data
        outPts = this.placeArith('SHR', [this.loadAuxin(BigInt(endingGap * 8)), dataPts[index]])
      }
      memoryPt.dataPt = outPts[0]
    }
  }

  /**
   * MLOAD always reads 32 bytes, but since the offset is in byte units, data transformation can occur.
   * Implement a function to track data transformations by checking for data modifications.
   * The getDataAlias(offset, size) function tracks the source of data from offset to offset + size - 1 in Memory.
   * The result may have been transformed through cutting or concatenating multiple data pieces.
   * The output type of getDataAlias is as follows:
   * type DataAliasInfos = {dataPt: DataPt, shift: number, masker: string}[]
   * For example, if dataAliasInfos array length is 3, the transformed data from that memory address
   * is a combination of 3 original data pieces.
   * The sources of the 3 original data are stored in dataPt,
   * Each original data is bit shifted by "shift" amount (left if negative, right if positive),
   * Then AND'ed with their respective "masker",
   * Finally, OR'ing all results will give the transformed data.
   **/

  /**
   * Creates a data point from an array of data sources and modification information.
   *
   * @param {DataAliasInfos} dataAliasInfos - Array containing data source and modification information.
   * @returns {DataPt} Generated data point.
   */
  private _resolveDataAlias(dataAliasInfos: DataAliasInfos): DataPt {
    const ADDTargets: { subcircuitID: number; wireID: number }[] = []
    // First, shift each dataPt and AND with mask
    const initPlacementIndex = this.placementIndex
    for (const info of dataAliasInfos) {
      let prevPlacementIndex = this.placementIndex
      // this method may increases the placementIndex
      this._applyShiftAndMask(info)
      if (prevPlacementIndex !== this.placementIndex) {
        ADDTargets.push({ subcircuitID: this.placementIndex - 1, wireID: 0 })
      } else {
        ADDTargets.push({
          subcircuitID: Number(info.dataPt.source),
          wireID: info.dataPt.wireIndex!,
        })
      }
    }

    const nDataAlias = ADDTargets.length

    if (nDataAlias > 1) {
      this._addAndPlace(ADDTargets)
    }

    if (initPlacementIndex === this.placementIndex) {
      // there was no alias or shift
      return dataAliasInfos[0].dataPt
    }
    return this.placements.get(this.placementIndex - 1)!.outPts[0]
  }

  private _applyShiftAndMask(info: DataAliasInfoEntry): DataPt {
    let shiftOutPt = info.dataPt
    shiftOutPt = this._applyShift(info)
    const modInfo: DataAliasInfoEntry = {
      dataPt: shiftOutPt,
      masker: info.masker,
      shift: info.shift,
    }
    let maskOutPt = modInfo.dataPt
    maskOutPt = this._applyMask(modInfo)
    return maskOutPt
  }

  /**
   * Applies shift operation.
   *
   * @param {bigint} shift - Shift value to apply.
   * @param {DataPt} dataPt - Data point.
   * @returns {bigint} Shifted value.
   */
  private _applyShift(info: DataAliasInfoEntry): DataPt {
    const { shift, dataPt } = info
    let outPts = [dataPt]
    if (Math.abs(shift) > 0) {
      // The relationship between shift value and shift direction is defined in MemoryPt
      const subcircuitName: ArithmeticOperator = shift > 0 ? 'SHL' : 'SHR'
      const absShift = Math.abs(shift)
      const inPts: DataPt[] = [this.loadAuxin(BigInt(absShift)), dataPt]
      outPts = this.placeArith(subcircuitName, inPts)
    }
    return outPts[0]
  }

  /**
   * Applies mask operation.
   *
   * @param {string} masker - Mask value to apply.
   * @param {bigint} dataPt - Pointer to apply the mask.
   */
  private _applyMask(info: DataAliasInfoEntry, unshift?: boolean): DataPt {
    let masker = info.masker
    const { shift, dataPt } = info
    if (unshift === true) {
      const maskerBigint = BigInt(masker)
      const unshiftMaskerBigint =
        shift > 0
          ? maskerBigint >> BigInt(Math.abs(shift))
          : maskerBigint << BigInt(Math.abs(shift))
      masker = '0x' + unshiftMaskerBigint.toString(16)
    }
    const maskOutValue = dataPt.value & BigInt(masker)
    let outPts = [dataPt]
    if (maskOutValue !== dataPt.value) {
      const inPts: DataPt[] = [this.loadAuxin(BigInt(masker)), dataPt]
      outPts = this.placeArith('AND', inPts)
    }
    return outPts[0]
  }

  /**
   * Adds all AND results together.
   *
   * @param {{subcircuitID: number, wireID: number}[]} addTargets - OR operation target indices array.
   */
  private _addAndPlace(addTargets: { subcircuitID: number; wireID: number }[]): void {
    let inPts: DataPt[] = [
      this.placements.get(addTargets[0].subcircuitID)!.outPts[addTargets[0].wireID],
      this.placements.get(addTargets[1].subcircuitID)!.outPts[addTargets[1].wireID],
    ]
    this.placeArith('ADD', inPts)

    for (let i = 2; i < addTargets.length; i++) {
      inPts = [
        this.placements.get(this.placementIndex - 1)!.outPts[0],
        this.placements.get(addTargets[i].subcircuitID)!.outPts[addTargets[i].wireID],
      ]
      this.placeArith('ADD', inPts)
    }
  }

  private _place(name: string, inPts: DataPt[], outPts: DataPt[]) {
    if (!this.subcircuitNames.includes(name)) {
      throw new Error(`Subcircuit name ${name} is not defined`)
    }
    for (const inPt of inPts) {
      if (typeof inPt.source !== 'number') {
        throw new Error(
          `Synthesizer: Placing a subcircuit: Input wires to a new placement must be connected to the output wires of other placements.`,
        )
      }
    }
    addPlacement(this.placements, {
      name,
      subcircuitId: this.subcircuitInfoByName.get(name)!.id,
      inPts,
      outPts,
    })
    this.placementIndex++
  }
}
