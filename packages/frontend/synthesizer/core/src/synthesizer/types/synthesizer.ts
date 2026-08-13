import { RunTxResult } from '@ethereumjs/vm';
import { TokamakL2StateManager, TokamakL2Tx } from 'tokamak-l2js';
import { DataPt, DataPtType, Placements, PreparedComposition, ReservedVariable } from './index.ts';
import { type CompositionSubcircuit } from '../../subcircuit/configuredTypes.ts';
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
  get placements(): Placements
  get stepLogs(): SynthesizerStepLogEntry[]
  get messageCodeAddresses(): readonly string[]
  readonly subcircuitLibrary: ResolvedSubcircuitLibrary
  synthesizeTX(): Promise<RunTxResult>
}

export interface ISynthesizerProvider {
  get placements(): Placements
  readonly subcircuitLibrary: ResolvedSubcircuitLibrary

  placeComposition(preparedComposition: PreparedComposition): void;
  calculateSubcircuitOutputValues(
    name: CompositionSubcircuit,
    values: bigint[],
  ): bigint[];
  loadArbitraryStatic(
    value: bigint,
    dataPtType: DataPtType,
    desc?: string,
  ): DataPt
  getReservedVariableFromBuffer(varName: ReservedVariable): DataPt
  addReservedVariableToBufferIn(varName: ReservedVariable, value?: bigint, dynamic?: boolean, message?: string): DataPt
  addReservedVariableToBufferOut(varName: ReservedVariable, symbolDataPt: DataPt, dynamic?: boolean, message?: string): DataPt
}
