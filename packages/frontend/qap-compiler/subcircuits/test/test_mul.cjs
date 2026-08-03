const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const builder = require("./wasm/witness_calculator.js");
const { split256BitInteger } = require("./helper_functions.js");

const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR
  ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;
const RANDOM_CASES = 128;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);

const loadAlu1 = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const alu1Info = subcircuitInfo.find((entry) => entry.name === "ALU1");
  if (alu1Info === undefined) {
    throw new Error("ALU1 subcircuit was not found in subcircuitInfo.json");
  }
  return builder(readFileSync(path.join(libraryDir, `wasm/subcircuit${alu1Info.id}.wasm`)));
};

const assertAlu1 = async (
  witnessCalculator,
  selector,
  in1,
  in2,
  expected,
  label,
) => {
  const witness = await witnessCalculator.calculateWitness({
    in: [
      selector,
      ...split256BitInteger(in1),
      ...split256BitInteger(in2),
    ],
  }, true);
  const [expectedLow, expectedHigh] = split256BitInteger(expected);
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${label} high limb`);
};

const assertMul = async (witnessCalculator, in1, in2, label) => {
  await assertAlu1(
    witnessCalculator,
    1n << 2n,
    in1,
    in2,
    in1 * in2 & MAX_UINT256,
    label,
  );
};

const main = async () => {
  const witnessCalculator = await loadAlu1();
  const boundaryCases = [
    [0n, MAX_UINT256],
    [1n, MAX_UINT256],
    [MAX_UINT256, MAX_UINT256],
    [(1n << 128n) - 1n, (1n << 128n) - 1n],
    [1n << 128n, 1n << 128n],
  ];
  for (const [index, [in1, in2]] of boundaryCases.entries()) {
    await assertMul(witnessCalculator, in1, in2, `MUL boundary case ${index}`);
  }
  for (let index = 0; index < RANDOM_CASES; index++) {
    await assertMul(
      witnessCalculator,
      randomWord(),
      randomWord(),
      `MUL randomized case ${index}`,
    );
  }

  await assert.rejects(
    witnessCalculator.calculateWitness({
      in: [1n << 2n, 1n << 128n, 0n, 1n, 0n],
    }, true),
  );
  await assertAlu1(
    witnessCalculator,
    1n << 20n,
    MAX_UINT256,
    MAX_UINT256,
    1n,
    "EQ shared input decomposition",
  );
  await assertAlu1(
    witnessCalculator,
    1n << 21n,
    0n,
    MAX_UINT256,
    1n,
    "ISZERO shared input decomposition",
  );
  await assertAlu1(
    witnessCalculator,
    1n << 25n,
    0n,
    MAX_UINT256,
    MAX_UINT256,
    "NOT shared input decomposition",
  );
  console.log(
    `ALU1 MUL passed ${boundaryCases.length} boundary cases, ${RANDOM_CASES} randomized cases, input canonicality rejection, and unchanged ALU1 operation checks`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
