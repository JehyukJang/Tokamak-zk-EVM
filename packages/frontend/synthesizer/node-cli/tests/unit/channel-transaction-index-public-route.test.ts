import { describe, expect, it } from 'vitest'

import { installedSubcircuitLibrary } from '../../src/subcircuit/installedLibrary.ts'
import { BUFFER_LIST } from '../../../core/src/subcircuit/configuredTypes.ts'
import { createTransactionSignatureVerifyCompositionMapping } from '../../../core/src/subcircuit/special-builders/txSignVerifyComposition.ts'
import {
  BLS12_381_FR_DATA_PT_TYPE,
} from '../../../core/src/synthesizer/types/dataStructure.ts'
import { VARIABLE_DESCRIPTION } from '../../../core/src/synthesizer/types/buffers.ts'

describe('channel transaction index public route', () => {
  it('uses the TX_IN public wire that feeds the TSV challenge', () => {
    const channelTransactionIndex = VARIABLE_DESCRIPTION.CHANNEL_TX_INDEX
    const txIn = installedSubcircuitLibrary.subcircuitBufferMapping.TX_IN

    expect(channelTransactionIndex.source).toBe(BUFFER_LIST.indexOf('TX_IN'))
    expect(channelTransactionIndex.wireIndex).toBe(3)
    expect(channelTransactionIndex.dataPtType).toBe(BLS12_381_FR_DATA_PT_TYPE)
    expect(txIn).toBeDefined()

    expect(txIn!.publicPhase).toBe('user-input')
    expect(txIn!.publicRange).toEqual([
      txIn!.inWireIndex,
      txIn!.NInWires,
    ])
    expect(txIn!.inWireIndex + channelTransactionIndex.wireIndex).toBeLessThan(
      txIn!.publicRange[0] + txIn!.publicRange[1],
    )

    const { composition } = createTransactionSignatureVerifyCompositionMapping(
      installedSubcircuitLibrary.data.frontendCfg.nPrivateMessageInputs,
    )
    expect(composition.steps[0]!.inputs.at(-1)).toEqual({ kind: 'operand', index: 4 })
  })
})
