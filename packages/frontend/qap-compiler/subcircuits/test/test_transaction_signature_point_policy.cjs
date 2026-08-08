const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");
const {
  createTransactionSignatureCorpus,
  getChallengeInputs,
} = require("./transaction_signature_verify_oracle.cjs");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

const stripAnsi = (value) => value.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g,
  "",
);

const compileAndMeasure = (packageRoot, outputRoot) => {
  const target = "TransactionSignaturePointPolicy";
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

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-tsv-point-policy-"));
  try {
    assert.deepEqual(compileAndMeasure(packageRoot, outputRoot), {
      nonlinear: 238,
      linear: 5,
      inputs: 8,
      outputs: 16,
      wires: 249,
      nonzero: 1126,
    });

    const pointPolicy = await wasm(
      path.join(packageRoot, "subcircuits/circom/TransactionSignaturePointPolicy_circuit.circom"),
      { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 2 },
    );
    const oldPolicy = await wasm(
      path.join(packageRoot, "subcircuits/circom/TransactionSignaturePolicyFixedPrefix_circuit.circom"),
      { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 2 },
    );
    const vector = createTransactionSignatureCorpus()[0];
    const challengeInputs = getChallengeInputs(vector);
    const common = [
      ...challengeInputs.slice(0, 4),
      vector.publicBoundary.contractAddress,
      vector.publicBoundary.functionSelector,
    ];
    const witness = await pointPolicy.calculateWitness({
      in: [...common, ...vector.publicBoundary.O],
    }, true);
    const oldWitness = await oldPolicy.calculateWitness({
      in: [...common, vector.publicBoundary.S, ...vector.publicBoundary.O],
    }, true);
    assert.deepEqual(
      witness.slice(1, 17).map(normalize),
      [
        ...oldWitness.slice(1, 5),
        ...oldWitness.slice(150, 162),
      ].map(normalize),
    );

    await assert.rejects(pointPolicy.calculateWitness({
      in: [common[0], common[1], 0n, 0n, ...common.slice(4), ...vector.publicBoundary.O],
    }, true));
    await pointPolicy.loadSymbols();
    for (const signalName of [
      "main.out[0]",
      "main.out[4]",
      "main.out[12]",
      "main.publicKeyAffine.point[0]",
    ]) {
      await assertMutatedSignalRejected(pointPolicy, witness, signalName);
    }

    console.log("TransactionSignaturePointPolicy passed O2, equivalence, policy, and mutation checks");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
