import { Operator, SubcircuitNames } from "../../subcircuit/configuredTypes.ts";
import { DataPt } from "./dataStructure.ts";


export type PlacementEntry = {
  name: SubcircuitNames;
  usage: string
  subcircuitId: number;
  inPts: DataPt[];
  outPts: DataPt[];
};

export type Placements = PlacementEntry[];

export type PreparedCompositionStep = Readonly<{
  inPts: readonly DataPt[];
  outPts: readonly DataPt[];
}>;

export type PreparedComposition = Readonly<{
  operation: Operator;
  operands: readonly DataPt[];
  resultPts: readonly DataPt[];
  steps: readonly PreparedCompositionStep[];
}>;

export type PlacementVariableEntry = {
  subcircuitId: number;
  variables: string[];
  instanceList: string[];
};

export type PlacementVariables = PlacementVariableEntry[];

// export type SynthesizerState = {
//   placements: Placements;
//   auxin: Auxin;
//   envInf: Map<string, { value: bigint; wireIndex: number }>;
//   blkInf: Map<string, { value: bigint; wireIndex: number }>;
//   storagePt: Map<string, DataPt>;
//   logPt: { topicPts: DataPt[]; valPts: DataPt[] }[];
//   keccakPt: { inValues: bigint[]; outValue: bigint }[];
//   TStoragePt: Map<string, Map<bigint, DataPt>>;
// };
