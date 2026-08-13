import { RunTxResult } from '@ethereumjs/vm';
import { TokamakL2StateManager, TokamakL2Tx } from 'tokamak-l2js';
import { DataAliasGeometries, DataPt, DataPtType, Placements, PreparedComposition, ReservedVariable } from './index.ts';
import { ReservedBuffer, type CompositionSubcircuit, type Operator } from '../../subcircuit/configuredTypes.ts';
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

  placeBuffer(
    buffer: ReservedBuffer,
    inPts: DataPt[],
    outPts: DataPt[],
    usage: string,
  ): void;
  placeComposition(preparedComposition: PreparedComposition): void;
  prepareMemoryLoadViewComposition(
    dataAliasGeometries: DataAliasGeometries,
    viewByteLength: number,
    basePlacementIndex: number,
  ): PreparedComposition;
  prepareFixedGenericComposition(
    operation: Operator,
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition;
  preparePoseidonComposition(
    operands: DataPt[],
    basePlacementIndex: number,
  ): PreparedComposition;
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
  appendBufferWirePair(inPt: DataPt, outPt: DataPt, dynamic?: boolean): DataPt
  addReservedVariableToBufferIn(varName: ReservedVariable, value?: bigint, dynamic?: boolean, message?: string): DataPt
  addReservedVariableToBufferOut(varName: ReservedVariable, symbolDataPt: DataPt, dynamic?: boolean, message?: string): DataPt
}
