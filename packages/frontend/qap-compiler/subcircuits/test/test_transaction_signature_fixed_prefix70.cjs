const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SCALAR_LIMIT = 1n << 252n;

const stripAnsi = (value) => value.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g,
  "",
);

const compileAndMeasure = (packageRoot, outputRoot) => {
  const target = "TransactionSignatureFixedPrefix70";
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

const expectedRemainingBits = (value) => Array.from(
  { length: 42 },
  (_, index) => (value >> BigInt(210 + index)) & 1n,
);

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-tsv-fixed-prefix70-"));
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
      { nonlinear: 1016, linear: 0, inputs: 1, outputs: 46, wires: 1017 },
    );
    assert.equal(measurement.nonzero, 6894);

    const circuit = await wasm(
      path.join(packageRoot, "subcircuits/circom/TransactionSignatureFixedPrefix70_circuit.circom"),
      { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 2 },
    );
    let mutationWitness;
    for (const value of [
      0n,
      1n,
      (1n << 210n) - 1n,
      1n << 210n,
      SCALAR_LIMIT - 1n,
    ]) {
      const witness = await circuit.calculateWitness({ in: [value] }, true);
      assert.deepEqual(
        witness.slice(1, 43).map(normalize),
        expectedRemainingBits(value),
      );
      mutationWitness ??= value === SCALAR_LIMIT - 1n ? witness : undefined;
    }
    await assert.rejects(circuit.calculateWitness({ in: [SCALAR_LIMIT] }, true));

    await circuit.loadSymbols();
    for (const signalName of [
      "main.out[0]",
      "main.out[41]",
      "main.out[42]",
      "main.fixedPrefix.accumulators[35][0]",
    ]) {
      await assertMutatedSignalRejected(circuit, mutationWitness, signalName);
    }

    console.log("TransactionSignatureFixedPrefix70 passed O2, scalar-boundary, and mutation checks");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
