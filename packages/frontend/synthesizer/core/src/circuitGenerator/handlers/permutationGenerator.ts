import { Placements, PlacementVariables } from '../../synthesizer/types/placements.ts';
import {
  BUFFER_LIST,
  type ReservedBuffer,
  type SubcircuitInfoByNameEntry,
  type SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import { VARIABLE_DESCRIPTION } from '../../synthesizer/types/buffers.ts';
import type { DataPt } from '../../synthesizer/types/dataStructure.ts';
import { addHexPrefix, hexToBigInt } from '@ethereumjs/util';
import type { ResolvedSubcircuitLibrary } from '../../subcircuit/libraryTypes.ts';
import type { Permutation } from '../types/types.ts';
import type { VariableGenerationResult } from './variableGenerator.ts';

type PlacementWireIndex = { globalWireId: number; placementId: number };

// This class instantiates the compiler model in Section "3.1 Compilers" of the Tokamak zk-SNARK paper.
export class PermutationGenerator {
  private placementVariables: PlacementVariables;
  private circuitPlacements: Placements;

  // Each entry in permGroup represents a permutation subgroup.
  // Each subgroup will be expressed in a Map to efficiently check whether it involves a wire or not.
  // The key of each Map will be a stringified PlacementWireIndex.
  private permGroup: Map<string, boolean>[];
  // permultationY: {0, 1, ..., s_{max}-1} \times {0, 1, ..., l_D-l-1} -> {0, 1, ..., s_{max}-1}
  private permutationY: number[][];
  // permutationZ: {0, 1, ..., s_{max}-1} \times {0, 1, ..., l_D-l-1} -> {0, 1, ..., l_D-l-1}
  private permutationX: number[][];
  public permutation: Permutation;

  constructor(
    variableGeneration: VariableGenerationResult,
    private readonly subcircuitLibrary: ResolvedSubcircuitLibrary,
  ) {
    this.circuitPlacements = variableGeneration.circuitPlacements;
    this.placementVariables = variableGeneration.placementVariables;
    // Construct permutation
    this.permGroup = this._buildPermGroup();

    // Initialization for the permutation polynomials in equation 8 of the paper
    const { setupParams } = this.subcircuitLibrary.data;
    const numWires = setupParams.l_D - setupParams.l;
    const numPlacements = this.circuitPlacements.length;

    this.permutationY = Array.from({ length: numWires }, () => Array.from({ length: numPlacements }, (_, i) => i));
    // Example:
    // [
    //   [0, 1, 2, 3],
    //   [0, 1, 2, 3],
    //   [0, 1, 2, 3]
    // ]

    this.permutationX = Array.from({ length: numWires }, (_, h) => Array.from({ length: numPlacements }, () => h));
    // Example:
    // [
    //   [0, 0, 0, 0],
    //   [1, 1, 1, 1],
    //   [2, 2, 2, 2]
    // ]
    // "permutationY[i][h]=j and permutationX[i][h]=k" means that the i-th wire of the h-th placement is a copy of the k-th wire of the j-th placement.

    // Now finally correct permutationY and permutationX according to permGroup
    this.permutation = this._correctPermutation();
  }

  private _correctPermutation(): {
    row: number;
    col: number;
    X: number;
    Y: number;
  }[] {
    let permutationFile = [];
    const { setupParams } = this.subcircuitLibrary.data;
    const expectedInterfaceCells = this._validatePermGroupOwnership();
    const successorCount = new Map<string, number>();
    const predecessorCount = new Map<string, number>();
    for (const _group of this.permGroup) {
      const group = [..._group.keys()];
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
          permutationFile.push({
            // wire id
            row: element.globalWireId - setupParams.l,
            // placement id
            col: element.placementId,
            // wire id
            X: nextElement.globalWireId - setupParams.l,
            // placement id
            Y: nextElement.placementId,
          });
          const rowIdx = permutationFile[permutationFile.length - 1].row;
          const colIdx = permutationFile[permutationFile.length - 1].col;
          this.permutationX[rowIdx][colIdx] = permutationFile[permutationFile.length - 1].X;
          this.permutationY[rowIdx][colIdx] = permutationFile[permutationFile.length - 1].Y;
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

  private _buildPermGroup(): Map<string, boolean>[] {
    const permGroup: Map<string, boolean>[] = [];
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
        const groupEntry: Map<string, boolean> = new Map();
        groupEntry.set(entryKey, true);
        permGroup.push(groupEntry);
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
              group.set(thisKey, true);
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
          const groupEntry: Map<string, boolean> = new Map();
          groupEntry.set(thisKey, true);
          permGroup.push(groupEntry);
        }
      }
      // console.log(`Length inc: ${thisSubcircuitInfo.NInWires}`)
      // let checksum = 0
      // for (const group of permGroup){
      //     checksum += group.size
      // }
      // console.log(`checksum: ${checksum}`)
      // console.log(`a`)
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
    permGroup.forEach((m, i) => {
      if (m.has(repPermGroupKey)) repContainingGroupIndices.push(i);
    });
    if (repContainingGroupIndices.length !== 1) {
      throw new Error(`Something wrong with searching CIRCOM_CONST_ONE wire from the permutation group`);
    }
    const circomConstPermGroup = permGroup[repContainingGroupIndices[0]];
    for (const [placementId, placement] of this.circuitPlacements.entries()) {
      const subcircuitInfo = subcircuitInfoByName.get(placement.name)!;
      const key = this._keyOf({ placementId, globalWireId: subcircuitInfo.flattenMap[0] });
      circomConstPermGroup.set(key, true);
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
      for (const key of group.keys()) {
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
      const idxSet = new IdxSet(subcircuitInfo);
      if (subcircuitInfo.flattenMap![idxSet.idxOut] >= setupParams.l_D) {
        throw new Error('Incorrect flatten map');
      }
      let ab = [...circomConsts];
      //Iterating for all output and input (local) variables
      for (let localIdx = idxSet.idxOut; localIdx < idxSet.idxPrv; localIdx++) {
        const globalIdx = subcircuitInfo.flattenMap![localIdx];
        ab[globalIdx] = variables[localIdx];
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
}

// An auxiliary class
class IdxSet {
  NConstWires = 1;
  NOutWires: number;
  NInWires: number;
  NWires: number;
  idxOut: number;
  idxIn: number;
  idxPrv: number;
  flattenMap: number[];
  constructor(subcircuitInfo: SubcircuitInfoByNameEntry) {
    this.NOutWires = subcircuitInfo.NOutWires;
    this.NInWires = subcircuitInfo.NInWires;
    this.NWires = subcircuitInfo.NWires;
    this.idxOut = this.NConstWires;
    this.idxIn = this.idxOut + this.NOutWires;
    this.idxPrv = this.idxIn + this.NInWires;

    if (!Array.isArray(subcircuitInfo.flattenMap) || subcircuitInfo.flattenMap.length == 0) {
      throw new Error(`IdxSet: SubcircuitInfo is missing required flattenMap for ${subcircuitInfo.id}`);
    }
    this.flattenMap = subcircuitInfo.flattenMap;
  }
}
