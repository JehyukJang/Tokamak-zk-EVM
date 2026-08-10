
import type { DataPt, DataPtType, ISynthesizerProvider } from '../types/index.ts';
import {
  BIT_LIMB_DATA_PT_TYPE,
  EVM_WORD_DATA_PT_TYPE,
  UINT64_LIMB_DATA_PT_TYPE,
  UINT85_LIMB_DATA_PT_TYPE,
  UINT86_LIMB_DATA_PT_TYPE,
} from '../types/dataStructure.ts';
import { DataPtFactory } from '../dataStructure/index.ts';
import {
  type ArithmeticSubcircuit,
  type ArithmeticOperator,
} from '../../subcircuit/configuredTypes.ts';
import type { PlacementComposition } from '../../subcircuit/placementCompositionManager.ts';
import { ArithmeticOperations } from '../dataStructure/arithmeticOperations.ts';
import { POSEIDON_INPUTS } from 'tokamak-l2js';

export class ArithmeticManager {
  private readonly poseidonBatchSize: number

  constructor(
    private parent: ISynthesizerProvider
  ) {
    const poseidonBatchSize = this.parent.subcircuitLibrary.poseidonBatchSize
    if (!Number.isInteger(poseidonBatchSize) || poseidonBatchSize < 1 || poseidonBatchSize > 128) {
      throw new Error('Synthesizer: nPoseidonBatch must be an integer between 1 and 128')
    }
    this.poseidonBatchSize = poseidonBatchSize
    ArithmeticOperations.configure({
      jubjubExpBatchSize: this.parent.subcircuitLibrary.jubjubExpBatchSize,
    })
  }

  /**
   * Creates the output data points for an arithmetic subcircuit.
   *
   * @param {ArithmeticSubcircuit} name - The name of the arithmetic subcircuit.
   * @param {DataPt[]} inPts - The input data points for the operation.
   * @returns {DataPt[]} An array of output data points.
   */
  private _createArithSubcircuitOutput(
    name: ArithmeticSubcircuit,
    inPts: DataPt[],
  ): DataPt[] {
    let dataPtTypes: readonly DataPtType[] | undefined
    switch (name) {
      case 'DecToBit':
        dataPtTypes = Array(256).fill(BIT_LIMB_DATA_PT_TYPE)
        break
      case 'Poseidon':
        if (inPts.length < POSEIDON_INPUTS + 1 || inPts.length > this.poseidonBatchSize + 2) {
          throw new Error(
            `Synthesizer: Poseidon expected a selector and between ${POSEIDON_INPUTS} and ${this.poseidonBatchSize + 1} inputs, but got ${inPts.length}.`,
          )
        }
        dataPtTypes = [EVM_WORD_DATA_PT_TYPE]
        break
      case 'ALU4A':
        dataPtTypes = [
          EVM_WORD_DATA_PT_TYPE,
          EVM_WORD_DATA_PT_TYPE,
          EVM_WORD_DATA_PT_TYPE,
          UINT64_LIMB_DATA_PT_TYPE,
          UINT64_LIMB_DATA_PT_TYPE,
          UINT64_LIMB_DATA_PT_TYPE,
          UINT64_LIMB_DATA_PT_TYPE,
          BIT_LIMB_DATA_PT_TYPE,
          BIT_LIMB_DATA_PT_TYPE,
          BIT_LIMB_DATA_PT_TYPE,
        ]
        break
      case 'ADDMODPrepare':
        dataPtTypes = [
          UINT86_LIMB_DATA_PT_TYPE,
          UINT86_LIMB_DATA_PT_TYPE,
          UINT85_LIMB_DATA_PT_TYPE,
          UINT86_LIMB_DATA_PT_TYPE,
          UINT86_LIMB_DATA_PT_TYPE,
          UINT85_LIMB_DATA_PT_TYPE,
          EVM_WORD_DATA_PT_TYPE,
        ]
        break
      case 'MULMODPrepare':
        dataPtTypes = [
          ...Array(12).fill(UINT64_LIMB_DATA_PT_TYPE),
          ...Array(3).fill(EVM_WORD_DATA_PT_TYPE),
        ]
        break
      case 'MULMODCandidate':
        dataPtTypes = Array(12).fill(UINT64_LIMB_DATA_PT_TYPE)
        break
    }

    const values = inPts.map((pt) => pt.value);
    const outValue = this.calculateArithSubcircuitOutputValues(name, values);
    const resolvedDataPtTypes = dataPtTypes
      ?? Array(outValue.length).fill(EVM_WORD_DATA_PT_TYPE)
    if (resolvedDataPtTypes.length !== outValue.length) {
      throw new Error(
        `Synthesizer: ${name} produced ${outValue.length} outputs with ${resolvedDataPtTypes.length} output types`,
      )
    }

    return outValue.length > 0
      ? outValue.map((value, index) =>
          DataPtFactory.create({
            source: this.parent.placements.length,
            wireIndex: index,
            dataPtType: resolvedDataPtTypes[index],
          }, value),
        )
      : []
  }

  public calculateArithSubcircuitOutputValues(
    name: ArithmeticSubcircuit,
    values: bigint[],
  ): bigint[] {
    const operation = ARITHMETIC_MAPPING[name]
    const out = operation(values)
    return Array.isArray(out) ? out : [out]
  }

  private _countCircuitWires(dataPts: DataPt[]): number {
    return dataPts.reduce(
      (count, { dataPtType: { wireLayout } }) =>
        count + (wireLayout.kind === 'native-fr' ? 1 : wireLayout.count),
      0,
    )
  }

  private _assertArithSubcircuitWireCount(
    subcircuit: ArithmeticSubcircuit,
    target: 'input' | 'output',
    dataPts: DataPt[],
  ): void {
    const subcircuitInfo = this.parent.state.subcircuitInfoByName.get(subcircuit)
    if (subcircuitInfo === undefined) {
      throw new Error(
        `Synthesizer: ${subcircuit} subcircuit is not found. Check qap-compiler.`,
      )
    }

    const expectedWireCount = target === 'input'
      ? subcircuitInfo.NInWires
      : subcircuitInfo.NOutWires
    const actualWireCount = this._countCircuitWires(dataPts)
    if (actualWireCount !== expectedWireCount) {
      throw new Error(
        `Synthesizer: ${subcircuit} expected ${expectedWireCount} ${target} wires, but got ${actualWireCount}`,
      )
    }
  }

  private _normalizePoseidonInputs(inPts: DataPt[]): { selector: bigint; inPts: DataPt[] } {
    const nCalls = inPts.length - 1
    const zeroPt = this.parent.loadArbitraryStatic(
      0n,
      {
        valueDomain: { kind: 'bls12-381-fr' },
        wireLayout: { kind: 'limbs-128', count: 2 },
      },
    )
    return {
      selector: 1n << BigInt(nCalls - 1),
      inPts: inPts.concat(
        Array.from(
          { length: this.poseidonBatchSize + 1 - inPts.length },
          () => DataPtFactory.deepCopy(zeroPt),
        ),
      ),
    }
  }

  private _placeSingleArithSubcircuit(
    subcircuit: ArithmeticSubcircuit,
    finalInPts: DataPt[],
    usage: ArithmeticOperator | ArithmeticSubcircuit,
  ): DataPt[] {
    this._assertArithSubcircuitWireCount(subcircuit, 'input', finalInPts)
    const outPts = this._createArithSubcircuitOutput(subcircuit, finalInPts)
    this._assertArithSubcircuitWireCount(subcircuit, 'output', outPts)
    this.parent.place(subcircuit, finalInPts, outPts, usage)
    return outPts
  }

  private _placePoseidon(
    composition: PlacementComposition,
    inPts: DataPt[],
  ): DataPt[] {
    const step = composition.steps[0]
    if (step === undefined || composition.steps.length !== 1) {
      throw new Error('Synthesizer: Poseidon requires one normalized composition step')
    }

    const placeNormalized = (inputs: DataPt[]): DataPt => {
      const normalized = this._normalizePoseidonInputs(inputs)
      const selectorPt = this.parent.loadArbitraryStatic(
        normalized.selector,
        {
          valueDomain: { kind: 'uint', bits: Math.max(32, this.poseidonBatchSize) },
          wireLayout: { kind: 'limbs-128', count: 1 },
        },
        `ALU selector for Poseidon of ${step.subcircuit}`,
      )
      const outPts = this._placeSingleArithSubcircuit(
        step.subcircuit,
        [selectorPt, ...normalized.inPts],
        step.usage,
      )
      const outPt = outPts[0]
      if (outPt === undefined || outPts.length !== 1) {
        throw new Error('Synthesizer: Poseidon must produce exactly one output')
      }
      return outPt
    }

    if (inPts.length === 0) {
      return [placeNormalized(
        Array<DataPt>(POSEIDON_INPUTS).fill(this.parent.loadArbitraryStatic(
          0n,
          {
            valueDomain: { kind: 'bls12-381-fr' },
            wireLayout: { kind: 'limbs-128', count: 2 },
          },
        )),
      )]
    }
    if (inPts.length === 1) {
      return [placeNormalized([inPts[0], this.parent.loadArbitraryStatic(
        0n,
        {
          valueDomain: { kind: 'bls12-381-fr' },
          wireLayout: { kind: 'limbs-128', count: 2 },
        },
      )])]
    }

    const inputLimit = this.poseidonBatchSize + 1
    let chainInputs = [...inPts]
    while (chainInputs.length > inputLimit) {
      const prefixHash = placeNormalized(chainInputs.slice(0, inputLimit))
      chainInputs = [prefixHash, ...chainInputs.slice(inputLimit)]
    }

    return [DataPtFactory.deepCopy(placeNormalized(chainInputs))]
  }

}

const ARITHMETIC_MAPPING: Record<ArithmeticSubcircuit, (values: bigint[]) => bigint | bigint[]> = {
  ALU1: ArithmeticOperations.alu1,
  ALU2: ArithmeticOperations.alu2,
  ALU3: ArithmeticOperations.alu3,
  AND: ArithmeticOperations.andSubcircuit,
  OR: ArithmeticOperations.orSubcircuit,
  XOR: ArithmeticOperations.xorSubcircuit,
  ALU4A: ArithmeticOperations.alu4a,
  ALU4B: ArithmeticOperations.alu4b,
  SIGNEXTEND: ArithmeticOperations.signextendSubcircuit,
  BYTE: ArithmeticOperations.byteSubcircuit,
  SHL: ArithmeticOperations.shlSubcircuit,
  ALU6: ArithmeticOperations.alu6,
  ADDMODPrepare: ArithmeticOperations.addmodPrepare,
  ADDMODVerify: ArithmeticOperations.addmodVerify,
  MULMODPrepare: ArithmeticOperations.mulmodPrepare,
  MULMODCandidate: ArithmeticOperations.mulmodCandidate,
  MULMODVerify: ArithmeticOperations.mulmodVerify,
  DecToBit: ArithmeticOperations.decToBit,
  SubExp: ArithmeticOperations.subExp,
  CheckBus256: ArithmeticOperations.checkBus256,
  Poseidon: ArithmeticOperations.poseidon,
} as const
