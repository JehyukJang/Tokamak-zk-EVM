import { describe, expect, it } from 'vitest'

import { SubcircuitOutputCalculator } from '../../../core/src/synthesizer/handlers/subcircuitOutputCalculator.ts'

describe('SubcircuitOutputCalculator', () => {
  it('returns no host outputs for EqualBatch', () => {
    const calculator = new SubcircuitOutputCalculator()

    expect(calculator.calculateSubcircuitOutputValues('EqualBatch', [1n, 2n, 1n, 2n])).toEqual([])
  })

  it('calculates each MemoryLoadStep output from the prepared inputs', () => {
    const calculator = new SubcircuitOutputCalculator()

    expect(calculator.calculateSubcircuitOutputValues('MemoryLoadStep', [
      0xdeadbeefn,
      1n,
      0n,
      2n,
      1n,
      1n,
      3n,
      0n,
    ])).toEqual([0xef01n, 3n])
    expect(calculator.calculateSubcircuitOutputValues('MemoryLoadStep', [
      0xdeadbeef00n,
      1n,
      1n,
      1n,
      0x10000n,
      1n,
      3n,
      1n,
    ])).toEqual([0x100efn, 3n])
  })
})
