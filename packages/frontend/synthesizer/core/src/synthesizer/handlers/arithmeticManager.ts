
import type { ISynthesizerProvider } from '../types/index.ts';
import type { ArithmeticSubcircuit } from '../../subcircuit/configuredTypes.ts';
import { ArithmeticOperations } from '../dataStructure/arithmeticOperations.ts';

export class ArithmeticManager {
  constructor(
    private parent: ISynthesizerProvider
  ) {
    ArithmeticOperations.configure({
      jubjubExpBatchSize: this.parent.subcircuitLibrary.jubjubExpBatchSize,
    })
  }

  public calculateArithSubcircuitOutputValues(
    name: ArithmeticSubcircuit,
    values: bigint[],
  ): bigint[] {
    const operation = ARITHMETIC_MAPPING[name]
    const out = operation(values)
    return Array.isArray(out) ? out : [out]
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
