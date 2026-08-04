import { jubjub } from '@noble/curves/misc.js';
import { describe, expect, it, vi } from 'vitest';

import { createArithmeticSubcircuitComposition } from '../../../core/src/subcircuit/arithmeticSubcircuitComposition.ts';
import { ArithmeticManager } from '../../../core/src/synthesizer/handlers/arithmeticManager.ts';
import { InstructionHandler } from '../../../core/src/synthesizer/handlers/instructionHandler.ts';
import type { DataPt } from '../../../core/src/synthesizer/types/dataStructure.ts';

const JUBJUB_EXP_BATCH_SIZE = 37;
const NUM_BATCHES = Math.ceil(256 / JUBJUB_EXP_BATCH_SIZE);
const TEST_SCALAR = Array.from(
  { length: NUM_BATCHES },
  (_, batchIndex) => 1n << BigInt(batchIndex * JUBJUB_EXP_BATCH_SIZE),
).reduce((sum, value) => sum + value, 0n);

const dataPt = (
  value: bigint,
  source: number,
  wireIndex: number,
  sourceBitSize: number,
): DataPt => ({
  source,
  wireIndex,
  sourceBitSize,
  value,
  valueHex: `0x${value.toString(16)}`,
});

const createHarness = () => {
  const placements: Array<{
    name: string;
    inPts: DataPt[];
    outPts: DataPt[];
    usage: string;
  }> = [];
  let staticWireIndex = 0;
  const parent = {
    placements,
    subcircuitLibrary: {
      arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition({
        nAccumulation: 4,
        nEqualBatch: 2,
        nJubjubExpBatch: JUBJUB_EXP_BATCH_SIZE,
        nPoseidonBatch: 1,
        nSubExpBatch: 8,
      }),
      poseidonBatchSize: 1,
      arithExpBatchSize: 8,
      jubjubExpBatchSize: JUBJUB_EXP_BATCH_SIZE,
    },
    state: {
      subcircuitInfoByName: new Map([[
        'JubjubExpBatch',
        {
          id: 7,
          name: 'JubjubExpBatch',
          NInWires: 8 + JUBJUB_EXP_BATCH_SIZE,
          NOutWires: 8,
        },
      ]]),
    },
    loadArbitraryStatic: vi.fn((value: bigint, sourceBitSize = 256) =>
      dataPt(value, 5, staticWireIndex++, sourceBitSize)),
    place: vi.fn((name: string, inPts: DataPt[], outPts: DataPt[], usage: string) => {
      placements.push({ name, inPts, outPts, usage });
    }),
  };

  return {
    manager: new ArithmeticManager(parent as never),
    placements,
    loadArbitraryStatic: parent.loadArbitraryStatic,
  };
};

const createInputs = (scalar: bigint): DataPt[] => {
  const pointAtInfinity = jubjub.Point.ZERO.toAffine();
  const base = jubjub.Point.BASE.toAffine();
  const scalarBits = Array.from(
    { length: 256 },
    (_, index) => dataPt((scalar >> BigInt(index)) & 1n, 10, index, 1),
  );
  return [
    dataPt(pointAtInfinity.x, 5, 2, 255),
    dataPt(pointAtInfinity.y, 5, 3, 255),
    dataPt(base.x, 5, 4, 255),
    dataPt(base.y, 5, 5, 255),
    ...scalarBits,
  ];
};

describe('JubjubExp composition execution', () => {
  it('places the fixed batch chain and pads only its final scalar chunk', () => {
    const { manager, placements, loadArbitraryStatic } = createHarness();
    const scalar = TEST_SCALAR;

    const result = manager.placeArithComposition('JubjubExp', createInputs(scalar));

    const expected = jubjub.Point.BASE.multiply(scalar).toAffine();
    expect(result.map(({ value }) => value)).toEqual([expected.x, expected.y]);
    expect(placements).toHaveLength(NUM_BATCHES);
    expect(placements.every(({ name }) => name === 'JubjubExpBatch')).toBe(true);
    expect(placements.every(({ usage }) => usage === 'JubjubExpBatch')).toBe(true);
    expect(loadArbitraryStatic).toHaveBeenCalledTimes(
      NUM_BATCHES * JUBJUB_EXP_BATCH_SIZE - 256,
    );
    expect(loadArbitraryStatic).toHaveBeenCalledWith(0n, 1);

    expect(placements[0]!.inPts.slice(0, 4)).toEqual(createInputs(scalar).slice(0, 4));
    for (let batchIndex = 1; batchIndex < NUM_BATCHES; batchIndex++) {
      expect(placements[batchIndex]!.inPts.slice(0, 4)).toEqual(
        placements[batchIndex - 1]!.outPts,
      );
    }
    expect(placements.at(-1)!.inPts.slice(-3).map(({ value }) => value)).toEqual([
      0n,
      0n,
      0n,
    ]);
    expect(result).toMatchObject([
      { source: NUM_BATCHES - 1, wireIndex: 0, sourceBitSize: 255 },
      { source: NUM_BATCHES - 1, wireIndex: 1, sourceBitSize: 255 },
    ]);
  });

  it('keeps the scalar reference assertion in signature orchestration', () => {
    const assertion = InstructionHandler.prototype as unknown as {
      _assertBitDecomposition(referencePt: DataPt, bitPts: DataPt[]): void;
    };
    const bitPts = createInputs(TEST_SCALAR).slice(4);

    expect(() => assertion._assertBitDecomposition(
      dataPt(TEST_SCALAR + 1n, 11, 0, 256),
      bitPts,
    )).toThrow('The reference value cannot be recovered from the bit string');
  });

  it('rejects the wrong high-level operand count before placement', () => {
    const { manager, placements } = createHarness();

    expect(() => manager.placeArithComposition('JubjubExp', createInputs(TEST_SCALAR).slice(0, -1)))
      .toThrow('JubjubExp expected 260 operands, but got 259');
    expect(placements).toHaveLength(0);
  });
});
