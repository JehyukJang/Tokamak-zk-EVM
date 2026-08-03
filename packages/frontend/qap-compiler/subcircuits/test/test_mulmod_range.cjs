const assert = require("node:assert/strict");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const builder = require("./wasm/witness_calculator.js");
const { split256BitInteger } = require("./helper_functions.js");

const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR
  ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;

const loadMulmod = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const mulmodInfo = subcircuitInfo.find((entry) => entry.name === "MULMOD");
  if (mulmodInfo === undefined) {
    throw new Error("MULMOD subcircuit was not found in subcircuitInfo.json");
  }
  return builder(readFileSync(path.join(libraryDir, `wasm/subcircuit${mulmodInfo.id}.wasm`)));
};

const encodeInput = (in1, in2, modulus) => [
  1n << 9n,
  ...split256BitInteger(in1),
  ...split256BitInteger(in2),
  ...split256BitInteger(modulus),
];

const main = async () => {
  const witnessCalculator = await loadMulmod();
  const cases = [
    { in1: 5n, in2: 7n, modulus: 10n, expected: 5n },
    {
      in1: MAX_UINT256,
      in2: MAX_UINT256,
      modulus: 97n,
      expected: MAX_UINT256 * MAX_UINT256 % 97n,
    },
    { in1: 0n, in2: MAX_UINT256, modulus: 97n, expected: 0n },
    { in1: MAX_UINT256, in2: MAX_UINT256, modulus: 0n, expected: 0n },
  ];

  for (const testCase of cases) {
    const witness = await witnessCalculator.calculateWitness({
      in: encodeInput(testCase.in1, testCase.in2, testCase.modulus),
    }, true);
    const [expectedLow, expectedHigh] = split256BitInteger(testCase.expected);
    assert.equal(BigInt(witness[1].toString()), expectedLow);
    assert.equal(BigInt(witness[2].toString()), expectedHigh);
  }
  console.log(`MULMOD passed ${cases.length} zero and nonzero modulus cases`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
