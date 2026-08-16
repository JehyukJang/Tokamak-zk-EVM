const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const builder = require("../library/witness_calculator.js");
const { split256BitInteger } = require("./helper_functions.js");

const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR
  ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;
const RANDOM_CASES = 128;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);

const loadMul = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const mulInfo = subcircuitInfo.find((entry) => entry.name === "MUL");
  if (mulInfo === undefined) {
    throw new Error("MUL subcircuit was not found in subcircuitInfo.json");
  }
  return builder(readFileSync(path.join(libraryDir, `wasm/subcircuit${mulInfo.id}.wasm`)));
};

const assertMul = async (
  witnessCalculator,
  in1,
  in2,
  expected,
  label,
) => {
  const witness = await witnessCalculator.calculateWitness({
    in: [
      ...split256BitInteger(in1),
      ...split256BitInteger(in2),
    ],
  }, true);
  const [expectedLow, expectedHigh] = split256BitInteger(expected);
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${label} high limb`);
};

const main = async () => {
  const witnessCalculator = await loadMul();
  const boundaryCases = [
    [0n, MAX_UINT256],
    [1n, MAX_UINT256],
    [MAX_UINT256, MAX_UINT256],
    [(1n << 128n) - 1n, (1n << 128n) - 1n],
    [1n << 128n, 1n << 128n],
  ];
  for (const [index, [in1, in2]] of boundaryCases.entries()) {
    await assertMul(
      witnessCalculator,
      in1,
      in2,
      (in1 * in2) & MAX_UINT256,
      `MUL boundary case ${index}`,
    );
  }
  for (let index = 0; index < RANDOM_CASES; index++) {
    const in1 = randomWord();
    const in2 = randomWord();
    await assertMul(
      witnessCalculator,
      in1,
      in2,
      (in1 * in2) & MAX_UINT256,
      `MUL randomized case ${index}`,
    );
  }

  await assert.rejects(
    witnessCalculator.calculateWitness({
      in: [1n << 128n, 0n, 1n, 0n],
    }, true),
  );
  console.log(
    `MUL passed ${boundaryCases.length} boundary cases, ${RANDOM_CASES} randomized cases, and input canonicality rejection`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
