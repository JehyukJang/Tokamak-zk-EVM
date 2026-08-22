import { Placements, PlacementVariables } from '../../synthesizer/types/placements.ts';
import {
  BUFFER_LIST,
  type ReservedBuffer,
  type SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import { VARIABLE_DESCRIPTION } from '../../synthesizer/types/buffers.ts';
import type { DataPt } from '../../synthesizer/types/dataStructure.ts';
import { addHexPrefix, hexToBigInt } from '@ethereumjs/util';
import type { ResolvedSubcircuitLibrary } from '../../subcircuit/libraryTypes.ts';
import type { Permutation } from '../types/types.ts';

type PlacementWireIndex = { globalWireId: number; placementId: number };

// This class instantiates the compiler model in Section "3.1 Compilers" of the Tokamak zk-SNARK paper.
export class PermutationGenerator {
  private permGroup: Set<string>[];
  // permultationY: {0, 1, ..., s_{max}-1} \times {0, 1, ..., l_D-l-1} -> {0, 1, ..., s_{max}-1}
  private permutationY: number[][];
  // permutationZ: {0, 1, ..., s_{max}-1} \times {0, 1, ..., l_D-l-1} -> {0, 1, ..., l_D-l-1}
  private permutationX: number[][];
  public permutation: Permutation;

  constructor(
    private readonly circuitPlacements: Placements,
    private readonly placementVariables: PlacementVariables,
    private readonly subcircuitLibrary: ResolvedSubcircuitLibrary,
  ) {
    this._assertPlacementVariableAlignment();
    this.permGroup = this._buildPermGroup();

    const { setupParams } = this.subcircuitLibrary.data;
    const numWires = setupParams.l_D - setupParams.l;
    const numPlacements = this.circuitPlacements.length;

    this.permutationY = Array.from({ length: numWires }, () => Array.from({ length: numPlacements }, (_, i) => i));

    this.permutationX = Array.from({ length: numWires }, (_, h) => Array.from({ length: numPlacements }, () => h));
    this.permutation = this._correctPermutation();
  }

  private _correctPermutation(): Permutation {
    const permutationFile: Permutation = [];
    const { setupParams } = this.subcircuitLibrary.data;
    const expectedInterfaceCells = this._validatePermGroupOwnership();
    const successorCount = new Map<string, number>();
    const predecessorCount = new Map<string, number>();
    for (const groupSet of this.permGroup) {
      const group = [...groupSet];
      const groupLength = group.length;
      for (let i = 0; i < groupLength; i++) {
        const element: PlacementWireIndex = JSON.parse(group[i]);
        const nextElement: PlacementWireIndex = JSON.parse(group[(i + 1) % groupLength]);
        this._assertPermutationCoordinate(element);
        this._assertPermutationCoordinate(nextElement);
        const elementKey = group[i]!;
        const nextElementKey = group[(i + 1) % groupLength]!;
        successorCount.set(elementKey, (successorCount.get(elementKey) ?? 0) + 1);
        predecessorCount.set(nextElementKey, (predecessorCount.get(nextElementKey) ?? 0) + 1);
        if (groupLength > 1) {
          const entry = {
            row: element.globalWireId - setupParams.l,
            col: element.placementId,
            X: nextElement.globalWireId - setupParams.l,
            Y: nextElement.placementId,
          };
          permutationFile.push(entry);
          this.permutationX[entry.row][entry.col] = entry.X;
          this.permutationY[entry.row][entry.col] = entry.Y;
        }
      }
    }
    for (const key of expectedInterfaceCells) {
      if (successorCount.get(key) !== 1 || predecessorCount.get(key) !== 1) {
        throw new Error('Permutation: Interface-cell relation is not bijective.');
      }
    }
    this._validatePermutation();
    return permutationFile;
  }

  private _buildPermGroup(): Set<string>[] {
    const permGroup: Set<string>[] = [];
    const { setupParams } = this.subcircuitLibrary.data;
    const subcircuitInfoByName = this.subcircuitLibrary.subcircuitInfoByName;

    // Initialize group representatives.
    // Each output wire of every placement is picked as a representative and forms a new group, if it is not a public wire.
    for (let placeId = 0; placeId < this.circuitPlacements.length; placeId++) {
      const thisPlacement = this.circuitPlacements[placeId]!;
      const thisSubcircuitInfo = subcircuitInfoByName.get(thisPlacement.name)!;
      for (let i = 0; i < thisSubcircuitInfo.NOutWires; i++) {
        const localWireId = thisSubcircuitInfo.outWireIndex + i;
        const globalWireId = thisSubcircuitInfo.flattenMap![localWireId];
        if (!(globalWireId >= setupParams.l && globalWireId < setupParams.l_D)) {
          break;
        }
        const entryKey = this._keyOf({ placementId: placeId, globalWireId });
        permGroup.push(new Set([entryKey]));
      }
    }

    // Place each input wire of every placement in the appropriate group, if it is not a public wire.
    // Identify which group the parent of each input wire belongs to.
    for (let thisPlacementId = 0; thisPlacementId < this.circuitPlacements.length; thisPlacementId++) {
      const thisPlacement = this.circuitPlacements[thisPlacementId]!;
      const thisSubcircuitInfo = subcircuitInfoByName.get(thisPlacement.name)!;
      for (let i = 0; i < thisSubcircuitInfo.NInWires; i++) {
        const thisLocalWireId = thisSubcircuitInfo.inWireIndex + i;
        const thisGlobalWireId = thisSubcircuitInfo.flattenMap![thisLocalWireId];
        if (!(thisGlobalWireId >= setupParams.l && thisGlobalWireId < setupParams.l_D)) {
          break;
        }
        const thisInPt = thisPlacement.inPts[i];
        const thisKey = this._keyOf({ placementId: thisPlacementId, globalWireId: thisGlobalWireId });

        let hasParent = false;
        if (thisInPt !== undefined && thisInPt.source !== thisPlacementId) {
          hasParent = true;
          const pointedPlacementId = thisInPt.source!;
          const pointedPlacement = this.circuitPlacements[pointedPlacementId]!;
          const pointedSubcircuitInfo = subcircuitInfoByName.get(pointedPlacement.name)!;
          // Looking for the parent of this wire
          const pointedOutputId = pointedPlacement.outPts.findIndex(
            candidateOutPt => candidateOutPt.wireIndex! === thisInPt.wireIndex!,
          );
          if (pointedOutputId === -1) {
            throw new Error(`Permutation: A wire is referring to nothing.`);
          }
          const pointedOutPt = pointedPlacement.outPts[pointedOutputId];
          if (thisInPt.value !== pointedOutPt.value) {
            throw new Error('Permutation: Synthesizer needs to be debugged.');
          }
          const pointedLocalWireId = pointedSubcircuitInfo.outWireIndex + pointedOutputId;
          const pointedGlobalWireId = pointedSubcircuitInfo.flattenMap![pointedLocalWireId];
          if (!(pointedGlobalWireId >= setupParams.l && pointedGlobalWireId < setupParams.l_D)) {
            throw new Error(`Permutation: A wire is referring to a public wire or an internal wire.`);
          }
          const parentKey = this._keyOf({ placementId: pointedPlacementId, globalWireId: pointedGlobalWireId });

          // Searching which group the parent belongs to and adding the child into there
          let inserted = false;
          for (const group of permGroup) {
            if (group.has(parentKey)) {
              group.add(thisKey);
              inserted = true;
              break;
            }
          }
          if (!inserted) {
            throw new Error('Synthesizer: A wire has a parent, which however does not belong to any group.');
          }
        }
        if (!hasParent) {
          if (!this._isPermittedUnparentedInput(thisPlacementId, thisPlacement.name, thisInPt)) {
            throw new Error('An input interface wire forms a group as a representative, although it is not qualified.');
          }
          permGroup.push(new Set([thisKey]));
        }
      }
    }

    // Forcely adding special permutation for the constant wires of all library subcircuits
    // The representative is CIRCOM_CONST_ONE, which should be in the current permGroup already.
    const repWirePlacementId = VARIABLE_DESCRIPTION.CIRCOM_CONST_ONE.source;
    const repWirePlacementWireIndex = VARIABLE_DESCRIPTION.CIRCOM_CONST_ONE.wireIndex;
    if (this.circuitPlacements[repWirePlacementId].outPts[repWirePlacementWireIndex].value !== 1n) {
      throw new Error(`Invalid pointer to CIRCOM_CONST_ONE wire`);
    }
    const repWireSubcircuitInfo = subcircuitInfoByName.get(this.circuitPlacements[repWirePlacementId].name)!;
    const repWireLocalId = repWireSubcircuitInfo.outWireIndex + repWirePlacementWireIndex;
    const repPermGroupKey = this._keyOf({
      placementId: VARIABLE_DESCRIPTION.CIRCOM_CONST_ONE.source,
      globalWireId: repWireSubcircuitInfo.flattenMap[repWireLocalId],
    });
    const repContainingGroupIndices: number[] = [];
    permGroup.forEach((group, i) => {
      if (group.has(repPermGroupKey)) repContainingGroupIndices.push(i);
    });
    if (repContainingGroupIndices.length !== 1) {
      throw new Error(`Something wrong with searching CIRCOM_CONST_ONE wire from the permutation group`);
    }
    const circomConstPermGroup = permGroup[repContainingGroupIndices[0]];
    for (const [placementId, placement] of this.circuitPlacements.entries()) {
      const subcircuitInfo = subcircuitInfoByName.get(placement.name)!;
      const key = this._keyOf({ placementId, globalWireId: subcircuitInfo.flattenMap[0] });
      circomConstPermGroup.add(key);
    }
    return permGroup;
  }

  private _isPermittedUnparentedInput(
    placementId: number,
    subcircuitName: SubcircuitNames,
    input: DataPt | undefined,
  ): boolean {
    const buffer = this._getBufferForSubcircuit(subcircuitName);
    if (buffer === undefined) return false;
    if (input === undefined) return true;
    if (input.source !== placementId) return false;
    return this.subcircuitLibrary.subcircuitBufferMapping[buffer]?.bufferDirection === 'in';
  }

  private _getBufferForSubcircuit(subcircuitName: SubcircuitNames): ReservedBuffer | undefined {
    const matches = BUFFER_LIST.filter(
      buffer => this.subcircuitLibrary.subcircuitBufferMapping[buffer]?.name === subcircuitName,
    );
    if (matches.length > 1) {
      throw new Error(`Permutation: ${subcircuitName} belongs to multiple buffers.`);
    }
    return matches[0];
  }

  private _validatePermGroupOwnership(): Set<string> {
    const { setupParams } = this.subcircuitLibrary.data;
    const expected = new Set<string>();
    const subcircuitInfoByName = this.subcircuitLibrary.subcircuitInfoByName;
    for (const [placementId, placement] of this.circuitPlacements.entries()) {
      const subcircuit = subcircuitInfoByName.get(placement.name)!;
      const localInterfaceWires = [
        0,
        ...Array.from({ length: subcircuit.NOutWires }, (_, index) => subcircuit.outWireIndex + index),
        ...Array.from({ length: subcircuit.NInWires }, (_, index) => subcircuit.inWireIndex + index),
      ];
      for (const localWireId of localInterfaceWires) {
        const globalWireId = subcircuit.flattenMap[localWireId];
        if (globalWireId === undefined) {
          throw new Error(`Permutation: ${placement.name} is missing an interface-wire map.`);
        }
        if (globalWireId >= setupParams.l && globalWireId < setupParams.l_D) {
          expected.add(this._keyOf({ placementId, globalWireId }));
        }
      }
    }

    const ownerByCell = new Map<string, number>();
    for (const [groupIndex, group] of this.permGroup.entries()) {
      for (const key of group) {
        if (!expected.has(key)) {
          throw new Error('Permutation: A group contains a non-interface cell.');
        }
        if (ownerByCell.has(key)) {
          throw new Error('Permutation: An interface cell belongs to multiple groups.');
        }
        ownerByCell.set(key, groupIndex);
      }
    }
    for (const key of expected) {
      if (!ownerByCell.has(key)) {
        throw new Error('Permutation: An interface cell belongs to no group.');
      }
    }
    return expected;
  }

  private _assertPermutationCoordinate(coordinate: PlacementWireIndex): void {
    const { setupParams } = this.subcircuitLibrary.data;
    if (
      !Number.isInteger(coordinate.placementId) ||
      !Number.isInteger(coordinate.globalWireId) ||
      coordinate.placementId < 0 ||
      coordinate.placementId >= this.circuitPlacements.length ||
      coordinate.globalWireId < setupParams.l ||
      coordinate.globalWireId >= setupParams.l_D
    ) {
      throw new Error('Permutation: Coordinate is outside the internal interface domain.');
    }
  }

  private _validatePermutation(): void {
    const { setupParams } = this.subcircuitLibrary.data;
    const subcircuitInfoByName = this.subcircuitLibrary.subcircuitInfoByName;
    let permutationDetected = false;
    const circomConsts = Array(setupParams.l_D).fill('0x01');
    let b: string[][] = []; // ab.size = l_D \times s_max
    for (const [placementId, placementVariablesEntry] of this.placementVariables.entries()) {
      const variables = placementVariablesEntry.variables;
      const subcircuitInfo = subcircuitInfoByName.get(this.circuitPlacements[placementId]!.name)!;
      if (subcircuitInfo.flattenMap![subcircuitInfo.outWireIndex] >= setupParams.l_D) {
        throw new Error('Incorrect flatten map');
      }
      let ab = [...circomConsts];
      for (const [start, count] of [
        [subcircuitInfo.outWireIndex, subcircuitInfo.NOutWires],
        [subcircuitInfo.inWireIndex, subcircuitInfo.NInWires],
      ] as const) {
        for (let localIdx = start; localIdx < start + count; localIdx++) {
          const globalIdx = subcircuitInfo.flattenMap![localIdx];
          ab[globalIdx] = variables[localIdx];
        }
      }
      b[placementId] = ab.slice(setupParams.l, setupParams.l_D);
    }
    for (let i = 0; i < b.length; i++) {
      for (let j = 0; j < setupParams.l_D - setupParams.l; j++) {
        const i2 = this.permutationY[j][i];
        const j2 = this.permutationX[j][i];
        if (i != i2 || j != j2) {
          permutationDetected = true;
          if (hexToBigInt(addHexPrefix(b[i][j])) != hexToBigInt(addHexPrefix(b[i2][j2]))) {
            throw new Error(`Permutation: Permutation does not hold.`);
          }
        }
      }
    }
    if (permutationDetected === false) {
      throw new Error(`Synthesizer: Warning: No permutation detected!`);
    } else {
      console.log(`Synthesizer: Permutation check clear`);
    }
  }

  private _keyOf(obj: PlacementWireIndex): string {
    return JSON.stringify(obj);
  }

  private _assertPlacementVariableAlignment(): void {
    if (this.circuitPlacements.length !== this.placementVariables.length) {
      throw new Error(
        `Permutation: ${this.circuitPlacements.length} placements do not match ${this.placementVariables.length} variable entries`,
      );
    }
    for (const [placementId, placement] of this.circuitPlacements.entries()) {
      if (placement.subcircuitId !== this.placementVariables[placementId]!.subcircuitId) {
        throw new Error(`Permutation: placement ${placementId} does not match its variable entry subcircuit ID`);
      }
    }
  }
}
