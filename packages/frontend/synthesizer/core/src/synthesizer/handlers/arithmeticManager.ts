
import type { ArithmeticSubcircuit, CryptoSubcircuit } from '../../subcircuit/configuredTypes.ts';
import { SubcircuitOutputCalculator } from './subcircuitOutputCalculator.ts';

export class ArithmeticManager {
  public calculateArithSubcircuitOutputValues(
    name: ArithmeticSubcircuit,
    values: bigint[],
  ): bigint[] {
    return SubcircuitOutputCalculator.calculateSubcircuitOutputValues(name, values)
  }

  public calculateCryptoSubcircuitOutputValues(
    name: CryptoSubcircuit,
    values: bigint[],
  ): bigint[] {
    return SubcircuitOutputCalculator.calculateSubcircuitOutputValues(name, values)
  }

}
