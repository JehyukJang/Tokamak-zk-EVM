import { bytesToBigInt, hexToBigInt, toBytes } from '@ethereumjs/util';
import { jubjub } from "@noble/curves/misc.js";
import { DataPt, DataPtDescription, DataPtType, ISynthesizerProvider, ReservedVariable, SynthesizerOpts, VARIABLE_DESCRIPTION } from '../types/index.ts';
import { DataPtFactory } from '../dataStructure/index.ts';
import { BUFFER_DESCRIPTION, BUFFER_LIST } from '../../subcircuit/configuredTypes.ts';
import { FUNCTION_INPUT_LENGTH } from 'tokamak-l2js';
import type { StateManager } from './stateManager.ts';

export class BufferManager {
  constructor(
    private parent: ISynthesizerProvider,
    private readonly state: StateManager,
    private readonly cachedOpts: SynthesizerOpts,
  ) {
    this._initBuffers();
  }

  public addReservedVariableToBufferIn(varName: ReservedVariable, value: bigint = 0n, dynamic: boolean = false, message?: string): DataPt {
    const placementIndex = VARIABLE_DESCRIPTION[varName].source
    const wireDesc: DataPtDescription = {...VARIABLE_DESCRIPTION[varName], extSource: VARIABLE_DESCRIPTION[varName].extSource + (message ?? '')}
    const externalDataPt = DataPtFactory.create(wireDesc, value)
    if (dynamic) {
      if (wireDesc.wireIndex !== -1) {
        throw new Error('This variable is static')
      }
      externalDataPt.wireIndex = this.parent.placements[placementIndex]!.inPts.length
    }
    const symbolDataPt = DataPtFactory.createBufferTwin(externalDataPt)
    return DataPtFactory.deepCopy(this.parent.appendBufferWirePair(externalDataPt, symbolDataPt, dynamic))
  }

  public addReservedVariableToBufferOut(varName: ReservedVariable, symbolDataPt: DataPt, dynamic: boolean = false, message?: string): DataPt {
    const placementIndex = VARIABLE_DESCRIPTION[varName].source
    const wireDesc: DataPtDescription = {...VARIABLE_DESCRIPTION[varName], extDest: VARIABLE_DESCRIPTION[varName].extDest + (message ?? '')}
    const externalDataPt = DataPtFactory.create(wireDesc, symbolDataPt.value)
    if (dynamic) {
      if (wireDesc.wireIndex !== -1) {
        throw new Error('This variable is static')
      }
      externalDataPt.wireIndex = this.parent.placements[placementIndex]!.inPts.length
    } 
    return DataPtFactory.deepCopy(this.parent.appendBufferWirePair(symbolDataPt, externalDataPt, dynamic))
  }

  public loadArbitraryStatic(
    value: bigint,
    dataPtType: DataPtType,
    desc?: string,
  ): DataPt {
    const cacheKey = dataPtType
    if (desc === undefined) {
      const cachedDataPt = this.state.cachedEVMIn.get(value)?.get(cacheKey)
      if (cachedDataPt !== undefined) {
        return DataPtFactory.deepCopy(cachedDataPt)
      }
    }
    const placementIndex = BUFFER_LIST.findIndex(str => str === 'EVM_IN')
    const inPtRaw: DataPtDescription = {
      extSource: desc ?? 'Arbitrary constant',
      source: placementIndex,
      wireIndex: this.parent.placements[placementIndex]!.inPts.length,
      dataPtType,
    };
    const inPt = DataPtFactory.create(inPtRaw, value)
    const outPt = DataPtFactory.createBufferTwin(inPt)
    this.parent.appendBufferWirePair(inPt, outPt, true)
    const cachedByDomainAndLayout = this.state.cachedEVMIn.get(value) ?? new Map<string, DataPt>()
    cachedByDomainAndLayout.set(cacheKey, outPt)
    this.state.cachedEVMIn.set(value, cachedByDomainAndLayout)
    return DataPtFactory.deepCopy(outPt)
  }

  /**
   * Initializes the default placements for public/private inputs and outputs.
   */
  private _initBuffers(): void {
    for (const buffer of BUFFER_LIST) {
      this.parent.placeBuffer(
        buffer,
        new Array<DataPt>(0),
        new Array<DataPt>(0),
        BUFFER_DESCRIPTION[buffer],
      )
    }
    

    // Static public inputs
    this.addReservedVariableToBufferIn('CIRCOM_CONST_ONE', 1n)
    this.addReservedVariableToBufferIn('CIRCOM_CONST_ZERO', 0n)
    this.addReservedVariableToBufferIn('ADDRESS_MASK', (1n << 160n) - 1n)
    this.addReservedVariableToBufferIn('JUBJUB_BASE_X', jubjub.Point.BASE.toAffine().x)
    this.addReservedVariableToBufferIn('JUBJUB_BASE_Y', jubjub.Point.BASE.toAffine().y)
    this.addReservedVariableToBufferIn('JUBJUB_POI_X', jubjub.Point.ZERO.toAffine().x)
    this.addReservedVariableToBufferIn('JUBJUB_POI_Y', jubjub.Point.ZERO.toAffine().y)
    this.addReservedVariableToBufferIn('COINBASE', hexToBigInt(this.cachedOpts.blockInfo.coinBase))
    this.addReservedVariableToBufferIn('TIMESTAMP', hexToBigInt(this.cachedOpts.blockInfo.timeStamp))
    this.addReservedVariableToBufferIn('NUMBER', hexToBigInt(this.cachedOpts.blockInfo.blockNumber))
    this.addReservedVariableToBufferIn('PREVRANDAO', hexToBigInt(this.cachedOpts.blockInfo.prevRanDao))
    this.addReservedVariableToBufferIn('GASLIMIT', hexToBigInt(this.cachedOpts.blockInfo.gasLimit))
    this.addReservedVariableToBufferIn('CHAINID', hexToBigInt(this.cachedOpts.blockInfo.chainId))
    this.addReservedVariableToBufferIn('SELFBALANCE', hexToBigInt(this.cachedOpts.blockInfo.selfBalance))
    this.addReservedVariableToBufferIn('BASEFEE', hexToBigInt(this.cachedOpts.blockInfo.baseFee))
    for (let i = 1; i <= this.parent.subcircuitLibrary.numberOfPrevBlockHashes; i++) {
      this.addReservedVariableToBufferIn(`BLOCKHASH_${i}` as ReservedVariable, hexToBigInt(this.cachedOpts.blockInfo.prevBlockHashes[i-1]));
    }

    // Transaction inputs
    this._initTransactionBuffer()

    // Check if omitted buffer wires
    for (const [placementIndex, buffer] of BUFFER_LIST.entries()) {
      const actualNumberInWires = this.parent.placements[placementIndex]!.inPts.filter(wire => wire !== undefined).length
      const actualNumberOutWires = this.parent.placements[placementIndex]!.outPts.filter(wire => wire !== undefined).length
      if ( 
        actualNumberInWires -1 !== (this.parent.placements[placementIndex]!.inPts.at(-1)?.wireIndex ?? -1) ||
        actualNumberOutWires -1 !== (this.parent.placements[placementIndex]!.outPts.at(-1)?.wireIndex ?? -1)
      ) {
        throw new Error('Some wires are omitted while initializing buffers')
      }
      if ( actualNumberInWires !== actualNumberOutWires ) {
        throw new Error(`Input and output wires mismatch in ${buffer} buffer`)
      }
    }
  }

  private _initTransactionBuffer(): void {
    const l2Tx = this.cachedOpts.signedTransaction
    const senderPublicKey = l2Tx.getUnsafeEddsaPubKey()
    const randomizer = l2Tx.r === undefined ? undefined : l2Tx.getUnsafeEddsaRandomizer()
    this.addReservedVariableToBufferIn('EDDSA_PUBLIC_KEY_X', senderPublicKey.toAffine().x)
    this.addReservedVariableToBufferIn('EDDSA_PUBLIC_KEY_Y', senderPublicKey.toAffine().y)
    this.addReservedVariableToBufferIn('EDDSA_RANDOMIZER_X', randomizer?.toAffine().x)
    this.addReservedVariableToBufferIn('EDDSA_RANDOMIZER_Y', randomizer?.toAffine().y)
    this.addReservedVariableToBufferIn('EDDSA_SIGNATURE', l2Tx.s)
    this.addReservedVariableToBufferIn('CONTRACT_ADDRESS', bytesToBigInt(toBytes(l2Tx.to)))
    this.addReservedVariableToBufferIn('FUNCTION_SELECTOR', bytesToBigInt(l2Tx.getFunctionSelector()))
    this.addReservedVariableToBufferIn('TRANSACTION_NONCE', l2Tx.nonce)
    for (var inputIndex = 0; inputIndex < FUNCTION_INPUT_LENGTH; inputIndex ++) {
      this.addReservedVariableToBufferIn(
        `TRANSACTION_INPUT${inputIndex}` as ReservedVariable, 
        bytesToBigInt(l2Tx.getFunctionInput(inputIndex)),
      )
    }
  }

  public getReservedVariableFromBuffer(varName: ReservedVariable): DataPt {
    if (VARIABLE_DESCRIPTION[varName].extSource === undefined) {
      throw new Error('Usable only for reserved variables of input buffers')
    }
    const placementIndex = VARIABLE_DESCRIPTION[varName].source
    const wireIndex: number = VARIABLE_DESCRIPTION[varName].wireIndex
    const outPt = this.parent.placements[placementIndex]!.outPts[wireIndex]
    if (outPt.wireIndex !== wireIndex || outPt.source !== placementIndex) {
      throw new Error('Invalid wire information')
    }
    return DataPtFactory.deepCopy(outPt)
  }
}
