const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");
const { poseidon2 } = require("poseidon-bls12381");
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
  const target = "TransactionSignatureFinal";
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

const calculateWitness = async (circuit, input) => (
  (await circuit.calculateWitness({ in: input }, true)).map(normalize)
);

const assertMutatedSignalRejected = async (circuit, witness, signalName) => {
  const signalIndex = circuit.symbols[signalName]?.varIdx;
  assert.notEqual(signalIndex, undefined, `${signalName} must exist`);
  assert.notEqual(signalIndex, -1, `${signalName} must own a witness wire`);
  const mutated = [...witness];
  mutated[signalIndex] = (mutated[signalIndex] + 1n) % FIELD_PRIME;
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

const loadCircuit = (packageRoot, name) => wasm(
  path.join(packageRoot, `subcircuits/circom/${name}_circuit.circom`),
  { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 2 },
);

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-tsv-final-"));
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
      { nonlinear: 946, linear: 0, inputs: 81, outputs: 2, wires: 1023 },
    );

    const [pointPolicy, fixedPrefix, challengePrefix, variableBatch, finalCircuit] = await Promise.all([
      loadCircuit(packageRoot, "TransactionSignaturePointPolicy"),
      loadCircuit(packageRoot, "TransactionSignatureFixedPrefix70"),
      loadCircuit(packageRoot, "TransactionSignatureChallengeVariablePrefix"),
      loadCircuit(packageRoot, "TransactionSignatureVariableBatch"),
      loadCircuit(packageRoot, "TransactionSignatureFinal"),
    ]);
    const vector = createTransactionSignatureCorpus()[0];
    const challengeInputs = getChallengeInputs(vector);
    const challenge = evaluateCompleteStatement(vector).circuit.challenge;
    const pointWitness = await calculateWitness(pointPolicy, toPointPolicyInput(vector));
    const runtimeTable = pointWitness.slice(5, 13);
    const randomizerCofactor = pointWitness.slice(13, 17);
    const fixedWitness = await calculateWitness(fixedPrefix, [vector.publicBoundary.S]);
    const fixedBits = fixedWitness.slice(1, 43);
    const fixedAccumulator = fixedWitness.slice(43, 47);
    const challengeWitness = await calculateWitness(
      challengePrefix,
      [challenge, ...runtimeTable],
    );
    const challengeBits = challengeWitness.slice(1, 223);
    let variableAccumulator = challengeWitness.slice(223, 227);
    for (const start of [154, 86, 18]) {
      const batchWitness = await calculateWitness(variableBatch, [
        ...challengeBits.slice(start, start + 68),
        ...runtimeTable,
        ...variableAccumulator,
      ]);
      variableAccumulator = batchWitness.slice(1, 5);
    }
    const publicKeyHash = poseidon2(challengeInputs.slice(2, 4));
    const finalInput = [
      ...fixedBits,
      ...fixedAccumulator,
      ...challengeBits.slice(0, 18),
      ...variableAccumulator,
      ...runtimeTable,
      ...randomizerCofactor,
      publicKeyHash,
    ];
    assert.equal(finalInput.length, 81);
    const witness = await calculateWitness(finalCircuit, finalInput);
    const origin = evaluateCompleteStatement(vector).circuit.origin;
    assert.deepEqual(witness.slice(1, 3), [
      origin & ((1n << 128n) - 1n),
      origin >> 128n,
    ]);

    const invalidInput = [...finalInput];
    invalidInput[0] ^= 1n;
    await assert.rejects(finalCircuit.calculateWitness({ in: invalidInput }, true));

    await finalCircuit.loadSymbols();
    for (const signalName of [
      "main.out[0]",
      "main.out[1]",
      "main.publicKeyHash.fieldBound.lowBorrow",
      "main.fixedTail.accumulators[7][0]",
      "main.variableTail.accumulators[4][0]",
    ]) {
      await assertMutatedSignalRejected(finalCircuit, witness, signalName);
    }

    console.log(
      `TransactionSignatureFinal passed O2 repartition, composition, and mutation checks (${measurement.nonzero} nonzero entries)`,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
