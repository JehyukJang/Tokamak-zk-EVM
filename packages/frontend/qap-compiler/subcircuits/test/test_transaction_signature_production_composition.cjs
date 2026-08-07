const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { FUNCTION_INPUT_LENGTH } = require("tokamak-l2js");
const {
  DISPOSITIONS,
  createTransactionSignatureCorpus,
  evaluateCompleteStatement,
  getChallengeInputs,
} = require("./transaction_signature_verify_oracle.cjs");

const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;

const split = (value) => [value & LIMB_MASK, value >> 128n];

const toCircuitInput = (vector) => {
  const challengeInputs = getChallengeInputs(vector);
  return {
    privateIn: [
      ...challengeInputs.slice(0, 5),
      ...challengeInputs.slice(7),
    ],
    contractAddress: vector.publicBoundary.contractAddress,
    functionSelector: vector.publicBoundary.functionSelector,
    S: vector.publicBoundary.S,
    O: vector.publicBoundary.O,
  };
};

const expectedOutput = (vector, oracle) => ({
  evmContractAddress: split(vector.publicBoundary.contractAddress),
  evmFunctionSelector: [vector.publicBoundary.functionSelector, 0n],
  evmTransactionInputs: vector.messageWords.slice(3).map(split),
  origin: split(oracle.circuit.origin),
});

const main = async () => {
  assert.equal(FUNCTION_INPUT_LENGTH, 29);
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(
      packageRoot,
      "subcircuits/test/circom/transaction_signature_production_composition_test.circom",
    ),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );

  const corpus = createTransactionSignatureCorpus();
  let accepted = 0;
  let rejected = 0;
  for (const vector of corpus) {
    const oracle = evaluateCompleteStatement(vector);
    const input = toCircuitInput(vector);
    if (vector.disposition === DISPOSITIONS.CIRCUIT_LOCAL_REJECTION) {
      await assert.rejects(circuit.calculateWitness(input, true), undefined, vector.id);
      rejected++;
      continue;
    }

    const witness = await circuit.calculateWitness(input, true);
    await circuit.checkConstraints(witness);
    await circuit.assertOut(witness, expectedOutput(vector, oracle));
    accepted++;
  }

  console.log(`transaction signature production composition: ${accepted} accepted, ${rejected} rejected`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
