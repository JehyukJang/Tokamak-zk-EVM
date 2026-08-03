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

const loadAlu4 = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const alu4Info = subcircuitInfo.find((entry) => entry.name === "ALU4");
  if (alu4Info === undefined) {
    throw new Error("ALU4 subcircuit was not found in subcircuitInfo.json");
  }
  return builder(readFileSync(path.join(libraryDir, `wasm/subcircuit${alu4Info.id}.wasm`)));
};

const calculate = (witnessCalculator, selector, dividend, divisor) => {
  return witnessCalculator.calculateWitness({
    in: [
      selector,
      ...split256BitInteger(dividend),
      ...split256BitInteger(divisor),
    ],
  }, true);
};

const assertOperation = async (
  witnessCalculator,
  selector,
  dividend,
  divisor,
  expected,
  label,
) => {
  const witness = await calculate(
    witnessCalculator,
    selector,
    dividend,
    divisor,
  );
  const [expectedLow, expectedHigh] = split256BitInteger(expected);
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

const toggleBitAndReject = async (circuit, witness, symbol) => {
  const wireIndex = circuit.symbols[symbol]?.varIdx;
  assert.notEqual(wireIndex, undefined, `${symbol} must exist`);
  await mutateAndReject(
    circuit,
    witness,
    symbol,
    1n - BigInt(witness[wireIndex].toString()),
  );
};

const main = async () => {
  const witnessCalculator = await loadAlu4();
  const boundaryCases = [
    [0n, 0n],
    [1n, 0n],
    [MAX_UINT256, 0n],
    [0n, 1n],
    [1n, 1n],
    [1n, MAX_UINT256],
    [MAX_UINT256, 1n],
    [MAX_UINT256, 2n],
    [MAX_UINT256, 1n << 128n],
    [MAX_UINT256, MAX_UINT256 - 1n],
    [MAX_UINT256, MAX_UINT256],
    [1n << 255n, (1n << 128n) + 1n],
  ];

  for (const [index, [dividend, divisor]] of boundaryCases.entries()) {
    const expectedQuotient = divisor === 0n ? 0n : dividend / divisor;
    const expectedRemainder = divisor === 0n ? 0n : dividend % divisor;
    await assertOperation(
      witnessCalculator,
      1n << 4n,
      dividend,
      divisor,
      expectedQuotient,
      `DIV boundary case ${index}`,
    );
    await assertOperation(
      witnessCalculator,
      1n << 6n,
      dividend,
      divisor,
      expectedRemainder,
      `MOD boundary case ${index}`,
    );
  }

  for (let index = 0; index < RANDOM_CASES; index++) {
    const dividend = randomWord();
    const divisor = randomWord();
    const expectedQuotient = divisor === 0n ? 0n : dividend / divisor;
    const expectedRemainder = divisor === 0n ? 0n : dividend % divisor;
    await assertOperation(
      witnessCalculator,
      1n << 4n,
      dividend,
      divisor,
      expectedQuotient,
      `DIV randomized case ${index}`,
    );
    await assertOperation(
      witnessCalculator,
      1n << 6n,
      dividend,
      divisor,
      expectedRemainder,
      `MOD randomized case ${index}`,
    );
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 4n, 0n, 0n, 1n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      witnessCalculator.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }
  await assert.rejects(
    calculate(
      witnessCalculator,
      (1n << 4n) + (1n << 6n),
      MAX_UINT256,
      3n,
    ),
    undefined,
    "unsupported selector must be rejected",
  );

  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/ALU4_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
    },
  );
  const mutationDividend = MAX_UINT256;
  const mutationDivisor = (1n << 128n) + 12345n;
  const witness = await circuit.calculateWitness({
    in: [
      1n << 6n,
      ...split256BitInteger(mutationDividend),
      ...split256BitInteger(mutationDivisor),
    ],
  }, true);
  await circuit.loadSymbols();

  const quotientLowIndex = circuit.symbols["main.div.relationQuotient[0]"]?.varIdx;
  assert.notEqual(quotientLowIndex, undefined);
  await mutateAndReject(
    circuit,
    witness,
    "main.div.relationQuotient[0]",
    BigInt(witness[quotientLowIndex].toString()) + 1n,
  );
  await mutateAndReject(circuit, witness, "main.div.carry[0]", 1n << 65n);
  await mutateAndReject(circuit, witness, "main.div.carry[1]", 1n << 66n);
  await mutateAndReject(circuit, witness, "main.div.coefficient[4]", 1n);
  await toggleBitAndReject(circuit, witness, "main.div.quotientBits[0].out[0]");
  await toggleBitAndReject(circuit, witness, "main.div.remainderBits[0].out[0]");
  await toggleBitAndReject(circuit, witness, "main.div.divisorBits[0].out[0]");
  await mutateAndReject(circuit, witness, "main.out[0]", 0n);

  console.log(
    `ALU4 DIV/MOD passed ${boundaryCases.length} boundary cases and ${RANDOM_CASES} randomized cases per operation, zero-divisor behavior, canonicality and selector rejection, and bounded quotient-remainder and high-block witness mutations`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
