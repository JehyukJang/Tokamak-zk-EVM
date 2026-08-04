
import { DataPt, ISynthesizerProvider } from '../types/index.ts';
import { DataPtFactory } from '../dataStructure/index.ts';
import { DEFAULT_SOURCE_BIT_SIZE } from '../../synthesizer/params/constants.ts';
import {
  type ArithmeticSubcircuit,
  type ArithmeticOperator,
} from '../../subcircuit/configuredTypes.ts';
import type { ArithmeticOperationComposition } from '../../subcircuit/arithmeticSubcircuitComposition.ts';
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
      arithExpBatchSize: this.parent.subcircuitLibrary.arithExpBatchSize,
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
    let sourceBitSizes: readonly number[] | undefined
    switch (name) {
      case 'DecToBit':
        sourceBitSizes = Array(DEFAULT_SOURCE_BIT_SIZE).fill(1)
        break
      case 'Poseidon':
        if (inPts.length < POSEIDON_INPUTS + 1 || inPts.length > this.poseidonBatchSize + 2) {
          throw new Error(
            `Synthesizer: Poseidon expected a selector and between ${POSEIDON_INPUTS} and ${this.poseidonBatchSize + 1} inputs, but got ${inPts.length}.`,
          )
        }
        sourceBitSizes = [255]
        break
      case 'JubjubExpBatch':
      case 'EdDsaVerify':
        sourceBitSizes = Array(name === 'JubjubExpBatch' ? 4 : 0).fill(255)
        break
      case 'ALU4A':
        sourceBitSizes = [256, 256, 256, 64, 64, 64, 64, 1, 1, 1]
        break
    }

    const values = inPts.map((pt) => pt.value);
    const outValue = this._executeArithSubcircuit(name, values);
    const resolvedSourceBitSizes = sourceBitSizes
      ?? Array(outValue.length).fill(DEFAULT_SOURCE_BIT_SIZE)
    if (resolvedSourceBitSizes.length !== outValue.length) {
      throw new Error(
        `Synthesizer: ${name} produced ${outValue.length} outputs with ${resolvedSourceBitSizes.length} output bit sizes`,
      )
    }

    return outValue.length > 0
      ? outValue.map((value, index) =>
          DataPtFactory.create({
            source: this.parent.placements.length,
            wireIndex: index,
            sourceBitSize: resolvedSourceBitSizes[index],
          }, value),
        )
      : []
  }

  private _executeArithSubcircuit(
    name: ArithmeticSubcircuit,
    values: bigint[],
  ): bigint[] {
    const operation = ARITHMETIC_MAPPING[name]
    const out = operation(values)
    return Array.isArray(out) ? out : [out]
  }

  private _countCircuitWires(dataPts: DataPt[]): number {
    return dataPts.reduce(
      (count, dataPt) => count + (dataPt.sourceBitSize > 128 ? 2 : 1),
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
    const zeroPt = this.parent.loadArbitraryStatic(0n, 255)
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
    composition: ArithmeticOperationComposition,
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
        Math.max(32, this.poseidonBatchSize),
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
        Array<DataPt>(POSEIDON_INPUTS).fill(this.parent.loadArbitraryStatic(0n)),
      )]
    }
    if (inPts.length === 1) {
      return [placeNormalized([inPts[0], this.parent.loadArbitraryStatic(0n)])]
    }

    const inputLimit = this.poseidonBatchSize + 1
    let chainInputs = [...inPts]
    while (chainInputs.length > inputLimit) {
      const prefixHash = placeNormalized(chainInputs.slice(0, inputLimit))
      chainInputs = [prefixHash, ...chainInputs.slice(inputLimit)]
    }

    return [DataPtFactory.deepCopy(placeNormalized(chainInputs))]
  }

  public placeArithComposition(
    name: ArithmeticOperator,
    inPts: DataPt[],
  ): DataPt[] {
    const composition = this.parent.subcircuitLibrary
      .arithmeticSubcircuitComposition.get(name)
    switch (composition.placementStrategy) {
      case 'generic':
        break
      case 'poseidon':
        return this._placePoseidon(composition, inPts)
      default: {
        const invalidStrategy: never = composition.placementStrategy
        throw new Error(
          `Synthesizer: ${name} has unsupported placement strategy ${invalidStrategy}`,
        )
      }
    }

    if (inPts.length !== composition.numOperands) {
      throw new Error(
        `Synthesizer: ${name} expected ${composition.numOperands} operands, but got ${inPts.length}`,
      )
    }

    const intermediateOutPts: Array<DataPt | undefined> = []
    const resultPts: Array<DataPt | undefined> = Array(composition.numResults)

    for (const [stepIndex, step] of composition.steps.entries()) {
      if (!this.parent.state.subcircuitInfoByName.has(step.subcircuit)) {
        throw new Error(
          `Synthesizer: ${step.subcircuit} subcircuit is not found for operation ${name}. Check qap-compiler.`,
        )
      }

      const finalInPts: DataPt[] = []
      for (const input of step.inputs) {
        switch (input.kind) {
          case 'selector': {
            const selector = step.selector === 'dynamic'
              ? undefined
              : step.selector
            if (typeof selector !== 'bigint') {
              throw new Error(
                `Synthesizer: ${name} step ${stepIndex} requires a dynamic selector`,
              )
            }
            const selectorBitSize = step.selector === 'dynamic'
              ? Math.max(32, this.poseidonBatchSize)
              : 32
            finalInPts.push(this.parent.loadArbitraryStatic(
              selector,
              selectorBitSize,
              `ALU selector for ${name} of ${step.subcircuit}`,
            ))
            break
          }
          case 'operand': {
            const operand = inPts[input.index]
            if (operand === undefined) {
              throw new Error(
                `Synthesizer: ${name} step ${stepIndex} operand ${input.index} is unavailable`,
              )
            }
            finalInPts.push(operand)
            break
          }
          case 'constant': {
            const constant = composition.constants[input.index]
            if (constant === undefined) {
              throw new Error(
                `Synthesizer: ${name} step ${stepIndex} constant ${input.index} is unavailable`,
              )
            }
            const constantPt = this.parent.loadArbitraryStatic(
              constant.value,
              constant.sourceBitSize,
            )
            finalInPts.push(constantPt)
            break
          }
          case 'step-output': {
            const intermediateOutPt = intermediateOutPts[input.index]
            if (intermediateOutPt === undefined) {
              throw new Error(
                `Synthesizer: ${name} step ${stepIndex} intermediate ${input.index} is unavailable`,
              )
            }
            finalInPts.push(intermediateOutPt)
            break
          }
        }
      }

      let outPts: DataPt[]
      if (step.outputs.length === 0) {
        outPts = []
        this._assertArithSubcircuitWireCount(step.subcircuit, 'input', finalInPts)
        this._assertArithSubcircuitWireCount(step.subcircuit, 'output', outPts)
        this.parent.place(step.subcircuit, finalInPts, outPts, step.usage)
      } else {
        outPts = this._placeSingleArithSubcircuit(
          step.subcircuit,
          finalInPts,
          step.usage,
        )
      }
      if (outPts.length !== step.outputs.length) {
        throw new Error(
          `Synthesizer: ${name} step ${stepIndex} expected ${step.outputs.length} outputs, but generated ${outPts.length}`,
        )
      }
      for (const [outputIndex, output] of step.outputs.entries()) {
        const outPt = outPts[outputIndex]
        if (outPt === undefined) {
          throw new Error(
            `Synthesizer: ${name} step ${stepIndex} output ${outputIndex} is unavailable`,
          )
        }
        if (output.kind === 'step-output') {
          if (intermediateOutPts[output.index] !== undefined) {
            throw new Error(
              `Synthesizer: ${name} intermediate ${output.index} is already assigned`,
            )
          }
          intermediateOutPts[output.index] = outPt
        } else if (output.kind === 'result') {
          if (resultPts[output.index] !== undefined) {
            throw new Error(
              `Synthesizer: ${name} result ${output.index} is already assigned`,
            )
          }
          resultPts[output.index] = outPt
        }
      }
    }

    return resultPts.map((resultPt, index) => {
      if (resultPt === undefined) {
        throw new Error(`Synthesizer: ${name} result ${index} is unavailable`)
      }
      return DataPtFactory.deepCopy(resultPt)
    })
  }

  public placeJubjubExp(inPts: DataPt[], PoI: DataPt[], reference?: bigint): DataPt[] {
    const CHUNK_SIZE = this.parent.subcircuitLibrary.jubjubExpBatchSize
    const NUM_CHUNKS = Math.ceil(DEFAULT_SOURCE_BIT_SIZE / CHUNK_SIZE)

    if (inPts.length !== DEFAULT_SOURCE_BIT_SIZE + 2) {
      throw new Error('Invalid input to placeJubjubExp')
    }
    const base: DataPt[] = inPts.slice(0, 2)
    // Make sure that the input scalar bits are in LSB-first
    const scalar_bits_LSB: DataPt[] = inPts.slice(2, )
    if (reference !== undefined) {
      const recoverValueFromLSBString = (string: DataPt[]): bigint => {
        return string.map(pt => pt.value).reduce((acc, b, i) => acc | (b << BigInt(i)), 0n);
      }
      if (reference !== recoverValueFromLSBString(scalar_bits_LSB)) {
        throw new Error('The reference value cannot be recovered from the bit string')
      }
    }

    // const scalar_bits_chunk: DataPt[][] = Array.from({ length: NUM_CHUNKS }, (_, i) =>
    //   scalar_bits_LSB.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    // )

    const scalar_bits_chunk: DataPt[][] = Array.from({ length: NUM_CHUNKS }, (_, i) => {
      const start = i * CHUNK_SIZE;
      const end = (i + 1) * CHUNK_SIZE;
      const chunk = scalar_bits_LSB.slice(start, end);
      return chunk.length === CHUNK_SIZE
        ? chunk
        : chunk.concat(
            Array.from({ length: CHUNK_SIZE - chunk.length },
              () => this.parent.getReservedVariableFromBuffer('CIRCOM_CONST_ZERO'),
            )
          );
    });

    if (PoI.length !== 2) {
      throw new Error('Invalid input to placeJubjubExp')
    }
    var P: DataPt[] = PoI.slice()
    var G: DataPt[] = base.slice()
    for (var i = 0; i < NUM_CHUNKS; i++) {
      const prevP = P.slice()
      const prevG = G.slice()
      // LSB first
      const chunkedInPts: DataPt[] = [...prevP, ...prevG, ...scalar_bits_chunk[i]]
      const outPts: DataPt[] = this.parent.placeArithComposition(
        'JubjubExpBatch',
        chunkedInPts,
      )
      if (outPts.length !== 4) {
        throw new Error('Something wrong with JubjubExpBatch')
      }
      P = [outPts[0], outPts[1]]
      G = outPts.slice(2, )

      // //TESTED
      // const base_edwards = jubjub.Point.fromAffine({x: base[0].value, y: base[1].value})
      // const exponent = scalar_bits_chunk.slice(i, ).flat().map(pt => pt.value).reduce((acc, b, i) => acc | (b << BigInt(i)), 0n);
      // const P_plain = base_edwards.multiply(exponent % jubjub.Point.Fn.ORDER)
      // const P_edwards = jubjub.Point.fromAffine({x: P[0].value, y: P[1].value})
      // if (!P_plain.equals(P_edwards)) {
      //   throw new Error('JubjubExp mismatch from the reference')
      // }
    }

    return DataPtFactory.deepCopy(P)
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
  CheckBus256: ArithmeticOperations.checkBus256,
  ADDMOD: ArithmeticOperations.addmodSubcircuit,
  MULMOD: ArithmeticOperations.mulmodSubcircuit,
  DecToBit: ArithmeticOperations.decToBit,
  SubExpBatch: ArithmeticOperations.subExpBatch,
  Accumulator: ArithmeticOperations.accumulator,
  Poseidon: ArithmeticOperations.poseidon,
  JubjubExpBatch: ArithmeticOperations.jubjubExpBatch,
  EdDsaVerify: ArithmeticOperations.edDsaVerify,
  EqualBatch: ArithmeticOperations.equalBatch,
} as const
