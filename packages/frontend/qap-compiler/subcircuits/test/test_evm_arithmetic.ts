import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import builderModule from './wasm/witness_calculator.js';
import { split256BitInteger } from './helper_functions.js';
import { ArithmeticOperations } from '../../../synthesizer/core/src/synthesizer/dataStructure/arithmeticOperations.ts';

type WitnessValue = bigint | string | number;
type WitnessCalculator = {
  calculateWitness: (input: Record<string, bigint[]>, sanityCheck?: boolean) => Promise<WitnessValue[]>;
};

type OperationCase = {
  name: string;
  inputs: bigint[];
  expected: bigint;
};

const builder = builderModule as (code: Uint8Array, options?: unknown) => Promise<WitnessCalculator>;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR ?? path.join(__dirname, '../library');
const subcircuitInfo = JSON.parse(readFileSync(path.join(libraryDir, 'subcircuitInfo.json'), 'utf8')) as Array<{
  id: number;
  name: string;
  Nconsts: number;
}>;
const MAX_UINT256 = (1n << 256n) - 1n;

const operations: OperationCase[] = [
  { name: 'ADD', inputs: [MAX_UINT256, 1n], expected: 0n },
  { name: 'MUL', inputs: [MAX_UINT256, 2n], expected: MAX_UINT256 - 1n },
  { name: 'SUB', inputs: [0n, 1n], expected: MAX_UINT256 },
  { name: 'DIV', inputs: [17n, 5n], expected: 3n },
  { name: 'DIV', inputs: [17n, 0n], expected: 0n },
  { name: 'SDIV', inputs: [MAX_UINT256, 2n], expected: 0n },
  { name: 'SDIV', inputs: [17n, 0n], expected: 0n },
  { name: 'MOD', inputs: [17n, 5n], expected: 2n },
  { name: 'MOD', inputs: [17n, 0n], expected: 0n },
  { name: 'SMOD', inputs: [MAX_UINT256 - 6n, 5n], expected: MAX_UINT256 - 1n },
  { name: 'SMOD', inputs: [17n, 0n], expected: 0n },
  { name: 'ADDMOD', inputs: [MAX_UINT256, 2n, 7n], expected: 3n },
  { name: 'ADDMOD', inputs: [MAX_UINT256, 2n, 0n], expected: 0n },
  { name: 'MULMOD', inputs: [MAX_UINT256, 2n, 7n], expected: 2n },
  { name: 'MULMOD', inputs: [MAX_UINT256, 2n, 0n], expected: 0n },
  { name: 'LT', inputs: [4n, 5n], expected: 1n },
  { name: 'GT', inputs: [4n, 5n], expected: 0n },
  { name: 'SLT', inputs: [MAX_UINT256, 0n], expected: 1n },
  { name: 'SGT', inputs: [MAX_UINT256, 0n], expected: 0n },
  { name: 'EQ', inputs: [9n, 9n], expected: 1n },
  { name: 'ISZERO', inputs: [0n], expected: 1n },
  { name: 'AND', inputs: [0xaan, 0x0fn], expected: 0x0an },
  { name: 'OR', inputs: [0xa0n, 0x0fn], expected: 0xafn },
  { name: 'XOR', inputs: [0xaan, 0x0fn], expected: 0xa5n },
  { name: 'NOT', inputs: [0n], expected: MAX_UINT256 },
  { name: 'SIGNEXTEND', inputs: [0n, 0x80n], expected: MAX_UINT256 - 0x7fn },
  { name: 'SIGNEXTEND', inputs: [32n, 0x80n], expected: 0x80n },
  { name: 'SIGNEXTEND', inputs: [1n << 128n, 0x80n], expected: 0x80n },
  { name: 'BYTE', inputs: [31n, 0xabn], expected: 0xabn },
  { name: 'BYTE', inputs: [0n, 0xabn << 248n], expected: 0xabn },
  { name: 'BYTE', inputs: [32n, 0xabn], expected: 0n },
  { name: 'BYTE', inputs: [1n << 128n, 0xabn], expected: 0n },
  { name: 'SHL', inputs: [3n, 5n], expected: 40n },
  { name: 'SHL', inputs: [255n, 1n], expected: 1n << 255n },
  { name: 'SHL', inputs: [256n, 1n], expected: 0n },
  { name: 'SHL', inputs: [1n << 128n, 1n], expected: 0n },
  { name: 'SHR', inputs: [3n, 40n], expected: 5n },
  { name: 'SHR', inputs: [255n, 1n << 255n], expected: 1n },
  { name: 'SHR', inputs: [256n, 1n << 255n], expected: 0n },
  { name: 'SHR', inputs: [1n << 128n, 1n << 255n], expected: 0n },
  { name: 'SAR', inputs: [1n, MAX_UINT256 - 1n], expected: MAX_UINT256 },
  { name: 'SAR', inputs: [255n, 1n << 255n], expected: MAX_UINT256 },
  { name: 'SAR', inputs: [256n, 1n], expected: 0n },
  { name: 'SAR', inputs: [256n, 1n << 255n], expected: MAX_UINT256 },
  { name: 'SAR', inputs: [1n << 128n, 1n << 255n], expected: MAX_UINT256 },
];

const allowedOverLimit = new Set(['DIV', 'SDIV', 'MOD', 'SMOD', 'ADDMOD', 'MULMOD', 'SIGNEXTEND', 'SHL', 'SHR', 'SAR']);

const loadWitnessCalculator = async (name: string): Promise<WitnessCalculator> => {
  const info = subcircuitInfo.find(entry => entry.name === name);
  if (info === undefined) {
    throw new Error(`${name} subcircuit was not found`);
  }
  return builder(readFileSync(path.join(libraryDir, `wasm/subcircuit${info.id}.wasm`)));
};

const normalize = (value: WitnessValue): bigint => BigInt(value.toString());

const main = async (): Promise<void> => {
  for (const operation of operations) {
    const calculator = await loadWitnessCalculator(operation.name);
    const input = operation.inputs.flatMap(split256BitInteger);
    const witness = await calculator.calculateWitness({ in: input }, true);
    const [expectedLow, expectedHigh] = split256BitInteger(operation.expected);
    assert.equal(normalize(witness[1]), expectedLow, `${operation.name} low limb`);
    assert.equal(normalize(witness[2]), expectedHigh, `${operation.name} high limb`);
  }

  const checkBus = await loadWitnessCalculator('CheckBus');
  await checkBus.calculateWitness({ in: split256BitInteger(MAX_UINT256) }, true);
  await assert.rejects(
    checkBus.calculateWitness({ in: [1n << 128n, 0n] }, true),
    undefined,
    'CheckBus must reject a non-canonical limb',
  );

  const constrainedTargets = new Set([...operations.map(operation => operation.name), 'CheckBus']);
  for (const info of subcircuitInfo.filter(entry => constrainedTargets.has(entry.name))) {
    if (info.Nconsts >= 1024) {
      assert.ok(allowedOverLimit.has(info.name), `${info.name} unexpectedly has ${info.Nconsts} constraints`);
      console.warn(`${info.name} exceeds the 1024-constraint target with ${info.Nconsts} constraints`);
    }
  }

  // Keep the host reference exercised with the same modular semantics.
  assert.equal(ArithmeticOperations.addmod([MAX_UINT256, 2n, 7n]), 3n);
  assert.equal(ArithmeticOperations.mulmod([MAX_UINT256, 2n, 7n]), 2n);

  console.log('Per-operation EVM arithmetic subcircuits passed');
};

void main();
