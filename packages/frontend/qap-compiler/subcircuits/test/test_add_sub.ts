import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import builderModule from "./wasm/witness_calculator.js";
import { split256BitInteger } from "./helper_functions.js";
import { ArithmeticOperations } from "../../../synthesizer/core/src/synthesizer/dataStructure/arithmeticOperations.ts";

type WitnessValue = bigint | string | number;
type WitnessCalculator = {
  calculateWitness: (input: Record<string, bigint[]>, sanityCheck?: boolean) => Promise<WitnessValue[]>;
};

type TestCase = {
  name: string;
  selector: bigint;
  in1: bigint;
  in2: bigint;
  expected: bigint;
};

const builder = builderModule as (code: Uint8Array, options?: unknown) => Promise<WitnessCalculator>;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const subcircuitLibraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;
const LOW_LIMB_MAX = (1n << 128n) - 1n;
const RANDOM_CASES = 128;

const randomWord = (): bigint => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);

const loadAlu1 = async (): Promise<WitnessCalculator> => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(subcircuitLibraryDir, "subcircuitInfo.json"), "utf8"),
  ) as Array<{ id: number; name: string }>;
  const alu1Info = subcircuitInfo.find((entry) => entry.name === "ALU1");
  if (alu1Info === undefined) {
    throw new Error("ALU1 subcircuit was not found in subcircuitInfo.json");
  }
  return builder(readFileSync(path.join(subcircuitLibraryDir, `wasm/subcircuit${alu1Info.id}.wasm`)));
};

const cases: TestCase[] = [
  { name: "ADD zero", selector: 1n << 1n, in1: 0n, in2: 0n, expected: 0n },
  {
    name: "ADD low-limb carry",
    selector: 1n << 1n,
    in1: LOW_LIMB_MAX,
    in2: 1n,
    expected: ArithmeticOperations.add([LOW_LIMB_MAX, 1n]),
  },
  {
    name: "ADD full-word overflow",
    selector: 1n << 1n,
    in1: MAX_UINT256,
    in2: 1n,
    expected: ArithmeticOperations.add([MAX_UINT256, 1n]),
  },
  { name: "SUB zero", selector: 1n << 3n, in1: 0n, in2: 0n, expected: 0n },
  {
    name: "SUB low-limb borrow",
    selector: 1n << 3n,
    in1: 1n << 128n,
    in2: 1n,
    expected: ArithmeticOperations.sub([1n << 128n, 1n]),
  },
  {
    name: "SUB full-word underflow",
    selector: 1n << 3n,
    in1: 0n,
    in2: 1n,
    expected: ArithmeticOperations.sub([0n, 1n]),
  },
];

const assertCase = async (
  witnessCalculator: WitnessCalculator,
  testCase: TestCase,
): Promise<void> => {
  const witness = await witnessCalculator.calculateWitness({
    in: [
      testCase.selector,
      ...split256BitInteger(testCase.in1),
      ...split256BitInteger(testCase.in2),
    ],
  }, true);
  const [expectedLow, expectedHigh] = split256BitInteger(testCase.expected);
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${testCase.name} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${testCase.name} high limb`);
};

const main = async (): Promise<void> => {
  const witnessCalculator = await loadAlu1();
  for (const testCase of cases) {
    await assertCase(witnessCalculator, testCase);
  }
  for (let index = 0; index < RANDOM_CASES; index++) {
    const in1 = randomWord();
    const in2 = randomWord();
    await assertCase(witnessCalculator, {
      name: `ADD randomized case ${index}`,
      selector: 1n << 1n,
      in1,
      in2,
      expected: ArithmeticOperations.add([in1, in2]),
    });
    await assertCase(witnessCalculator, {
      name: `SUB randomized case ${index}`,
      selector: 1n << 3n,
      in1,
      in2,
      expected: ArithmeticOperations.sub([in1, in2]),
    });
  }
  console.log(
    `ALU1 ADD/SUB passed ${cases.length} boundary cases and ${RANDOM_CASES * 2} randomized cases`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
