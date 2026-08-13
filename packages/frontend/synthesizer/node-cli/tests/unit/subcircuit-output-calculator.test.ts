import { describe, expect, it } from 'vitest'

import { SubcircuitOutputCalculator } from '../../../core/src/synthesizer/handlers/subcircuitOutputCalculator.ts'

describe('SubcircuitOutputCalculator', () => {
  it('returns no host outputs for EqualBatch', () => {
    const calculator = new SubcircuitOutputCalculator()

    expect(calculator.calculateSubcircuitOutputValues('EqualBatch', [1n, 2n, 1n, 2n])).toEqual([])
  })
})
