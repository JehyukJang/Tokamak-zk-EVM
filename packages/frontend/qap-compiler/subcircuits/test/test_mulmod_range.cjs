const assert = require("node:assert/strict");
const path = require("node:path");
const { readFileSync } = require("node:fs");

const builder = require("./wasm/witness_calculator.js");
const { split256BitInteger } = require("./helper_functions.js");

const libraryDir = process.env.QAP_SUBCIRCUIT_LIBRARY_DIR
  ?? path.join(__dirname, "../library");
const MAX_UINT256 = (1n << 256n) - 1n;

const loadMulmodComposition = async () => {
  const subcircuitInfo = JSON.parse(
    readFileSync(path.join(libraryDir, "subcircuitInfo.json"), "utf8"),
  );
  const calculators = {};
  for (const name of ["MULMODPrepare", "MULMODCandidate", "MULMODVerify"]) {
    const info = subcircuitInfo.find((entry) => entry.name === name);
    if (info === undefined) {
      throw new Error(`${name} subcircuit was not found in subcircuitInfo.json`);
    }
    calculators[name] = await builder(
      readFileSync(path.join(libraryDir, `wasm/subcircuit${info.id}.wasm`)),
    );
  }
  return calculators;
};

const encodeInput = (in1, in2, modulus) => [
  ...split256BitInteger(in1),
  ...split256BitInteger(in2),
  ...split256BitInteger(modulus),
];

const main = async () => {
  const calculators = await loadMulmodComposition();
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
    const prepareWitness = await calculators.MULMODPrepare.calculateWitness({
      in: encodeInput(testCase.in1, testCase.in2, testCase.modulus),
    }, true);
    const prepareOutputs = prepareWitness.slice(1, 19).map(value => BigInt(value.toString()));
    const candidateWitness = await calculators.MULMODCandidate.calculateWitness({
      in: prepareOutputs.slice(12, 18),
    }, true);
    const candidateOutputs = candidateWitness.slice(1, 13).map(value => BigInt(value.toString()));
    const verifyWitness = await calculators.MULMODVerify.calculateWitness({
      in: [...prepareOutputs.slice(0, 12), ...candidateOutputs],
    }, true);
    const [expectedLow, expectedHigh] = split256BitInteger(testCase.expected);
    assert.equal(BigInt(verifyWitness[1].toString()), expectedLow);
    assert.equal(BigInt(verifyWitness[2].toString()), expectedHigh);
  }
  console.log(`MULMOD passed ${cases.length} zero and nonzero modulus cases`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
