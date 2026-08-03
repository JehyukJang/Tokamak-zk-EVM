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
const expectedShiftRight = (shift, value) => {
  return shift >= 256n ? 0n : value >> shift;
};
const expectedArithmeticShiftRight = (shift, value) => {
  const signedValue = value >> 255n === 0n ? value : value - (1n << 256n);
  return signedValue >> shift & MAX_UINT256;
};

const loadShiftRight = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const shiftRightInfo = subcircuitInfo.find((entry) => entry.name === "ALU6");
  if (shiftRightInfo === undefined) {
    throw new Error("ALU6 subcircuit was not found in subcircuitInfo.json");
  }
  return builder(
    readFileSync(path.join(libraryDir, `wasm/subcircuit${shiftRightInfo.id}.wasm`)),
  );
};

const calculate = (witnessCalculator, selector, shift, value) => {
  return witnessCalculator.calculateWitness({
    in: [
      selector,
      ...split256BitInteger(shift),
      ...split256BitInteger(value),
    ],
  }, true);
};

const assertShiftRight = async (witnessCalculator, shift, value, label) => {
  const witness = await calculate(witnessCalculator, 1n << 28n, shift, value);
  const [expectedLow, expectedHigh] = split256BitInteger(
    expectedShiftRight(shift, value),
  );
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${label} high limb`);
};

const assertArithmeticShiftRight = async (witnessCalculator, shift, value, label) => {
  const witness = await calculate(witnessCalculator, 1n << 29n, shift, value);
  const [expectedLow, expectedHigh] = split256BitInteger(
    expectedArithmeticShiftRight(shift, value),
  );
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${label} high limb`);
};

const mutateAndReject = async (circuit, witness, symbol, value) => {
  const wireIndex = circuit.symbols[symbol]?.varIdx;
  assert.notEqual(wireIndex, undefined, `${symbol} must exist`);
  const maliciousWitness = [...witness];
  maliciousWitness[wireIndex] = value;
  await assert.rejects(
    circuit.checkConstraints(maliciousWitness),
    /Constraint doesn't match/,
    `${symbol} mutation must be rejected`,
  );
};

const main = async () => {
  const witnessCalculator = await loadShiftRight();
  const patternedValue = BigInt(
    `0x${Array.from({ length: 32 }, (_, index) => (index * 7 + 5).toString(16).padStart(2, "0")).join("")}`,
  );
  const boundaryShifts = [
    0n,
    1n,
    63n,
    64n,
    127n,
    128n,
    191n,
    192n,
    254n,
    255n,
    256n,
    257n,
    1n << 128n,
    1n << 255n,
    MAX_UINT256,
  ];
  const boundaryValues = [0n, 1n, patternedValue, MAX_UINT256];
  for (const shift of boundaryShifts) {
    for (const value of boundaryValues) {
      await assertShiftRight(
        witnessCalculator,
        shift,
        value,
        `SHR boundary ${shift}:${value}`,
      );
    }
  }

  for (let index = 0; index < RANDOM_CASES; index++) {
    const value = randomWord();
    await assertShiftRight(
      witnessCalculator,
      BigInt(crypto.randomBytes(1)[0]),
      value,
      `SHR in-range randomized case ${index}`,
    );
    await assertShiftRight(
      witnessCalculator,
      randomWord(),
      value,
      `SHR full-domain randomized case ${index}`,
    );
  }

  const signedBoundaryValues = [
    0n,
    1n,
    1n << 255n,
    (1n << 255n) + 1n,
    MAX_UINT256,
  ];
  for (const shift of boundaryShifts.filter((candidate) => candidate < 256n)) {
    for (const value of signedBoundaryValues) {
      await assertArithmeticShiftRight(
        witnessCalculator,
        shift,
        value,
        `SAR retained boundary ${shift}:${value}`,
      );
    }
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 28n, 0n, 0n, 0n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      witnessCalculator.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }
  await assert.rejects(
    calculate(witnessCalculator, 1n << 27n, 1n, patternedValue),
    undefined,
    "unsupported selector must be rejected",
  );
  await assert.rejects(
    calculate(witnessCalculator, 1n << 29n, 256n, patternedValue),
    undefined,
    "SAR must retain its oversized-shift restriction",
  );

  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/ALU6_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
    },
  );
  const witness = await circuit.calculateWitness({
    in: [1n << 28n, 13n, 0n, ...split256BitInteger(patternedValue)],
  }, true);
  await circuit.loadSymbols();
  await mutateAndReject(circuit, witness, "main.out[0]", 0n);
  await mutateAndReject(circuit, witness, "main.right.quotientWords[0]", 1n << 64n);
  await mutateAndReject(circuit, witness, "main.right.remainder", 1n << 63n);
  await mutateAndReject(circuit, witness, "main.right.carry[0]", 1n << 63n);

  console.log(
    `SHR passed ${boundaryShifts.length * boundaryValues.length} boundary cases, ${RANDOM_CASES} in-range and ${RANDOM_CASES} full-domain randomized cases, retained SAR boundary cases, canonicality checks, bounded-witness mutation checks, and wrong-claim rejection`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
