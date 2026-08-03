const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const { wasm } = require("circom_tester");
const builder = require("./wasm/witness_calculator.js");
const { split256BitInteger } = require("./helper_functions.js");

const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR
  ?? path.join(__dirname, "../library");
const WORD_BASE = 1n << 256n;
const SIGN_BIT = 1n << 255n;
const MAX_UINT256 = WORD_BASE - 1n;
const RANDOM_CASES = 256;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
const toSigned = (value) => value >= SIGN_BIT ? value - WORD_BASE : value;

const loadAlu3 = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const alu3Info = subcircuitInfo.find((entry) => entry.name === "ALU3");
  if (alu3Info === undefined) {
    throw new Error("ALU3 subcircuit was not found in subcircuitInfo.json");
  }
  return builder(readFileSync(path.join(libraryDir, `wasm/subcircuit${alu3Info.id}.wasm`)));
};

const calculate = (witnessCalculator, selector, in1, in2) => {
  return witnessCalculator.calculateWitness({
    in: [
      selector,
      ...split256BitInteger(in1),
      ...split256BitInteger(in2),
    ],
  }, true);
};

const assertComparison = async (
  witnessCalculator,
  selector,
  in1,
  in2,
  expected,
  label,
) => {
  const witness = await calculate(witnessCalculator, selector, in1, in2);
  assert.equal(BigInt(witness[1].toString()), expected, label);
  assert.equal(BigInt(witness[2].toString()), 0n, `${label} high limb`);
};

const main = async () => {
  const witnessCalculator = await loadAlu3();
  const selectors = [
    {
      name: "SLT",
      value: 1n << 18n,
      compare: (in1, in2) => BigInt(toSigned(in1) < toSigned(in2)),
    },
    {
      name: "SGT",
      value: 1n << 19n,
      compare: (in1, in2) => BigInt(toSigned(in1) > toSigned(in2)),
    },
  ];
  const boundaries = [
    0n,
    1n,
    SIGN_BIT - 1n,
    SIGN_BIT,
    MAX_UINT256 - 1n,
    MAX_UINT256,
  ];

  for (const selector of selectors) {
    for (const in1 of boundaries) {
      for (const in2 of boundaries) {
        await assertComparison(
          witnessCalculator,
          selector.value,
          in1,
          in2,
          selector.compare(in1, in2),
          `${selector.name} boundary ${in1}:${in2}`,
        );
      }
    }
    for (let index = 0; index < RANDOM_CASES; index++) {
      const in1 = randomWord();
      const in2 = randomWord();
      await assertComparison(
        witnessCalculator,
        selector.value,
        in1,
        in2,
        selector.compare(in1, in2),
        `${selector.name} randomized case ${index}`,
      );
    }
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 18n, 0n, 0n, 0n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      witnessCalculator.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }
  await assert.rejects(
    calculate(witnessCalculator, (1n << 18n) + (1n << 19n), 0n, 1n),
    undefined,
    "unsupported selector must be rejected",
  );

  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/ALU3_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
    },
  );
  const witness = await circuit.calculateWitness({
    in: [1n << 18n, ...split256BitInteger(SIGN_BIT), 0n, 0n],
  }, true);
  await circuit.loadSymbols();
  const outputIndex = circuit.symbols["main.out[0]"]?.varIdx;
  assert.notEqual(outputIndex, undefined);
  const maliciousWitness = [...witness];
  maliciousWitness[outputIndex] = 0n;
  await assert.rejects(
    circuit.checkConstraints(maliciousWitness),
    /Constraint doesn't match/,
  );

  console.log(
    `ALU3 SLT/SGT passed ${boundaries.length ** 2} boundary pairs and ${RANDOM_CASES} randomized cases per operation, canonicality checks, and wrong-claim rejection`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
