import type { SetupParams } from "../../artifacts/setup/setup-params.js";
import type { FieldElement } from "../../runtime/field/field-types.js";

export interface ProverSubcircuitInfo {
  readonly id: number;
  readonly name: string;
  readonly Nwires: number;
  readonly Nconsts: number;
  readonly Out_idx: readonly number[];
  readonly In_idx: readonly number[];
  readonly flattenMap: readonly number[];
  readonly bufferDirection?: "in" | "out";
}

export interface ProverPlacementVariables {
  readonly subcircuitIds: Uint32Array;
  readonly variableOffsets: Uint32Array;
  readonly variables: Uint8Array;
  readonly fieldByteLength: number;
}

export interface ProverPackedSparseMatrix {
  readonly activeWires: readonly number[];
  readonly rowOffsets: Uint8Array;
  readonly columns: Uint8Array;
  readonly coefficients: Uint8Array;
  readonly rowCount: number;
}

export interface ProverPackedSparseSubcircuitR1cs {
  readonly subcircuitId: number;
  readonly A: ProverPackedSparseMatrix;
  readonly B: ProverPackedSparseMatrix;
  readonly C: ProverPackedSparseMatrix;
}

export function validateProverPlacements(
  placements: ProverPlacementVariables,
  subcircuitInfos: readonly ProverSubcircuitInfo[],
  setup: SetupParams,
): void {
  if (placements.fieldByteLength <= 0) throw new Error("Placement field width must be positive.");
  if (placements.variables.byteLength % placements.fieldByteLength !== 0) {
    throw new Error("Placement values are not aligned to the field width.");
  }
  if (placements.variableOffsets.length !== placements.subcircuitIds.length + 1) {
    throw new Error("Placement offsets must contain one terminal entry.");
  }
  if (placements.variableOffsets[0] !== 0) throw new Error("Placement offsets must start at zero.");
  if (placements.variableOffsets.at(-1) !== placements.variables.byteLength / placements.fieldByteLength) {
    throw new Error("The terminal placement offset does not match the value count.");
  }
  if (placementCount(placements) > setup.s_max) throw new Error("Placement count exceeds s_max.");
  for (let index = 0; index < placementCount(placements); index += 1) {
    const subcircuitId = placementSubcircuitId(placements, index);
    const info = subcircuitInfos[subcircuitId];
    if (info === undefined) throw new Error(`Placement ${index} has an unknown subcircuit ID.`);
    if (placementVariableCount(placements, index) !== info.flattenMap.length) {
      throw new Error(`Placement ${index} width does not match subcircuit ${subcircuitId}.`);
    }
  }
}

export function placementCount(placements: ProverPlacementVariables): number {
  return placements.subcircuitIds.length;
}

export function placementSubcircuitId(
  placements: ProverPlacementVariables,
  placementIndex: number,
): number {
  const subcircuitId = placements.subcircuitIds[placementIndex];
  if (subcircuitId === undefined) throw new Error(`Placement index ${placementIndex} is out of bounds.`);
  return subcircuitId;
}

export function placementVariableCount(
  placements: ProverPlacementVariables,
  placementIndex: number,
): number {
  const start = placements.variableOffsets[placementIndex];
  const end = placements.variableOffsets[placementIndex + 1];
  if (start === undefined || end === undefined || end < start) {
    throw new Error(`Placement variable range ${placementIndex} is invalid.`);
  }
  return end - start;
}

export function placementVariableAt(
  placements: ProverPlacementVariables,
  placementIndex: number,
  localIndex: number,
): FieldElement {
  const start = placements.variableOffsets[placementIndex];
  const end = placements.variableOffsets[placementIndex + 1];
  const valueIndex = start === undefined ? -1 : start + localIndex;
  if (
    end === undefined
    || !Number.isSafeInteger(localIndex)
    || localIndex < 0
    || valueIndex < 0
    || valueIndex >= end
  ) {
    throw new Error(`Placement variable index ${placementIndex}:${localIndex} is out of bounds.`);
  }
  const offset = valueIndex * placements.fieldByteLength;
  return placements.variables.subarray(offset, offset + placements.fieldByteLength);
}
