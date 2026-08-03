
import { DataPt, ISynthesizerProvider } from '../types/index.ts';
import { DataPtFactory } from '../dataStructure/index.ts';
import { DEFAULT_SOURCE_BIT_SIZE } from '../../synthesizer/params/constants.ts';
import {
  ARITHMETIC_OPERATION_DEFINITIONS,
  ArithmeticOperationDefinition,
  ArithmeticOperator,
  CheckedOperationDefinition,
  DivisionBridgeName,
  DivisionFamilyOperationDefinition,
  SingleOperationDefinition,
  SubcircuitNames,
} from '../../subcircuit/configuredTypes.ts';
import { ArithmeticOperations } from '../dataStructure/arithmeticOperations.ts';
import { POSEIDON_INPUTS } from 'tokamak-l2js';

const DIVISION_FAMILY_BRIDGE_BIT_SIZES = [
  256, 256, 256, 64, 64, 64, 64, 1, 1, 1,
] as const

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
   * Creates the output data points for an arithmetic operation.
   *
   * @param {ArithmeticOperator} name - The name of the arithmetic operation.
   * @param {DataPt[]} inPts - The input data points for the operation.
   * @returns {DataPt[]} An array of output data points.
   */
  private _createArithmeticOutput(
    name: ArithmeticOperator,
    inPts: DataPt[],
  ): DataPt[] {
    let sourceBitSize: number
    switch (name) {
      case 'DecToBit':
      // case 'PrepareEdDsaScalars': 
        sourceBitSize = 1
        break
      case 'Poseidon':
        if (inPts.length < POSEIDON_INPUTS || inPts.length > this.poseidonBatchSize + 1) {
          throw new Error(
            `Synthesizer: Poseidon expected between ${POSEIDON_INPUTS} and ${this.poseidonBatchSize + 1} inputs, but got ${inPts.length}.`,
          )
        }
        sourceBitSize = 255
        break
      case 'JubjubExpBatch':
      case 'EdDsaVerify':
        sourceBitSize = 255
        break
      default:
        sourceBitSize = DEFAULT_SOURCE_BIT_SIZE
    }

    const values = inPts.map((pt) => pt.value);
    const outValue: bigint[] = executeOperation(name, values);

    return outValue.length > 0
      ? outValue.map((value, index) =>
          DataPtFactory.create({
            source: this.parent.placements.length,
            wireIndex: index,
            sourceBitSize,
          }, value),
        )
      : []
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

  /**
   * Prepares the inputs for a subcircuit, including any required selectors.
   *
   * @param {ArithmeticOperator} name - The name of the arithmetic operation.
   * @param {DataPt[]} inPts - The input data points.
   * @returns {{ subcircuitName: SubcircuitNames; finalInPts: DataPt[] }} The name of the subcircuit and the final input data points.
   */
  private _prepareSubcircuitInputs(
    name: ArithmeticOperator,
    definition: ArithmeticOperationDefinition,
    inPts: DataPt[],
  ): { subcircuitName: SubcircuitNames; finalInPts: DataPt[] } {
    const subcircuitName = definition.placements[definition.selectorPlacement]!.subcircuit
    const configuredSelector = definition.selector

    const subcircuitInfo = this.parent.state.subcircuitInfoByName.get(subcircuitName)
    if (subcircuitInfo === undefined) {
      throw new Error(
        `Synthesizer: ${subcircuitName} subcircuit is not found for operation ${name}. Check qap-compiler.`,
      );
    }

    let selector = configuredSelector
    let finalInPts = inPts
    if (name === 'Poseidon') {
      const normalized = this._normalizePoseidonInputs(inPts)
      selector = normalized.selector
      finalInPts = normalized.inPts
    }
    if (selector !== undefined) {
      const selectorBitSize = name === 'Poseidon' ? Math.max(32, this.poseidonBatchSize) : 32
      const selectorPt = this.parent.loadArbitraryStatic(
        selector,
        selectorBitSize,
        `ALU selector for ${name} of ${subcircuitName}`,
      );
      finalInPts = [selectorPt, ...finalInPts];
    }

    return { subcircuitName, finalInPts };
  }

  private _assertModularCheckTopology(
    name: ArithmeticOperator,
    firstOperand: DataPt,
    checkPlacementIndex: number,
  ): void {
    const placements = this.parent.placements
    const modularPlacementIndex = placements.length - 1
    const checkPlacement = placements[checkPlacementIndex]
    const modularPlacement = placements[modularPlacementIndex]

    if (
      checkPlacementIndex !== modularPlacementIndex - 1
      || checkPlacement?.name !== 'CheckBus256'
      || checkPlacement.usage !== 'CheckBus256'
      || checkPlacement.inPts.length !== 1
      || checkPlacement.outPts.length !== 0
      || modularPlacement?.name !== name
      || modularPlacement.usage !== name
      || modularPlacement.inPts.length !== 4
      || modularPlacement.outPts.length !== 1
    ) {
      throw new Error(`Synthesizer: Invalid CheckBus256 topology for ${name}`)
    }

    const checkedOperand = checkPlacement.inPts[0]
    const modularFirstOperand = modularPlacement.inPts[1]
    if (
      checkedOperand === undefined
      || modularFirstOperand === undefined
      || checkedOperand.source !== firstOperand.source
      || checkedOperand.wireIndex !== firstOperand.wireIndex
      || modularFirstOperand.source !== firstOperand.source
      || modularFirstOperand.wireIndex !== firstOperand.wireIndex
    ) {
      throw new Error(`Synthesizer: CheckBus256 operand mismatch for ${name}`)
    }
  }

  private _createDivisionFamilyBridge(
    name: ArithmeticOperator,
    definition: DivisionFamilyOperationDefinition,
    inPts: DataPt[],
    source: number,
  ): DataPt[] {
    const dividend = inPts[0]!.value
    const divisor = inPts[1]!.value
    const isSigned = name === 'SDIV' || name === 'SMOD'
    const signedDividend = isSigned ? BigInt.asIntN(256, dividend) : dividend
    const signedDivisor = isSigned ? BigInt.asIntN(256, divisor) : divisor
    const absDividend = signedDividend < 0n ? -signedDividend : signedDividend
    const absDivisor = signedDivisor < 0n ? -signedDivisor : signedDivisor
    const safeDivisor = absDivisor === 0n ? 1n : absDivisor
    const absQuotient = absDividend / safeDivisor
    const absRemainder = absDividend % safeDivisor
    const useMod = name === 'MOD' || name === 'SMOD' ? 1n : 0n
    const resultIsNegative = name === 'SDIV'
      ? ((signedDividend < 0n) !== (signedDivisor < 0n) ? 1n : 0n)
      : name === 'SMOD'
        ? (signedDividend < 0n ? 1n : 0n)
        : 0n
    const wordMask = (1n << 64n) - 1n
    const values = {
      absDividend,
      absQuotient,
      absRemainder,
      absDivisorWord0: absDivisor & wordMask,
      absDivisorWord1: (absDivisor >> 64n) & wordMask,
      absDivisorWord2: (absDivisor >> 128n) & wordMask,
      absDivisorWord3: absDivisor >> 192n,
      divisorIsZero: absDivisor === 0n ? 1n : 0n,
      resultIsNegative,
      useMod,
    } satisfies Record<DivisionBridgeName, bigint>
    return definition.bridge.map(({ name: bridgeName, bitSize }, wireIndex) => DataPtFactory.create({
      source,
      wireIndex,
      sourceBitSize: bitSize,
    }, values[bridgeName]))
  }

  private _circuitWireCount(dataPts: DataPt[]): number {
    return dataPts.reduce(
      (count, dataPt) => count + (dataPt.sourceBitSize > 128 ? 2 : 1),
      0,
    )
  }

  private _assertDivisionFamilyTopology(
    name: ArithmeticOperator,
    inPts: DataPt[],
    firstPlacementIndex: number,
  ): void {
    const placements = this.parent.placements
    const secondPlacementIndex = placements.length - 1
    const firstPlacement = placements[firstPlacementIndex]
    const secondPlacement = placements[secondPlacementIndex]
    const firstInfo = this.parent.state.subcircuitInfoByName.get('ALU4A')
    const secondInfo = this.parent.state.subcircuitInfoByName.get('ALU4B')

    if (
      firstPlacementIndex !== secondPlacementIndex - 1
      || firstPlacement?.name !== 'ALU4A'
      || secondPlacement?.name !== 'ALU4B'
      || firstPlacement.usage !== name
      || secondPlacement.usage !== name
      || firstPlacement.inPts.length !== 3
      || firstPlacement.outPts.length !== 10
      || secondPlacement.inPts.length !== 10
      || secondPlacement.outPts.length !== 1
      || this._circuitWireCount(firstPlacement.inPts) !== 5
      || this._circuitWireCount(firstPlacement.outPts) !== 13
      || this._circuitWireCount(secondPlacement.inPts) !== 13
      || this._circuitWireCount(secondPlacement.outPts) !== 2
      || firstInfo?.NInWires !== 5
      || firstInfo.NOutWires !== 13
      || secondInfo?.NInWires !== 13
      || secondInfo.NOutWires !== 2
    ) {
      throw new Error(`Synthesizer: Invalid ALU4A/ALU4B topology for ${name}`)
    }

    for (let index = 0; index < inPts.length; index++) {
      const expected = inPts[index]!
      const actual = firstPlacement.inPts[index + 1]
      if (
        actual === undefined
        || actual.source !== expected.source
        || actual.wireIndex !== expected.wireIndex
      ) {
        throw new Error(`Synthesizer: ALU4A operand mismatch for ${name}`)
      }
    }

    for (let index = 0; index < DIVISION_FAMILY_BRIDGE_BIT_SIZES.length; index++) {
      const produced = firstPlacement.outPts[index]
      const consumed = secondPlacement.inPts[index]
      if (
        produced === undefined
        || consumed === undefined
        || produced.source !== firstPlacementIndex
        || produced.wireIndex !== index
        || produced.sourceBitSize !== DIVISION_FAMILY_BRIDGE_BIT_SIZES[index]
        || consumed.source !== produced.source
        || consumed.wireIndex !== produced.wireIndex
        || consumed.sourceBitSize !== produced.sourceBitSize
      ) {
        throw new Error(`Synthesizer: ALU4A/ALU4B bridge mismatch for ${name}`)
      }
    }

    const result = secondPlacement.outPts[0]
    if (
      result === undefined
      || result.source !== secondPlacementIndex
      || result.wireIndex !== 0
      || result.sourceBitSize !== 256
    ) {
      throw new Error(`Synthesizer: ALU4B result mismatch for ${name}`)
    }
  }

  private _placeDivisionFamily(
    name: ArithmeticOperator,
    definition: DivisionFamilyOperationDefinition,
    inPts: DataPt[],
  ): DataPt[] {
    if (inPts.length !== definition.operands.length) {
      throw new Error(`Synthesizer: ${name} requires exactly two operands`)
    }

    const [firstDefinition, secondDefinition] = definition.placements
    const firstInfo = this.parent.state.subcircuitInfoByName.get(firstDefinition.subcircuit)
    const secondInfo = this.parent.state.subcircuitInfoByName.get(secondDefinition.subcircuit)
    if (firstInfo === undefined || secondInfo === undefined) {
      throw new Error('Synthesizer: ALU4A and ALU4B subcircuits are required for division arithmetic')
    }
    if (
      firstInfo.NInWires !== firstDefinition.inputWires
      || firstInfo.NOutWires !== firstDefinition.outputWires
      || secondInfo.NInWires !== secondDefinition.inputWires
      || secondInfo.NOutWires !== secondDefinition.outputWires
    ) {
      throw new Error('Synthesizer: Invalid ALU4A/ALU4B subcircuit interface')
    }

    const { finalInPts } = this._prepareSubcircuitInputs(name, definition, inPts)

    const firstPlacementIndex = this.parent.placements.length
    const bridgePts = this._createDivisionFamilyBridge(name, definition, inPts, firstPlacementIndex)
    this.parent.place(firstDefinition.subcircuit, finalInPts, bridgePts, name)

    const outPts = this._createArithmeticOutput(name, inPts)
    this.parent.place(secondDefinition.subcircuit, bridgePts, outPts, name)
    this._assertDivisionFamilyTopology(name, inPts, firstPlacementIndex)

    return DataPtFactory.deepCopy([outPts[definition.result.output]!])
  }

  private _placeCheckedOperation(
    name: ArithmeticOperator,
    definition: CheckedOperationDefinition,
    inPts: DataPt[],
  ): DataPt[] {
    const firstOperand = inPts[definition.sharedInputs[0].operand]
    if (inPts.length !== 3 || firstOperand === undefined) {
      throw new Error(`Synthesizer: ${name} requires exactly three operands`)
    }

    const checkDefinition = definition.placements[0]
    if (!this.parent.state.subcircuitInfoByName.has(checkDefinition.subcircuit)) {
      throw new Error('Synthesizer: CheckBus256 subcircuit is required for modular arithmetic')
    }

    const checkPlacementIndex = this.parent.placements.length
    this.parent.place(
      checkDefinition.subcircuit,
      [firstOperand],
      [],
      checkDefinition.subcircuit,
    )

    const outPts = this._createArithmeticOutput(name, inPts)
    const { subcircuitName, finalInPts } = this._prepareSubcircuitInputs(
      name,
      definition,
      inPts,
    )
    this.parent.place(subcircuitName, finalInPts, outPts, name)
    this._assertModularCheckTopology(name, firstOperand, checkPlacementIndex)

    return DataPtFactory.deepCopy([outPts[definition.result.output]!])
  }

  private _placeSingleOperation(
    name: ArithmeticOperator,
    definition: SingleOperationDefinition,
    inPts: DataPt[],
  ): DataPt[] {
    const outPts = this._createArithmeticOutput(name, inPts)
    const { subcircuitName, finalInPts } = this._prepareSubcircuitInputs(
      name,
      definition,
      inPts,
    )
    this.parent.place(subcircuitName, finalInPts, outPts, name)

    return DataPtFactory.deepCopy(outPts)
  }

  private _placeComposition(
    name: ArithmeticOperator,
    definition: ArithmeticOperationDefinition,
    inPts: DataPt[],
  ): DataPt[] {
    switch (definition.kind) {
      case 'single':
        return this._placeSingleOperation(name, definition, inPts)
      case 'checked-operation':
        return this._placeCheckedOperation(name, definition, inPts)
      case 'division-family':
        return this._placeDivisionFamily(name, definition, inPts)
    }
  }

  /**
   * Places an arithmetic operation in the synthesizer.
   *
   * This involves creating output data points, preparing inputs, and adding the placement.
   *
   * @param {ArithmeticOperator} name - The name of the arithmetic operation.
   * @param {DataPt[]} inPts - The input data points.
   * @returns {DataPt[]} The output data points from the operation.
   */
  public placeArith(name: ArithmeticOperator, inPts: DataPt[]): DataPt[] {
    return this._placeComposition(name, ARITHMETIC_OPERATION_DEFINITIONS[name], inPts)
  }

  public placePoseidon(inPts: DataPt[]): DataPt {
    if (inPts.length === 0) {
      return this.placeArith('Poseidon', Array<DataPt>(POSEIDON_INPUTS).fill(this.parent.loadArbitraryStatic(0n)))[0]
    }
    if (inPts.length === 1) {
      return this.placeArith('Poseidon', [inPts[0], this.parent.loadArbitraryStatic(0n)])[0]
    }

    const inputLimit = this.poseidonBatchSize + 1
    let chainInputs = [...inPts]
    while (chainInputs.length > inputLimit) {
      const prefixHash = this.placeArith('Poseidon', chainInputs.slice(0, inputLimit))[0]
      chainInputs = [prefixHash, ...chainInputs.slice(inputLimit)]
    }

    return DataPtFactory.deepCopy(
      this.placeArith('Poseidon', chainInputs)[0],
    )
  }

  // public placeExp(inPts: DataPt[]): DataPt {
  //   const synthesizer = this.parent
  //   // a^b
  //   const aPt = inPts[0];
  //   const bPt = inPts[1];
  //   const bNum = Number(bPt.value);

  //   // Handle base cases for exponent
  //   if (bNum === 0) {
  //     return DataPtFactory.deepCopy(synthesizer.loadArbitraryStatic(BIGINT_1));
  //   }
  //   if (bNum === 1) {
  //     return DataPtFactory.deepCopy(aPt);
  //   }

  //   const k = Math.floor(Math.log2(bNum)) + 1; //bit length of b

  //   const bitifyOutPts = synthesizer.placeArith('DecToBit', [bPt]).reverse();
  //   // LSB at index 0

  //   const chPts: DataPt[] = [];
  //   const ahPts: DataPt[] = [];
  //   chPts.push(synthesizer.loadArbitraryStatic(BIGINT_1));
  //   ahPts.push(aPt);

  //   for (let i = 1; i <= k; i++) {
  //     const _inPts = [chPts[i - 1], ahPts[i - 1], bitifyOutPts[i - 1]];
  //     const _outPts = synthesizer.placeArith('SubEXP', _inPts);
  //     chPts.push(_outPts[0]);
  //     ahPts.push(_outPts[1]);
  //   }

  //   return DataPtFactory.deepCopy(chPts[chPts.length - 1]);
  // }

  public placeExp(inPts: DataPt[], reference?: bigint): DataPt {
    // a^b
    const CHUNK_SIZE = this.parent.subcircuitLibrary.arithExpBatchSize
    const NUM_CHUNKS = Math.ceil(DEFAULT_SOURCE_BIT_SIZE / CHUNK_SIZE)
    if (inPts.length !== DEFAULT_SOURCE_BIT_SIZE + 1) {
      throw new Error('Invalid input to SubExp')
    }
    const base: DataPt= inPts[0]
    // Make sure that the input scalar bits are in LSB-first
    const scalar_bits_LSB: DataPt[] = inPts.slice(1, )
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

    var c: DataPt = this.parent.loadArbitraryStatic(1n)
    var a: DataPt = base
    for (var i = 0; i < NUM_CHUNKS; i++) {
      const prev_c = c
      const prev_a = a
      // LSB first
      const chunkedInPts: DataPt[] = [prev_c, prev_a, ...scalar_bits_chunk[i]]
      const outPts: DataPt[] = this.parent.placeArith('SubExpBatch', chunkedInPts)
      if (outPts.length !== 2) {
        throw new Error('Something wrong with SubExpBatch')
      }
      c = outPts[0]
      a = outPts[1]
    }

    if (reference !== undefined) {
      if ((base.value ** reference) % (1n<<256n) !== c.value) {
        throw new Error(`SubExpBatch calculation is incorrect`)
      }
    }
    
    return DataPtFactory.deepCopy(c)
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
      const outPts: DataPt[] = this.parent.placeArith('JubjubExpBatch', chunkedInPts)
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


/**
 * Executes an arithmetic operation on the given values.
 *
 * @param {ArithmeticOperator} name - The name of the arithmetic operation.
 * @param {bigint[]} values - An array of bigint values as input for the operation.
 * @returns {bigint | bigint[]} The result of the operation.
 */
function executeOperation(
  name: ArithmeticOperator,
  values: bigint[],
): bigint[] {
  const operation = ARITHMETIC_MAPPING[name];
  const out = operation(values)
  if (!Array.isArray(out)) {
    return [out]
  } else {
    return out
  }
}

// Operator and function mapping
const ARITHMETIC_MAPPING: Record<ArithmeticOperator, (...args: any) => any> = {
  ADD: ArithmeticOperations.add,
  MUL: ArithmeticOperations.mul,
  SUB: ArithmeticOperations.sub,
  DIV: ArithmeticOperations.div,
  SDIV: ArithmeticOperations.sdiv,
  MOD: ArithmeticOperations.mod,
  SMOD: ArithmeticOperations.smod,
  ADDMOD: ArithmeticOperations.addmod,
  MULMOD: ArithmeticOperations.mulmod,
  EXP: ArithmeticOperations.subExpBatch, //not directly used
  LT: ArithmeticOperations.lt,
  GT: ArithmeticOperations.gt,
  SLT: ArithmeticOperations.slt,
  SGT: ArithmeticOperations.sgt,
  EQ: ArithmeticOperations.eq,
  ISZERO: ArithmeticOperations.iszero,
  AND: ArithmeticOperations.and,
  OR: ArithmeticOperations.or,
  XOR: ArithmeticOperations.xor,
  NOT: ArithmeticOperations.not,
  SHL: ArithmeticOperations.shl,
  SHR: ArithmeticOperations.shr,
  SAR: ArithmeticOperations.sar,
  BYTE: ArithmeticOperations.byte,
  SIGNEXTEND: ArithmeticOperations.signextend,
  DecToBit: ArithmeticOperations.decToBit,
  // SubEXP: ArithmeticOperations.subEXP,
  SubExpBatch: ArithmeticOperations.subExpBatch,
  Accumulator: ArithmeticOperations.accumulator,
  Poseidon: (values: bigint[]) => ArithmeticOperations.poseidonChainCompress(values),
  // PrepareEdDsaScalars: ArithmeticOperations.prepareEdDsaScalars,
  JubjubExpBatch: ArithmeticOperations.jubjubExpBatch,
  EdDsaVerify: ArithmeticOperations.edDsaVerify,
  EqualBatch: ArithmeticOperations.equalBatch,
} as const
