import { addHexPrefix, bigIntToHex } from '@ethereumjs/util';
import { BUFFER_LIST } from '../../subcircuit/configuredTypes.ts';
import { DataPtFactory } from '../../synthesizer/dataStructure/dataPt.ts';
import { getDataPtWireCount, type DataPt } from '../../synthesizer/types/dataStructure.ts';
import {
  PlacementEntry,
  Placements,
  PlacementVariables,
  placementEntryDeepCopy,
  placementsDeepCopy,
} from '../../synthesizer/types/placements.ts';
import { builder } from '../utils/witness_calculator.ts';
import { VARIABLE_DESCRIPTION } from '../../synthesizer/types/buffers.ts';
import type { ResolvedSubcircuitLibrary } from '../../subcircuit/libraryTypes.ts';
import type { SynthesizerInterface } from '../../synthesizer/types/index.ts';
import type { PublicInstance, PublicInstanceDescription } from '../types/types.ts';

export type VariableGenerationResult = Readonly<{
  circuitPlacements: Placements;
  placementVariables: PlacementVariables;
  publicInstance: PublicInstance;
  publicInstanceDescription: PublicInstanceDescription;
}>;

export class VariableGenerator {
  constructor(
    private readonly synthesizer: SynthesizerInterface,
    private readonly subcircuitLibrary: ResolvedSubcircuitLibrary,
  ) {}

  public async generate(): Promise<VariableGenerationResult> {
    const oldPlacements = this.synthesizer.placements;
    const newPlacements = placementsDeepCopy(oldPlacements);
    this._removeUnusedWiresFromEVMInBuffer(oldPlacements, newPlacements);
    this._convertEVMWiresIntoCircomWires(newPlacements);
    this._validateBufferSizes(newPlacements);

    const placementVariables = await this._generatePlacementVariables(newPlacements);
    const publicProjection = this._extractPublicProjection(placementVariables);
    return {
      circuitPlacements: newPlacements,
      placementVariables,
      ...publicProjection,
    };
  }

  private _prepareCircuitInstance(
    placement: PlacementEntry,
    target: 'In' | 'Out',
  ): {
    values: `0x${string}`[];
    descriptions: string[];
  } {
    const origPts = target === 'In' ? placement.inPts : placement.outPts;
    const materializedPts = Array.from({ length: origPts.length }, (_, index) => origPts[index]);
    if (materializedPts.some(point => point === undefined)) {
      throw new Error(`Placement ${placement.name} has a sparse ${target} wire list`);
    }
    const isBuffer = BUFFER_LIST.some(
      buffer => this.subcircuitLibrary.subcircuitBufferMapping[buffer]?.name === placement.name,
    );
    const origValues = origPts.map(pt => addHexPrefix(pt.valueHex));
    const origDescs = origPts.map(pt => {
      const desc = target === 'In' ? pt.extSource : pt.extDest;
      return desc ?? '';
    });
    // Preparing input values
    const expectedLen =
      target === 'In'
        ? this.subcircuitLibrary.subcircuitInfoByName.get(placement.name)!.NInWires
        : this.subcircuitLibrary.subcircuitInfoByName.get(placement.name)!.NOutWires;
    if (expectedLen < origValues.length) {
      throw new Error(`Placement at index ${placement.name} has excessive number of ${target} wires`);
    }
    if (expectedLen > origValues.length) {
      if (!isBuffer) {
        throw new Error(
          `Placement ${placement.name} has ${origValues.length} ${target} wires, expected ${expectedLen}`,
        );
      }
      return {
        values: origValues.concat(Array(expectedLen - origValues.length).fill('0x00')),
        descriptions: origDescs.concat(Array(expectedLen - origValues.length).fill('')),
      };
    } else {
      return {
        values: origValues,
        descriptions: origDescs,
      };
    }
  }

  private async _generatePlacementVariables(placements: Placements): Promise<PlacementVariables> {
    const placementVariables = await Promise.all(
      Array.from(placements.entries()).map(async ([placementId, placement]) => {
        // Preparing inpu values
        const ins = this._prepareCircuitInstance(placement, 'In');

        // Preparing output values
        const outs = this._prepareCircuitInstance(placement, 'Out');

        let variables: string[];
        try {
          variables = await this._generateSubcircuitWitness(placement.subcircuitId!, ins.values);
        } catch (err) {
          console.log(`Placement index: ${placementId}`);
          console.log(`Subcircuit name: ${placement.name}`);
          throw new Error(err as string);
        }

        const subcircuitInfo = this.subcircuitLibrary.subcircuitInfoByName.get(placement.name)!;
        for (let i = 0; i < outs.values.length; i++) {
          if (BigInt(variables[subcircuitInfo.outWireIndex + i]!) !== BigInt(outs.values[i]!)) {
            throw new Error(
              `Instance check failed in the ${placementId}-th placement (subcircuit name: ${placement.name})`,
            );
          }
        }
        if (subcircuitInfo.flattenMap.length !== variables.length) {
          throw new Error(`Flatten map cannot be applied to the placement variables due to difference lengths`);
        }
        const instanceList = Array<string>(subcircuitInfo.NWires).fill('');
        outs.descriptions.forEach((description, index) => {
          instanceList[subcircuitInfo.outWireIndex + index] = description;
        });
        ins.descriptions.forEach((description, index) => {
          instanceList[subcircuitInfo.inWireIndex + index] = description;
        });
        return {
          subcircuitId: placement.subcircuitId,
          variables,
          instanceList,
        };
      }),
    );

    console.log('');
    console.log(`Synthesizer: All ${placements.length} placement instances passed the subcircuits`);

    return placementVariables;
  }

  private _extractPublicProjection(
    placementVariables: PlacementVariables,
  ): Pick<VariableGenerationResult, 'publicInstance' | 'publicInstanceDescription'> {
    const { globalWireList, setupParams } = this.subcircuitLibrary.data;
    const values: `0x${string}`[] = Array(setupParams.l).fill('0x00');
    const descriptions: string[] = Array(setupParams.l).fill('');
    for (let globalIdx = 0; globalIdx < setupParams.l; globalIdx++) {
      const [subcircuitId, localVariableIdx] = globalWireList[globalIdx];
      if (subcircuitId !== -1 && localVariableIdx !== -1) {
        const publicBuffers = BUFFER_LIST.filter(
          buffer =>
            this.subcircuitLibrary.subcircuitBufferMapping[buffer]?.id === subcircuitId && buffer !== 'PRIVATE_IN',
        );
        if (publicBuffers.length !== 1) {
          throw new Error(`Public wire ${globalIdx} does not belong to one declared public buffer`);
        }
        const placements = placementVariables.filter(entry => entry.subcircuitId === subcircuitId);
        if (placements.length !== 1) {
          throw new Error(`Public buffer ${publicBuffers[0]} must have exactly one runtime placement`);
        }
        const placement = placements[0]!;
        const value = placement.variables[localVariableIdx];
        const description = placement.instanceList[localVariableIdx];
        if (value === undefined || description === undefined) {
          throw new Error('Something wrong in the Global Wire List or local placement variables. Need to be debugged.');
        }
        values[globalIdx] = addHexPrefix(value);
        descriptions[globalIdx] = description;
      }
    }
    const { l_user, l_free } = this.subcircuitLibrary.data.setupParams;
    return {
      publicInstance: {
        a_pub_user: values.slice(0, l_user),
        a_pub_block: values.slice(l_user, l_free),
        a_pub_function: values.slice(l_free),
      },
      publicInstanceDescription: {
        a_pub_user_description: descriptions.slice(0, l_user),
        a_pub_block_description: descriptions.slice(l_user, l_free),
        a_pub_function_description: descriptions.slice(l_free),
      },
    };
  }

  private _expandDataPtIntoCircomWires(origDataPt: DataPt): DataPt[] {
    const newDataPts: DataPt[] = [];
    const copied = DataPtFactory.deepCopy(origDataPt);
    if (getDataPtWireCount(origDataPt.dataPtType) === 2) {
      const lowerVal = copied.value & ((1n << 128n) - 1n);
      const upperVal = copied.value >> 128n;
      if (upperVal * (1n << 128n) + lowerVal !== copied.value) {
        throw new Error('Mismatch between original and expanded limb values');
      }
      // Lower bytes
      newDataPts.push({
        ...copied,
        extDest: copied.extDest === undefined ? undefined : copied.extDest + ` (lower 16 bytes)`,
        extSource: copied.extSource === undefined ? undefined : copied.extSource + ` (lower 16 bytes)`,
        value: lowerVal,
        valueHex: bigIntToHex(lowerVal),
      });

      // Upper bytes
      newDataPts.push({
        ...copied,
        extDest: copied.extDest === undefined ? undefined : copied.extDest + ` (upper 16 bytes)`,
        extSource: copied.extSource === undefined ? undefined : copied.extSource + ` (upper 16 bytes)`,
        value: upperVal,
        valueHex: bigIntToHex(upperVal),
      });
      return newDataPts;
    } else {
      return [copied];
    }
  }

  /**
   * Removes EVM_IN wires that are not referenced by any other placement's input points.
   * Returns a new PlacementEntry with filtered inPts and outPts arrays.
   */
  private _removeUnusedWiresFromEVMInBuffer(oldPlacements: Placements, newPlacements: Placements): void {
    const EVMInPlacementIndex = BUFFER_LIST.findIndex(str => str === 'EVM_IN');
    const oldEVMInPlacement = oldPlacements[EVMInPlacementIndex]!;
    const newEVMInPlacement = placementEntryDeepCopy(oldEVMInPlacement);

    // Collect wire indices of outPts that are referenced by any other placement's inPts
    const referencedWireIndices = new Set<number>();
    for (const [key, placement] of oldPlacements.entries()) {
      if (key === EVMInPlacementIndex) continue;
      for (const inPt of placement.inPts) {
        if (inPt.source === EVMInPlacementIndex) {
          referencedWireIndices.add(inPt.wireIndex);
        }
      }
    }

    // Forcely add CIRCOM_CONST_ONE wire to the referenced wire list
    if (VARIABLE_DESCRIPTION.CIRCOM_CONST_ONE.source !== EVMInPlacementIndex) {
      throw new Error(`CIRCOM_CONST_ONE wire must belong to EVM_IN buffer`);
    }
    referencedWireIndices.add(VARIABLE_DESCRIPTION.CIRCOM_CONST_ONE.wireIndex);

    // Filter outPts and inPts to keep only those referenced
    newEVMInPlacement.outPts = newEVMInPlacement.outPts.filter(outPt => referencedWireIndices.has(outPt.wireIndex!));
    newEVMInPlacement.inPts = newEVMInPlacement.inPts.filter(inPt => referencedWireIndices.has(inPt.wireIndex!));
    newPlacements[EVMInPlacementIndex] = newEVMInPlacement;
  }

  private _convertEVMWiresIntoCircomWires(placements: Placements): void {
    // Process output wires first
    const outWireIndexChangeTracker: Map<number, Map<number, number[]>> = new Map();
    for (const [key, placement] of placements.entries()) {
      const _newOutPts: DataPt[] = [];
      const _wireIndexChangeTracker: Map<number, number[]> = new Map();
      for (const outPt of placement.outPts) {
        const splitOutPts = this._expandDataPtIntoCircomWires(outPt);
        _wireIndexChangeTracker.set(outPt.wireIndex, []);
        for (const newOutPt of splitOutPts) {
          const newIndex = _newOutPts.length; // capture before push
          _newOutPts.push({ ...newOutPt, wireIndex: newIndex });
          _wireIndexChangeTracker.get(outPt.wireIndex)!.push(newIndex);
        }
      }
      outWireIndexChangeTracker.set(key, _wireIndexChangeTracker);

      placement.outPts = _newOutPts;
    }

    // Process input wires
    for (const [thisPlacementId, placement] of placements.entries()) {
      const _newInPts: DataPt[] = [];

      for (const inPt of placement.inPts) {
        const sourcePlacementId = inPt.source;
        const sourceOutWireOldInd = inPt.wireIndex;
        if (sourcePlacementId === thisPlacementId) {
          // If the source comes from external
          const splitInPts = this._expandDataPtIntoCircomWires(inPt);
          for (const newInPt of splitInPts) {
            const newIndex = _newInPts.length; // capture before push
            _newInPts.push({ ...newInPt, wireIndex: newIndex });
          }
        } else {
          // If the source comes from other placement
          const sourceTracker = outWireIndexChangeTracker.get(sourcePlacementId);
          if (!sourceTracker) {
            throw new Error(`Missing out-wire tracker for placement ${sourcePlacementId}`);
          }
          const mappedNewIndices = sourceTracker.get(sourceOutWireOldInd);
          if (!mappedNewIndices || mappedNewIndices.length == 0) {
            throw new Error(`No mapping for source wire ${sourceOutWireOldInd} (placement ${sourcePlacementId})`);
          }
          const newInPts = mappedNewIndices.map(index =>
            placements[sourcePlacementId].outPts.find(pt => pt.wireIndex === index),
          );
          if (mappedNewIndices.length !== newInPts.length) {
            throw new Error('No one-to-one correspondence between new input and output wires');
          }
          for (const pt of newInPts) {
            _newInPts.push(pt!);
          }
        }
      }

      placement.inPts = _newInPts;
    }
  }

  private _validateBufferSizes(outPlacements: Placements): void {
    const flags: boolean[] = [];
    for (const [placementIndex, bufferName] of BUFFER_LIST.entries()) {
      const bufferPlacement = outPlacements[placementIndex];
      if (bufferPlacement === undefined) {
        throw new Error(`Buffer ${bufferName} is not placed`);
      }
      const subcircuitInfo = this.subcircuitLibrary.subcircuitBufferMapping[bufferName];
      if (subcircuitInfo === undefined) {
        throw new Error(`Subcircuit information for ${bufferName} is not loaded`);
      }
      if (bufferPlacement.inPts.length > subcircuitInfo.NInWires) {
        flags.push(false);
        console.log(
          `Error: Synthesizer: Insufficient ${subcircuitInfo.name} length. Ask the qap-compiler for a longer buffer (required length: ${bufferPlacement.inPts.length}).`,
        );
      }
    }
    if (outPlacements.length > this.subcircuitLibrary.data.setupParams.s_max) {
      flags.push(false);
      console.log(
        `Error: Synthesizer: Insufficient s_max. Ask the qap-compiler for increasing s_max (required s_max: ${outPlacements.length}).`,
      );
    }
    if (flags.includes(false)) {
      throw new Error('Resolve above errors.');
    }
  }

  private async _generateSubcircuitWitness(subcircuitId: number, inValues: string[]): Promise<string[]> {
    let witnessHex: string[] = [];
    if (inValues.length > 0) {
      const id = subcircuitId;
      const buffer = await this.subcircuitLibrary.loadWasm(id);
      if (!(buffer instanceof ArrayBuffer)) {
        throw new Error(`Synthesizer: ${id}-th subcircuit WASM is unavailable`);
      }
      const ins = { in: inValues };
      const witnessCalculator = await builder(buffer);
      const witness = await witnessCalculator.calculateWitness(ins);
      for (const [index, value] of witness.entries()) {
        let hex = bigIntToHex(value);
        witnessHex[index] = hex;
      }
    }
    return witnessHex;
  }
}
