import { bigIntToBytes, bytesToBigInt, setLengthLeft } from '@ethereumjs/util';
import { describe, expect, it, vi } from 'vitest';

import type { ArithmeticOperator } from '../../../core/src/subcircuit/configuredTypes.ts';
import { DataPtFactory, Memory, MemoryPt } from '../../../core/src/synthesizer/dataStructure/index.ts';
import { MemoryManager } from '../../../core/src/synthesizer/handlers/memoryManager.ts';
import type { DataAliasInfoEntry, DataPt, DataPtType } from '../../../core/src/synthesizer/types/index.ts';

const UINT256_MASK = (1n << 256n) - 1n;
const FULL_MASK = `0x${'ff'.repeat(32)}`;
const WORD_TYPE = {
  valueDomain: { kind: 'uint', bits: 256 },
  wireLayout: { kind: 'limbs-128', count: 2 },
} as const satisfies DataPtType;

type ArithmeticCall = {
  name: ArithmeticOperator;
  inPts: DataPt[];
};

const wordPt = (value: bigint, source: number, wireIndex = 0): DataPt =>
  DataPtFactory.create(
    {
      source,
      wireIndex,
      dataPtType: WORD_TYPE,
    },
    value & UINT256_MASK,
  );

const createHarness = () => {
  const calls: ArithmeticCall[] = [];
  let nextStaticWire = 0;
  let nextPlacement = 100;

  const loadArbitraryStatic = vi.fn((value: bigint, dataPtType: DataPtType) =>
    DataPtFactory.create(
      {
        source: 0,
        wireIndex: nextStaticWire++,
        dataPtType,
      },
      value,
    ),
  );
  const placeArithComposition = vi.fn((name: ArithmeticOperator, inPts: DataPt[]): DataPt[] => {
    calls.push({ name, inPts });
    const values = inPts.map(({ value }) => value);
    let result: bigint;

    switch (name) {
      case 'AND':
        result = values[0] & values[1];
        break;
      case 'SHL':
        result = values[0] >= 256n ? 0n : (values[1] << values[0]) & UINT256_MASK;
        break;
      case 'SHR':
        result = values[0] >= 256n ? 0n : values[1] >> values[0];
        break;
      case 'Accumulator':
        result = values.reduce((sum, value) => sum + value, 0n) & UINT256_MASK;
        break;
      default:
        throw new Error(`Unexpected arithmetic operation ${name}`);
    }

    return [wordPt(result, nextPlacement++)];
  });
  const parent = {
    subcircuitLibrary: { accumulatorInputLimit: 32 },
    loadArbitraryStatic,
    placeArithComposition,
  };

  return {
    calls,
    loadArbitraryStatic,
    manager: new MemoryManager(parent as never),
    placeArithComposition,
  };
};

const alias = (dataPt: DataPt, masker: string, shift = 0): DataAliasInfoEntry => ({ dataPt, masker, shift });

describe('MemoryManager fragment masking topology', () => {
  it('places the same AND topology whether discarded bytes are zero or nonzero', () => {
    const run = (value: bigint) => {
      const { calls, manager } = createHarness();
      const sourcePt = wordPt(value, 7, 3);
      const maskedPt = manager.placeMemoryToStack([alias(sourcePt, '0xff')]);

      return {
        maskedPt,
        shape: calls.map(({ name, inPts }) => ({
          name,
          inputs: inPts.map(({ source, wireIndex, dataPtType }) => ({
            source,
            wireIndex,
            dataPtType,
          })),
        })),
      };
    };

    const unchanged = run(0x42n);
    const changed = run((1n << 200n) | 0x42n);

    expect(unchanged.maskedPt.value).toBe(0x42n);
    expect(changed.maskedPt.value).toBe(0x42n);
    expect(unchanged.shape).toEqual(changed.shape);
    expect(unchanged.shape.map(({ name }) => name)).toEqual(['AND']);
  });

  it.each([
    ['full word', FULL_MASK],
    ['first byte', `0xff${'00'.repeat(31)}`],
    ['middle byte', `0x${'00'.repeat(15)}ff${'00'.repeat(16)}`],
    ['last byte', '0xff'],
  ])('always places AND for a %s mask', (_label, masker) => {
    const { calls, manager } = createHarness();
    const sourcePt = wordPt(UINT256_MASK, 8, 2);

    const result = manager.placeMemoryToStack([alias(sourcePt, masker)]);

    expect(result.value).toBe(UINT256_MASK & BigInt(masker));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('AND');
    expect(calls[0].inPts[0]).toMatchObject({
      value: BigInt(masker),
      dataPtType: WORD_TYPE,
    });
    expect(calls[0].inPts[1]).toBe(sourcePt);
  });

  it('normalizes an aligned memory-copy mask to its low 256 bits', () => {
    const { calls, loadArbitraryStatic, manager } = createHarness();
    const sourcePt = wordPt(UINT256_MASK, 9);
    const expectedMask = UINT256_MASK ^ 0xffn;

    const [result] = manager.placeMemoryToMemory([alias(sourcePt, FULL_MASK, -8)]);

    expect(result.value).toBe(expectedMask);
    expect(calls.map(({ name }) => name)).toEqual(['AND']);
    expect(loadArbitraryStatic).toHaveBeenCalledWith(expectedMask, WORD_TYPE, 'Masker for memory manipulation');
  });

  it.each([
    [0, 0],
    [1, 0],
    [15, 12],
    [31, 28],
  ])('reconstructs a word after MSTORE8 at byte %i and MLOAD at byte %i', (writeOffset, readOffset) => {
    const { manager } = createHarness();
    const memoryPt = new MemoryPt();
    const referenceMemory = new Memory();
    const originalValue = BigInt('0x00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100');
    const originalPt = wordPt(originalValue, 10);
    const originalBytes = setLengthLeft(bigIntToBytes(originalValue), 32);
    const store8Value = 0x1234n + BigInt(writeOffset);
    const store8Pt = manager.placeMSTORE8(wordPt(store8Value, 11));

    memoryPt.write(0, 32, originalPt);
    memoryPt.write(writeOffset, 1, store8Pt);
    referenceMemory.write(0, 32, originalBytes);
    referenceMemory.write(writeOffset, 1, new Uint8Array([Number(store8Value & 0xffn)]));

    const expectedBytes = referenceMemory.read(readOffset, 32);
    const aliases = memoryPt.getDataAlias(readOffset, 32);
    const reconstructedPt = manager.placeMemoryToStack(aliases);

    expect(memoryPt.viewMemory(readOffset, 32)).toEqual(expectedBytes);
    expect(reconstructedPt.value).toBe(bytesToBigInt(expectedBytes));
  });

  it('rejects a missing or mutated AND result', () => {
    const missing = createHarness();
    missing.placeArithComposition.mockImplementationOnce(() => []);
    expect(() => missing.manager.placeMemoryToStack([alias(wordPt(0x1234n, 20), '0xff')])).toThrow(
      'memory masking must produce exactly one output',
    );

    const mutated = createHarness();
    mutated.placeArithComposition.mockImplementationOnce(() => [wordPt(0x35n, 200)]);
    expect(() => mutated.manager.placeMemoryToStack([alias(wordPt(0x1234n, 21), '0xff')])).toThrow(
      'memory masking output mismatch',
    );
  });
});
