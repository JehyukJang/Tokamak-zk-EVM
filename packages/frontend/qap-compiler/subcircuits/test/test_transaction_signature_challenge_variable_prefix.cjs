const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");
const {
  createTransactionSignatureCorpus,
  evaluateCompleteStatement,
  getChallengeInputs,
} = require("./transaction_signature_verify_oracle.cjs");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

const stripAnsi = (value) => value.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g,
  "",
);

const compileAndMeasure = (packageRoot, outputRoot) => {
  const target = "TransactionSignatureChallengeVariablePrefix";
  const outputDirectory = path.join(outputRoot, target);
  mkdirSync(outputDirectory);
  const result = spawnSync("circom", [
    path.join(packageRoot, `subcircuits/circom/${target}_circuit.circom`),
    "--r1cs",
    "--json",
    "--sym",
    "--inspect",
    "--O2",
    "--prime",
    "bls12381",
    "-l",
    path.join(packageRoot, "node_modules"),
    "-o",
    outputDirectory,
  ], { cwd: packageRoot, encoding: "utf8" });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  assert.equal(result.status, 0, output);
  const readCount = (label) => Number(
    output.match(new RegExp(`^${label}: (\\d+)`, "m"))?.[1],
  );
  const constraints = JSON.parse(readFileSync(
    path.join(outputDirectory, `${target}_circuit_constraints.json`),
    "utf8",
  )).constraints;
  return {
    nonlinear: readCount("non-linear constraints"),
    linear: readCount("linear constraints"),
    inputs: readCount("public inputs"),
    outputs: readCount("public outputs"),
    wires: readCount("wires"),
    nonzero: constraints.reduce(
      (total, row) => total + row.reduce(
        (rowTotal, expression) => rowTotal + Object.keys(expression).length,
        0,
      ),
      0,
    ),
  };
};

const normalize = (value) => BigInt(value.toString());

const assertMutatedSignalRejected = async (circuit, witness, signalName) => {
  const signalIndex = circuit.symbols[signalName]?.varIdx;
  assert.notEqual(signalIndex, undefined, `${signalName} must exist`);
  assert.notEqual(signalIndex, -1, `${signalName} must own a witness wire`);
  const mutated = [...witness];
  mutated[signalIndex] = (normalize(mutated[signalIndex]) + 1n) % FIELD_PRIME;
  await assert.rejects(circuit.checkConstraints(mutated), /Constraint doesn't match/);
};

const toPointPolicyInput = (vector) => {
  const challengeInputs = getChallengeInputs(vector);
  return [
    ...challengeInputs.slice(0, 4),
    vector.publicBoundary.contractAddress,
    vector.publicBoundary.functionSelector,
    ...vector.publicBoundary.O,
  ];
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-tsv-challenge-prefix-"));
  try {
    const measurement = compileAndMeasure(packageRoot, outputRoot);
    assert.deepEqual(
      {
        nonlinear: measurement.nonlinear,
        linear: measurement.linear,
        inputs: measurement.inputs,
        outputs: measurement.outputs,
        wires: measurement.wires,
      },
      { nonlinear: 982, linear: 0, inputs: 9, outputs: 226, wires: 989 },
    );
    assert.equal(measurement.nonzero, 6258);

    const prefix = await wasm(
      path.join(packageRoot, "subcircuits/circom/TransactionSignatureChallengeVariablePrefix_circuit.circom"),
      { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 2 },
    );
    const pointPolicy = await wasm(
      path.join(packageRoot, "subcircuits/circom/TransactionSignaturePointPolicy_circuit.circom"),
      { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 2 },
    );
    const vector = createTransactionSignatureCorpus()[0];
    const pointWitness = await pointPolicy.calculateWitness({
      in: toPointPolicyInput(vector),
    }, true);
    const runtimeTable = pointWitness.slice(5, 13).map(normalize);
    const challenge = evaluateCompleteStatement(vector).circuit.challenge;
    const witness = await prefix.calculateWitness({
      in: [challenge, ...runtimeTable],
    }, true);
    assert.deepEqual(
      witness.slice(1, 223).map(normalize),
      Array.from({ length: 222 }, (_, bit) => (
        challenge >> BigInt(bit)
      ) & 1n),
    );

    await prefix.loadSymbols();
    for (const signalName of [
      "main.out[0]",
      "main.out[221]",
      "main.out[222]",
      "main.challenge.fieldBound.lowBorrow",
      "main.variableStart.accumulators[8][0]",
    ]) {
      await assertMutatedSignalRejected(prefix, witness, signalName);
    }

    console.log("TransactionSignatureChallengeVariablePrefix passed O2, canonical-bit, and mutation checks");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
