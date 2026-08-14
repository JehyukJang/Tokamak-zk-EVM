import { describe, expect, it } from 'vitest'

import { calculateSubcircuitOutputValues } from '../../../core/src/subcircuit/subcircuitOutputOperations.ts'

describe('subcircuit output operations', () => {
  it('returns no host outputs for StorageAccess', () => {
    expect(calculateSubcircuitOutputValues('StorageAccess', [1n, 2n, 1n, 2n])).toEqual([])
  })

  it('calculates each MemoryViewStep output from its encoded inputs', () => {
    expect(calculateSubcircuitOutputValues('MemoryViewStep', [
      0xdeadbeefn,
      1n,
      2n,
      1n,
      1n,
    ])).toEqual([0xef01n, 3n])
    expect(calculateSubcircuitOutputValues('MemoryViewStep', [
      0xdeadbeef00n,
      33n,
      1n,
      0x10000n,
      1n,
    ])).toEqual([0x100efn, 2n])
  })
})
