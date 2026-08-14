import { SubcircuitNames } from "../../subcircuit/configuredTypes.ts";
import { DataPt } from "./dataStructure.ts";


export type PlacementEntry = {
  name: SubcircuitNames;
  usage: string
  subcircuitId: number;
  inPts: DataPt[];
  outPts: DataPt[];
};

export type Placements = PlacementEntry[];

export type CompositionOperands = readonly DataPt[] | readonly (readonly DataPt[])[];

export type PlacementVariableEntry = {
  subcircuitId: number;
  variables: string[];
  instanceList: string[];
};

export type PlacementVariables = PlacementVariableEntry[];
