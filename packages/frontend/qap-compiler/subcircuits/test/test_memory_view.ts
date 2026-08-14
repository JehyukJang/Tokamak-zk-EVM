import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import builderModule from "./wasm/witness_calculator.js";
import { split256BitInteger } from "./helper_functions.js";

type WitnessValue = bigint | string | number;
type WitnessCalculator = {
  calculateWitness: (
    input: Record<string, bigint[]>,
    sanityCheck?: boolean,
  ) => Promise<WitnessValue[]>;
};

const builder = builderModule as (code: Uint8Array) => Promise<WitnessCalculator>;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const libraryDir = path.join(__dirname, "../library");

const loadWitnessCalculator = async (): Promise<WitnessCalculator> => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  ) as Array<{ id: number; name: string }>;
  const memoryViewInfo = subcircuitInfo.find(({ name }) => name === "MemoryViewStep");
  if (memoryViewInfo === undefined) {
    throw new Error("MemoryViewStep subcircuit was not found in subcircuitInfo.json");
  }
  return builder(
    readFileSync(path.join(libraryDir, `wasm/subcircuit${memoryViewInfo.id}.wasm`)),
  );
};

const encodeInput = (
  sourceWord: bigint,
  encodedShift: bigint,
  incomingOwnership: bigint,
  previousWord = 0n,
  previousOwnership = 0n,
): bigint[] => [
  ...split256BitInteger(sourceWord),
  encodedShift,
  incomingOwnership,
  ...split256BitInteger(previousWord),
  previousOwnership,
];

const expectResult = async (
  calculator: WitnessCalculator,
  input: bigint[],
  expectedWord: bigint,
  expectedOwnership: bigint,
): Promise<void> => {
  const witness = await calculator.calculateWitness({ in: input }, true);
  const [expectedLow, expectedHigh] = split256BitInteger(expectedWord);
  assert.equal(BigInt(witness[1]!.toString()), expectedLow);
  assert.equal(BigInt(witness[2]!.toString()), expectedHigh);
  assert.equal(BigInt(witness[3]!.toString()), expectedOwnership);
};

const expectFailure = async (
  calculator: WitnessCalculator,
  input: bigint[],
): Promise<void> => {
  await assert.rejects(calculator.calculateWitness({ in: input }, true));
};

const main = async (): Promise<void> => {
  const calculator = await loadWitnessCalculator();
  const highByte = 0xabn << 248n;

  await expectResult(calculator, encodeInput(0xabn, 0n, 1n), 0xabn, 1n);
  await expectResult(calculator, encodeInput(0xabn, 31n, 1n << 31n), highByte, 1n << 31n);
  await expectResult(calculator, encodeInput(0xabn, 32n, 1n), 0xabn, 1n);
  await expectResult(calculator, encodeInput(highByte, 63n, 1n), 0xabn, 1n);

  await expectFailure(calculator, encodeInput(1n, 64n, 1n));
  await expectFailure(calculator, encodeInput(1n, 0n, 1n, 0n, 1n));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
