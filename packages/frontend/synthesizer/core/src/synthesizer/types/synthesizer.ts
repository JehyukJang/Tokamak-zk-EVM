import { RunTxResult } from '@ethereumjs/vm';
import { TokamakL2StateManager, TokamakL2Tx } from 'tokamak-l2js';
import { StateManager } from '../handlers/index.ts';
import { DataPt, DataPtType, Placements, PreparedComposition, ReservedVariable } from './index.ts';
import { SynthesizerOpHandler } from '../handlers/instructionHandler.ts';
import { ArithmeticSubcircuit, ReservedBuffer } from '../../subcircuit/configuredTypes.ts';
import type { ResolvedSubcircuitLibrary } from '../../subcircuit/libraryTypes.ts';
import type { BlockInfo } from '../../app/types.ts';

export interface SynthesizerOpts {
  signedTransaction: TokamakL2Tx
  blockInfo: BlockInfo
  stateManager: TokamakL2StateManager
}

export interface SynthesizerStepLogEntry {
  stack: string[]
  pc: number
  opcode: string
  keccak256Input?: string[]
}

export interface SynthesizerInterface {
  get state(): StateManager
  get placements(): Placements
  get stepLogs(): SynthesizerStepLogEntry[]
  get messageCodeAddresses(): Set<`0x${string}`>
  readonly subcircuitLibrary: ResolvedSubcircuitLibrary
  synthesizeTX(): Promise<RunTxResult>
  cachedOpts: SynthesizerOpts
}

export interface ISynthesizerProvider extends SynthesizerInterface {
  // from StateManager
  placeBuffer(
    buffer: ReservedBuffer,
    inPts: DataPt[],
    outPts: DataPt[],
    usage: string,
  ): void;
  placeComposition(preparedComposition: PreparedComposition): void;
  calculateArithSubcircuitOutputValues(
    name: ArithmeticSubcircuit,
    values: bigint[],
  ): bigint[];
  //from BufferManager
  loadArbitraryStatic(
    value: bigint,
    dataPtType: DataPtType,
    desc?: string,
  ): DataPt
  getReservedVariableFromBuffer(varName: ReservedVariable): DataPt
  addWirePairToBufferIn(inPt: DataPt, outPt: DataPt, dynamic?: boolean): DataPt
  addReservedVariableToBufferIn(varName: ReservedVariable, value?: bigint, dynamic?: boolean, message?: string): DataPt
  addReservedVariableToBufferOut(varName: ReservedVariable, symbolDataPt: DataPt, dynamic?: boolean, message?: string): DataPt
  //from instructionHandler
  get synthesizerHandlers(): Map<number, SynthesizerOpHandler>
}
