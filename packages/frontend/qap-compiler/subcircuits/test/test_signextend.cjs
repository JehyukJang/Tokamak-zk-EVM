const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const { wasm } = require("circom_tester");
const builder = require("./wasm/witness_calculator.js");
const { split256BitInteger } = require("./helper_functions.js");

const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR
  ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;
const RANDOM_CASES = 128;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
const expectedSignExtend = (index, value) => {
  if (index >= 32n) {
    return value;
  }
  const signPosition = 8n * index + 7n;
  const retainedMask = (1n << (signPosition + 1n)) - 1n;
  if ((value >> signPosition & 1n) === 1n) {
    return value | (MAX_UINT256 ^ retainedMask);
  }
  return value & retainedMask;
};

const loadSignExtend = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const signExtendInfo = subcircuitInfo.find((entry) => entry.name === "SIGNEXTEND");
  if (signExtendInfo === undefined) {
    throw new Error("SIGNEXTEND subcircuit was not found in subcircuitInfo.json");
  }
  return builder(
    readFileSync(path.join(libraryDir, `wasm/subcircuit${signExtendInfo.id}.wasm`)),
  );
};

const calculate = (witnessCalculator, selector, index, value) => {
  return witnessCalculator.calculateWitness({
    in: [
      selector,
      ...split256BitInteger(index),
      ...split256BitInteger(value),
    ],
  }, true);
};

const assertSignExtend = async (witnessCalculator, index, value, label) => {
  const witness = await calculate(witnessCalculator, 1n << 11n, index, value);
  const [expectedLow, expectedHigh] = split256BitInteger(
    expectedSignExtend(index, value),
  );
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${label} high limb`);
};

const main = async () => {
  const witnessCalculator = await loadSignExtend();
  const patternedValue = BigInt(
    `0x${Array.from({ length: 32 }, (_, index) => (index * 7 + 3).toString(16).padStart(2, "0")).join("")}`,
  );
  const boundaryIndices = [
    0n,
    1n,
    15n,
    16n,
    30n,
    31n,
    32n,
    33n,
    255n,
    256n,
    1n << 128n,
    1n << 255n,
    MAX_UINT256,
  ];
  const boundaryValues = [0n, patternedValue, MAX_UINT256];
  for (const index of boundaryIndices) {
    for (const value of boundaryValues) {
      await assertSignExtend(
        witnessCalculator,
        index,
        value,
        `SIGNEXTEND boundary ${index}:${value}`,
      );
    }
  }

  for (let index = 0; index < RANDOM_CASES; index++) {
    const value = randomWord();
    await assertSignExtend(
      witnessCalculator,
      BigInt(crypto.randomBytes(1)[0] & 31),
      value,
      `SIGNEXTEND in-range randomized case ${index}`,
    );
    await assertSignExtend(
      witnessCalculator,
      randomWord(),
      value,
      `SIGNEXTEND full-domain randomized case ${index}`,
    );
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 11n, 0n, 0n, 0n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      witnessCalculator.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }
  await assert.rejects(
    calculate(witnessCalculator, 1n << 12n, 0n, patternedValue),
    undefined,
    "unsupported selector must be rejected",
  );

  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/SIGNEXTEND_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );
  const witness = await circuit.calculateWitness({
    in: [1n << 11n, 0n, 0n, 0x80n, 0n],
  }, true);
  await circuit.loadSymbols();
  const outputLowIndex = circuit.symbols["main.out[0]"]?.varIdx;
  assert.notEqual(outputLowIndex, undefined);
  const maliciousWitness = [...witness];
  maliciousWitness[outputLowIndex] = 0n;
  await assert.rejects(
    circuit.checkConstraints(maliciousWitness),
    /Constraint doesn't match/,
  );

  console.log(
    `SIGNEXTEND passed ${boundaryIndices.length * boundaryValues.length} boundary cases, ${RANDOM_CASES} in-range and ${RANDOM_CASES} full-domain randomized cases, canonicality checks, and wrong-claim rejection`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
