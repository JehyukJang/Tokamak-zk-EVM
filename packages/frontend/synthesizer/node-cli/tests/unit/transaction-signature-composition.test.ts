import { describe, expect, it } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';

describe('transaction signature composition definition', () => {
  it('preserves the complete fixed signature-verification topology', () => {
    const composition = createArithmeticSubcircuitComposition({
      nAccumulation: 4,
      nEqualBatch: 2,
      nJubjubExpBatch: 37,
      nPoseidonBatch: 1,
      nSubExpBatch: 8,
    }).get('TransactionSignatureVerify');

    expect(composition.placementStrategy).toBe('generic');
    expect(composition.numOperands).toBe(42);
    expect(composition.numResults).toBe(1);
    expect(composition.numSteps).toBe(54);
    expect(composition.constants).toEqual([{ value: 0n, sourceBitSize: 1 }]);
    expect(composition.steps.map(({ subcircuit }) => subcircuit)).toEqual([
      ...Array(35).fill('Poseidon'),
      'DecToBit',
      'DecToBit',
      ...Array(7).fill('JubjubExpBatch'),
      ...Array(7).fill('JubjubExpBatch'),
      'EdDsaVerify',
      'Poseidon',
      'AND',
    ]);

    expect(composition.steps[0]).toMatchObject({
      selector: 1n,
      inputs: [
        { kind: 'selector' },
        { kind: 'operand', index: 0 },
        { kind: 'operand', index: 1 },
      ],
      outputs: [{ kind: 'step-output', index: 0 }],
    });
    expect(composition.steps[34]).toMatchObject({
      selector: 1n,
      inputs: [
        { kind: 'selector' },
        { kind: 'step-output', index: 33 },
        { kind: 'operand', index: 35 },
      ],
      outputs: [{ kind: 'step-output', index: 34 }],
    });
    expect(composition.steps[35]?.inputs).toEqual([
      { kind: 'operand', index: 36 },
    ]);
    expect(composition.steps[35]?.outputs.slice(0, 2)).toEqual([
      { kind: 'step-output', index: 35 },
      { kind: 'step-output', index: 36 },
    ]);
    expect(composition.steps[35]?.outputs.at(-1)).toEqual(
      { kind: 'step-output', index: 290 },
    );
    expect(composition.steps[36]?.inputs).toEqual([
      { kind: 'step-output', index: 34 },
    ]);
    expect(composition.steps[36]?.outputs.slice(0, 2)).toEqual([
      { kind: 'step-output', index: 291 },
      { kind: 'step-output', index: 292 },
    ]);
    expect(composition.steps[36]?.outputs.at(-1)).toEqual(
      { kind: 'step-output', index: 546 },
    );
    expect(composition.steps[37]?.inputs.slice(0, 4)).toEqual([
      { kind: 'operand', index: 39 },
      { kind: 'operand', index: 40 },
      { kind: 'operand', index: 37 },
      { kind: 'operand', index: 38 },
    ]);
    expect(composition.steps[43]?.inputs.slice(-3)).toEqual([
      { kind: 'constant', index: 0 },
      { kind: 'constant', index: 0 },
      { kind: 'constant', index: 0 },
    ]);
    expect(composition.steps[43]?.outputs).toEqual([
      { kind: 'step-output', index: 571 },
      { kind: 'step-output', index: 572 },
      { kind: 'discard' },
      { kind: 'discard' },
    ]);
    expect(composition.steps[44]?.inputs.slice(0, 4)).toEqual([
      { kind: 'operand', index: 39 },
      { kind: 'operand', index: 40 },
      { kind: 'operand', index: 2 },
      { kind: 'operand', index: 3 },
    ]);
    expect(composition.steps[50]?.outputs).toEqual([
      { kind: 'step-output', index: 597 },
      { kind: 'step-output', index: 598 },
      { kind: 'discard' },
      { kind: 'discard' },
    ]);
    expect(composition.steps[51]).toMatchObject({
      subcircuit: 'EdDsaVerify',
      inputs: [
        { kind: 'step-output', index: 571 },
        { kind: 'step-output', index: 572 },
        { kind: 'operand', index: 0 },
        { kind: 'operand', index: 1 },
        { kind: 'step-output', index: 597 },
        { kind: 'step-output', index: 598 },
      ],
      outputs: [],
    });
    expect(composition.steps[52]).toMatchObject({
      subcircuit: 'Poseidon',
      selector: 1n,
      inputs: [
        { kind: 'selector' },
        { kind: 'operand', index: 2 },
        { kind: 'operand', index: 3 },
      ],
      outputs: [{ kind: 'step-output', index: 599 }],
    });
    expect(composition.steps[53]).toMatchObject({
      subcircuit: 'AND',
      selector: 1n << 22n,
      inputs: [
        { kind: 'selector' },
        { kind: 'step-output', index: 599 },
        { kind: 'operand', index: 41 },
      ],
      outputs: [{ kind: 'result', index: 0 }],
    });
  });

  it('derives Poseidon batching and padding from the loaded batch size', () => {
    const composition = createArithmeticSubcircuitComposition({
      nAccumulation: 4,
      nEqualBatch: 2,
      nJubjubExpBatch: 4,
      nPoseidonBatch: 6,
      nSubExpBatch: 8,
    }).get('TransactionSignatureVerify');

    expect(composition.numSteps).toBe(139);
    expect(composition.constants).toEqual([{ value: 0n, sourceBitSize: 255 }]);
    expect(composition.steps.slice(0, 6).map(({ selector }) => selector)).toEqual([
      1n << 5n,
      1n << 5n,
      1n << 5n,
      1n << 5n,
      1n << 5n,
      1n << 4n,
    ]);
    expect(composition.steps[5]?.inputs.at(-1)).toEqual(
      { kind: 'constant', index: 0 },
    );
    expect(composition.steps[137]?.inputs).toEqual([
      { kind: 'selector' },
      { kind: 'operand', index: 2 },
      { kind: 'operand', index: 3 },
      { kind: 'constant', index: 0 },
      { kind: 'constant', index: 0 },
      { kind: 'constant', index: 0 },
      { kind: 'constant', index: 0 },
      { kind: 'constant', index: 0 },
    ]);
  });
});
