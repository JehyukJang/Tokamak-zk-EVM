import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import builderModule from "./wasm/witness_calculator.js";
import { EvmArithmetic } from "./evm_arithmetic.ts";
import { split256BitInteger } from "./helper_functions.js";

type WitnessValue = bigint | string | number;
type WitnessCalculator = {
  calculateWitness: (input: Record<string, bigint[]>, sanityCheck?: boolean) => Promise<WitnessValue[]>;
};

type Alu1Input = {
  in1: bigint;
  in2: bigint;
  expected: bigint;
};

type Alu3Or4Input = {
  in1: bigint;
  in2: bigint;
  in3: bigint;
  expected: bigint;
};

type Alu1OpCase = {
  name: string;
  selector: bigint;
  edgeCases: Alu1Input[];
  sample: (iteration: number) => Alu1Input;
};

type Alu3Or4OpCase = {
  name: string;
  selector: bigint;
  edgeCases: Alu3Or4Input[];
  sample: (iteration: number) => Alu3Or4Input;
};

const RANDOM_CASES = 500;
const builder = builderModule as (code: Uint8Array, options?: unknown) => Promise<WitnessCalculator>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const subcircuitLibraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_INT256 = 1n << 255n;
const NEG_ONE = MAX_UINT256;

const randomNByteBigInt = (nBytes: number): bigint => {
  const buf = crypto.randomBytes(nBytes);
  let result = 0n;
  for (const byte of buf) {
    result = (result << 8n) + BigInt(byte);
  }
  return result;
};

const randomWord = (): bigint => randomNByteBigInt(32);
const randomSmall = (): bigint => randomNByteBigInt(1);
const normalizeWitnessValue = (value: WitnessValue): bigint => BigInt(value.toString());

const loadWitnessCalculator = async (name: "ALU1" | "ALU2" | "ALU3" | "ALU4"): Promise<WitnessCalculator> => {
  const subcircuitInfoPath = path.join(subcircuitLibraryDir, "subcircuitInfo.json");
  const subcircuitInfo = JSON.parse(readFileSync(subcircuitInfoPath, "utf8")) as Array<{ id: number; name: string }>;
  const targetInfo = subcircuitInfo.find((entry) => entry.name === name);
  if (targetInfo === undefined) {
    throw new Error(`${name} subcircuit was not found in subcircuitInfo.json`);
  }

  const wasmPath = path.join(subcircuitLibraryDir, `wasm/subcircuit${targetInfo.id}.wasm`);
  return builder(readFileSync(wasmPath));
};

const encodeAlu1Input = (selector: bigint, in1: bigint, in2: bigint): bigint[] => {
  return [selector, ...split256BitInteger(in1), ...split256BitInteger(in2)];
};

const encodeAlu3Input = (selector: bigint, in1: bigint, in2: bigint, in3: bigint): bigint[] => {
  return [selector, ...split256BitInteger(in1), ...split256BitInteger(in2), ...split256BitInteger(in3)];
};

const assertWitnessMatches = (witness: WitnessValue[], expected: bigint, label: string): void => {
  const [expectedLo, expectedHi] = split256BitInteger(expected);
  assert.equal(normalizeWitnessValue(witness[1]), expectedLo, `low limb mismatch for ${label}`);
  assert.equal(normalizeWitnessValue(witness[2]), expectedHi, `high limb mismatch for ${label}`);
};

const expectWitnessFailure = async (
  runWitness: Promise<WitnessValue[]>,
  label: string,
): Promise<void> => {
  const didFail = await runWitness.then(
    () => false,
    () => true,
  );
  assert.equal(didFail, true, `${label} was expected to fail`);
};

const runAlu1Op = async (
  witnessCalculator: WitnessCalculator,
  target: "ALU1" | "ALU2",
  opCase: Alu1OpCase,
): Promise<void> => {
  for (const [index, edgeCase] of opCase.edgeCases.entries()) {
    const witness = await witnessCalculator.calculateWitness(
      { in: encodeAlu1Input(opCase.selector, edgeCase.in1, edgeCase.in2) },
      true,
    );
    assertWitnessMatches(witness, edgeCase.expected, `${target} ${opCase.name} edge ${index}`);
  }
  for (let iteration = 0; iteration < RANDOM_CASES; iteration++) {
    const { in1, in2, expected } = opCase.sample(iteration);
    const witness = await witnessCalculator.calculateWitness(
      { in: encodeAlu1Input(opCase.selector, in1, in2) },
      true,
    );
    assertWitnessMatches(witness, expected, `${target} ${opCase.name} case ${iteration}`);
  }
  console.log(`${target} ${opCase.name} passed ${opCase.edgeCases.length} edge cases and ${RANDOM_CASES} randomized cases`);
};

const runAlu3Or4Op = async (
  witnessCalculator: WitnessCalculator,
  target: "ALU3" | "ALU4",
  opCase: Alu3Or4OpCase,
): Promise<void> => {
  for (const [index, edgeCase] of opCase.edgeCases.entries()) {
    const input = target === "ALU3"
      ? encodeAlu3Input(opCase.selector, edgeCase.in1, edgeCase.in2, edgeCase.in3)
      : encodeAlu1Input(opCase.selector, edgeCase.in1, edgeCase.in2);
    const witness = await witnessCalculator.calculateWitness(
      { in: input },
      true,
    );
    assertWitnessMatches(witness, edgeCase.expected, `${target} ${opCase.name} edge ${index}`);
  }
  for (let iteration = 0; iteration < RANDOM_CASES; iteration++) {
    const { in1, in2, in3, expected } = opCase.sample(iteration);
    const input = target === "ALU3"
      ? encodeAlu3Input(opCase.selector, in1, in2, in3)
      : encodeAlu1Input(opCase.selector, in1, in2);
    const witness = await witnessCalculator.calculateWitness(
      { in: input },
      true,
    );
    assertWitnessMatches(witness, expected, `${target} ${opCase.name} case ${iteration}`);
  }
  console.log(`${target} ${opCase.name} passed ${opCase.edgeCases.length} edge cases and ${RANDOM_CASES} randomized cases`);
};

const main = async (): Promise<void> => {
  const alu1WitnessCalculator = await loadWitnessCalculator("ALU1");
  const alu2WitnessCalculator = await loadWitnessCalculator("ALU2");
  const alu3WitnessCalculator = await loadWitnessCalculator("ALU3");
  const alu4WitnessCalculator = await loadWitnessCalculator("ALU4");

  const alu1Cases: Alu1OpCase[] = [
    {
      name: "ADD",
      selector: 1n << 1n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.add([0n, 0n]) },
        { in1: MAX_UINT256, in2: 1n, expected: EvmArithmetic.add([MAX_UINT256, 1n]) },
        { in1: MIN_INT256, in2: MIN_INT256, expected: EvmArithmetic.add([MIN_INT256, MIN_INT256]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.add([in1, in2]) };
      },
    },
    {
      name: "MUL",
      selector: 1n << 2n,
      edgeCases: [
        { in1: 0n, in2: MAX_UINT256, expected: EvmArithmetic.mul([0n, MAX_UINT256]) },
        { in1: 1n, in2: MAX_UINT256, expected: EvmArithmetic.mul([1n, MAX_UINT256]) },
        { in1: MIN_INT256, in2: 2n, expected: EvmArithmetic.mul([MIN_INT256, 2n]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.mul([in1, in2]) };
      },
    },
    {
      name: "SUB",
      selector: 1n << 3n,
      edgeCases: [
        { in1: 0n, in2: 1n, expected: EvmArithmetic.sub([0n, 1n]) },
        { in1: MAX_UINT256, in2: MAX_UINT256, expected: EvmArithmetic.sub([MAX_UINT256, MAX_UINT256]) },
        { in1: MIN_INT256, in2: 1n, expected: EvmArithmetic.sub([MIN_INT256, 1n]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.sub([in1, in2]) };
      },
    },
    {
      name: "LT",
      selector: 1n << 16n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.lt([0n, 0n]) },
        { in1: 0n, in2: 1n, expected: EvmArithmetic.lt([0n, 1n]) },
        { in1: MAX_UINT256, in2: 0n, expected: EvmArithmetic.lt([MAX_UINT256, 0n]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.lt([in1, in2]) };
      },
    },
    {
      name: "GT",
      selector: 1n << 17n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.gt([0n, 0n]) },
        { in1: 1n, in2: 0n, expected: EvmArithmetic.gt([1n, 0n]) },
        { in1: 0n, in2: MAX_UINT256, expected: EvmArithmetic.gt([0n, MAX_UINT256]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.gt([in1, in2]) };
      },
    },
    {
      name: "SLT",
      selector: 1n << 18n,
      edgeCases: [
        { in1: MIN_INT256, in2: 0n, expected: EvmArithmetic.slt([MIN_INT256, 0n]) },
        { in1: NEG_ONE, in2: 0n, expected: EvmArithmetic.slt([NEG_ONE, 0n]) },
        { in1: 0n, in2: NEG_ONE, expected: EvmArithmetic.slt([0n, NEG_ONE]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.slt([in1, in2]) };
      },
    },
    {
      name: "SGT",
      selector: 1n << 19n,
      edgeCases: [
        { in1: MIN_INT256, in2: 0n, expected: EvmArithmetic.sgt([MIN_INT256, 0n]) },
        { in1: 0n, in2: NEG_ONE, expected: EvmArithmetic.sgt([0n, NEG_ONE]) },
        { in1: NEG_ONE, in2: MIN_INT256, expected: EvmArithmetic.sgt([NEG_ONE, MIN_INT256]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.sgt([in1, in2]) };
      },
    },
    {
      name: "EQ",
      selector: 1n << 20n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.eq([0n, 0n]) },
        { in1: MAX_UINT256, in2: MAX_UINT256, expected: EvmArithmetic.eq([MAX_UINT256, MAX_UINT256]) },
        { in1: 0n, in2: 1n, expected: EvmArithmetic.eq([0n, 1n]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = iteration % 10 === 0 ? in1 : randomWord();
        return { in1, in2, expected: EvmArithmetic.eq([in1, in2]) };
      },
    },
    {
      name: "ISZERO",
      selector: 1n << 21n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.iszero([0n]) },
        { in1: 1n, in2: 0n, expected: EvmArithmetic.iszero([1n]) },
        { in1: MAX_UINT256, in2: 0n, expected: EvmArithmetic.iszero([MAX_UINT256]) },
      ],
      sample: (iteration) => {
        const in1 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2: 0n, expected: EvmArithmetic.iszero([in1]) };
      },
    },
    {
      name: "AND",
      selector: 1n << 22n,
      edgeCases: [
        { in1: 0n, in2: MAX_UINT256, expected: EvmArithmetic.and([0n, MAX_UINT256]) },
        { in1: MAX_UINT256, in2: MAX_UINT256, expected: EvmArithmetic.and([MAX_UINT256, MAX_UINT256]) },
        { in1: MIN_INT256, in2: NEG_ONE, expected: EvmArithmetic.and([MIN_INT256, NEG_ONE]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.and([in1, in2]) };
      },
    },
    {
      name: "OR",
      selector: 1n << 23n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.or([0n, 0n]) },
        { in1: 0n, in2: MAX_UINT256, expected: EvmArithmetic.or([0n, MAX_UINT256]) },
        { in1: MIN_INT256, in2: 1n, expected: EvmArithmetic.or([MIN_INT256, 1n]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.or([in1, in2]) };
      },
    },
    {
      name: "XOR",
      selector: 1n << 24n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.xor([0n, 0n]) },
        { in1: MAX_UINT256, in2: MAX_UINT256, expected: EvmArithmetic.xor([MAX_UINT256, MAX_UINT256]) },
        { in1: MIN_INT256, in2: NEG_ONE, expected: EvmArithmetic.xor([MIN_INT256, NEG_ONE]) },
      ],
      sample: () => {
        const in1 = randomWord();
        const in2 = randomWord();
        return { in1, in2, expected: EvmArithmetic.xor([in1, in2]) };
      },
    },
    {
      name: "NOT",
      selector: 1n << 25n,
      edgeCases: [
        { in1: 0n, in2: 0n, expected: EvmArithmetic.not([0n]) },
        { in1: MAX_UINT256, in2: 0n, expected: EvmArithmetic.not([MAX_UINT256]) },
        { in1: MIN_INT256, in2: 0n, expected: EvmArithmetic.not([MIN_INT256]) },
      ],
      sample: () => {
        const in1 = randomWord();
        return { in1, in2: 0n, expected: EvmArithmetic.not([in1]) };
      },
    },
  ];

  const alu3Or4Cases: Alu3Or4OpCase[] = [
    {
      name: "DIV",
      selector: 1n << 4n,
      edgeCases: [
        { in1: 0n, in2: 0n, in3: 0n, expected: EvmArithmetic.div([0n, 0n]) },
        { in1: MAX_UINT256, in2: 1n, in3: 0n, expected: EvmArithmetic.div([MAX_UINT256, 1n]) },
        { in1: MAX_UINT256, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.div([MAX_UINT256, MAX_UINT256]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.div([in1, in2]) };
      },
    },
    {
      name: "SDIV",
      selector: 1n << 5n,
      edgeCases: [
        { in1: MIN_INT256, in2: NEG_ONE, in3: 0n, expected: EvmArithmetic.sdiv([MIN_INT256, NEG_ONE]) },
        { in1: NEG_ONE, in2: 1n, in3: 0n, expected: EvmArithmetic.sdiv([NEG_ONE, 1n]) },
        { in1: 0n, in2: 0n, in3: 0n, expected: EvmArithmetic.sdiv([0n, 0n]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.sdiv([in1, in2]) };
      },
    },
    {
      name: "MOD",
      selector: 1n << 6n,
      edgeCases: [
        { in1: 0n, in2: 0n, in3: 0n, expected: EvmArithmetic.mod([0n, 0n]) },
        { in1: MAX_UINT256, in2: 1n, in3: 0n, expected: EvmArithmetic.mod([MAX_UINT256, 1n]) },
        { in1: MAX_UINT256, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.mod([MAX_UINT256, MAX_UINT256]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.mod([in1, in2]) };
      },
    },
    {
      name: "SMOD",
      selector: 1n << 7n,
      edgeCases: [
        { in1: MIN_INT256, in2: NEG_ONE, in3: 0n, expected: EvmArithmetic.smod([MIN_INT256, NEG_ONE]) },
        { in1: NEG_ONE, in2: 2n, in3: 0n, expected: EvmArithmetic.smod([NEG_ONE, 2n]) },
        { in1: 0n, in2: 0n, in3: 0n, expected: EvmArithmetic.smod([0n, 0n]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.smod([in1, in2]) };
      },
    },
    {
      name: "ADDMOD",
      selector: 1n << 8n,
      edgeCases: [
        { in1: 0n, in2: 0n, in3: 0n, expected: EvmArithmetic.addmod([0n, 0n, 0n]) },
        { in1: MAX_UINT256, in2: 1n, in3: MAX_UINT256, expected: EvmArithmetic.addmod([MAX_UINT256, 1n, MAX_UINT256]) },
        { in1: MIN_INT256, in2: MIN_INT256, in3: 97n, expected: EvmArithmetic.addmod([MIN_INT256, MIN_INT256, 97n]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = randomWord();
        const in3 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2, in3, expected: EvmArithmetic.addmod([in1, in2, in3]) };
      },
    },
    {
      name: "MULMOD",
      selector: 1n << 9n,
      edgeCases: [
        { in1: 0n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.mulmod([0n, MAX_UINT256, 0n]) },
        { in1: MAX_UINT256, in2: 1n, in3: MAX_UINT256, expected: EvmArithmetic.mulmod([MAX_UINT256, 1n, MAX_UINT256]) },
        { in1: MIN_INT256, in2: 2n, in3: 97n, expected: EvmArithmetic.mulmod([MIN_INT256, 2n, 97n]) },
      ],
      sample: (iteration) => {
        const in1 = randomWord();
        const in2 = randomWord();
        const in3 = iteration % 10 === 0 ? 0n : randomWord();
        return { in1, in2, in3, expected: EvmArithmetic.mulmod([in1, in2, in3]) };
      },
    },
    {
      name: "SIGNEXTEND",
      selector: 1n << 11n,
      edgeCases: [
        { in1: 0n, in2: 0x80n, in3: 0n, expected: EvmArithmetic.signextend([0n, 0x80n]) },
        { in1: 30n, in2: MIN_INT256, in3: 0n, expected: EvmArithmetic.signextend([30n, MIN_INT256]) },
        { in1: 31n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.signextend([31n, MAX_UINT256]) },
        { in1: 32n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.signextend([32n, MAX_UINT256]) },
        { in1: 255n, in2: 1n, in3: 0n, expected: EvmArithmetic.signextend([255n, 1n]) },
      ],
      sample: () => {
        const in1 = randomSmall();
        const in2 = randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.signextend([in1, in2]) };
      },
    },
    {
      name: "BYTE",
      selector: 1n << 26n,
      edgeCases: [
        { in1: 0n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.byte([0n, MAX_UINT256]) },
        { in1: 31n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.byte([31n, MAX_UINT256]) },
        { in1: 32n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.byte([32n, MAX_UINT256]) },
        { in1: 255n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.byte([255n, MAX_UINT256]) },
      ],
      sample: () => {
        const in1 = randomSmall();
        const in2 = randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.byte([in1, in2]) };
      },
    },
    {
      name: "SHL",
      selector: 1n << 27n,
      edgeCases: [
        { in1: 0n, in2: 1n, in3: 0n, expected: EvmArithmetic.shl([0n, 1n]) },
        { in1: 1n, in2: 1n, in3: 0n, expected: EvmArithmetic.shl([1n, 1n]) },
        { in1: 127n, in2: 1n, in3: 0n, expected: EvmArithmetic.shl([127n, 1n]) },
        { in1: 128n, in2: 1n, in3: 0n, expected: EvmArithmetic.shl([128n, 1n]) },
        { in1: 255n, in2: 1n, in3: 0n, expected: EvmArithmetic.shl([255n, 1n]) },
      ],
      sample: () => {
        const in1 = randomSmall();
        const in2 = randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.shl([in1, in2]) };
      },
    },
    {
      name: "SHR",
      selector: 1n << 28n,
      edgeCases: [
        { in1: 0n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.shr([0n, MAX_UINT256]) },
        { in1: 1n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.shr([1n, MAX_UINT256]) },
        { in1: 127n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.shr([127n, MAX_UINT256]) },
        { in1: 128n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.shr([128n, MAX_UINT256]) },
        { in1: 255n, in2: MAX_UINT256, in3: 0n, expected: EvmArithmetic.shr([255n, MAX_UINT256]) },
      ],
      sample: () => {
        const in1 = randomSmall();
        const in2 = randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.shr([in1, in2]) };
      },
    },
    {
      name: "SAR",
      selector: 1n << 29n,
      edgeCases: [
        { in1: 0n, in2: NEG_ONE, in3: 0n, expected: EvmArithmetic.sar([0n, NEG_ONE]) },
        { in1: 1n, in2: NEG_ONE, in3: 0n, expected: EvmArithmetic.sar([1n, NEG_ONE]) },
        { in1: 127n, in2: MIN_INT256, in3: 0n, expected: EvmArithmetic.sar([127n, MIN_INT256]) },
        { in1: 128n, in2: MIN_INT256, in3: 0n, expected: EvmArithmetic.sar([128n, MIN_INT256]) },
        { in1: 255n, in2: MIN_INT256, in3: 0n, expected: EvmArithmetic.sar([255n, MIN_INT256]) },
      ],
      sample: () => {
        const in1 = randomSmall();
        const in2 = randomWord();
        return { in1, in2, in3: 0n, expected: EvmArithmetic.sar([in1, in2]) };
      },
    },
  ];

  const alu2Operations = new Set(["AND", "OR", "XOR", "NOT"]);
  for (const opCase of alu1Cases) {
    const target = alu2Operations.has(opCase.name) ? "ALU2" : "ALU1";
    const witnessCalculator = target === "ALU2" ? alu2WitnessCalculator : alu1WitnessCalculator;
    await runAlu1Op(witnessCalculator, target, opCase);
  }

  const alu3Operations = new Set(["DIV", "SDIV", "MOD", "SMOD", "ADDMOD", "MULMOD"]);
  for (const opCase of alu3Or4Cases) {
    const target = alu3Operations.has(opCase.name) ? "ALU3" : "ALU4";
    const witnessCalculator = target === "ALU3" ? alu3WitnessCalculator : alu4WitnessCalculator;
    await runAlu3Or4Op(witnessCalculator, target, opCase);
  }

  await expectWitnessFailure(
    alu4WitnessCalculator.calculateWitness(
      { in: encodeAlu1Input(1n << 28n, 300n, randomWord()) },
      true,
    ),
    "ALU4 invalid shift test",
  );
  console.log("ALU4 invalid shift test passed");

  await expectWitnessFailure(
    alu1WitnessCalculator.calculateWitness(
      { in: encodeAlu1Input((1n << 1n) + (1n << 10n), 7n, 9n) },
      true,
    ),
    "ALU1 invalid selector test",
  );
  console.log("ALU1 invalid selector test passed");

  await expectWitnessFailure(
    alu2WitnessCalculator.calculateWitness(
      { in: encodeAlu1Input((1n << 22n) + (1n << 10n), 7n, 9n) },
      true,
    ),
    "ALU2 invalid selector test",
  );
  console.log("ALU2 invalid selector test passed");

  await expectWitnessFailure(
    alu1WitnessCalculator.calculateWitness(
      { in: [1n << 1n, 1n << 128n, 0n, 0n, 0n] },
      true,
    ),
    "ALU1 invalid limb test",
  );
  console.log("ALU1 invalid limb test passed");

  await expectWitnessFailure(
    alu2WitnessCalculator.calculateWitness(
      { in: [1n << 22n, 1n << 128n, 0n, 0n, 0n] },
      true,
    ),
    "ALU2 invalid limb test",
  );
  console.log("ALU2 invalid limb test passed");

  await expectWitnessFailure(
    alu3WitnessCalculator.calculateWitness(
      { in: encodeAlu3Input((1n << 4n) + (1n << 10n), 9n, 3n, 0n) },
      true,
    ),
    "ALU3 invalid selector test",
  );
  console.log("ALU3 invalid selector test passed");

  await expectWitnessFailure(
    alu3WitnessCalculator.calculateWitness(
      { in: [1n << 4n, 1n << 128n, 0n, 1n, 0n, 0n, 0n] },
      true,
    ),
    "ALU3 invalid limb test",
  );
  console.log("ALU3 invalid limb test passed");

  await expectWitnessFailure(
    alu4WitnessCalculator.calculateWitness(
      { in: encodeAlu1Input((1n << 28n) + (1n << 4n), 1n, 5n) },
      true,
    ),
    "ALU4 invalid selector test",
  );
  console.log("ALU4 invalid selector test passed");

  await expectWitnessFailure(
    alu4WitnessCalculator.calculateWitness(
      { in: [1n << 11n, 5n, 1n, ...split256BitInteger(0x80n)] },
      true,
    ),
    "ALU4 invalid signextend high-limb test",
  );
  console.log("ALU4 invalid signextend high-limb test passed");

  await expectWitnessFailure(
    alu4WitnessCalculator.calculateWitness(
      { in: [1n << 26n, 31n, 42n, ...split256BitInteger(MAX_UINT256)] },
      true,
    ),
    "ALU4 invalid byte high-limb test",
  );
  console.log("ALU4 invalid byte high-limb test passed");

  await expectWitnessFailure(
    alu4WitnessCalculator.calculateWitness(
      { in: [1n << 28n, 1n, 123456789n, ...split256BitInteger(5n)] },
      true,
    ),
    "ALU4 invalid shift high-limb test",
  );
  console.log("ALU4 invalid shift high-limb test passed");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
