const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");
const { poseidon2 } = require("poseidon-bls12381");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SOURCE_NAME = "transaction_signature_poseidon_batch3_candidate_test";

const normalize = (value) => BigInt(value.toString());
const stripAnsi = (value) => value.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g,
  "",
);

const compileAndMeasure = (packageRoot, outputRoot) => {
  const outputDirectory = path.join(outputRoot, "poseidon-batch3");
  mkdirSync(outputDirectory);
  const source = path.join(
    packageRoot,
    `subcircuits/test/circom/${SOURCE_NAME}.circom`,
  );
  const result = spawnSync("circom", [
    source,
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
  ], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`);

  assert.equal(result.status, 0, output);
  assert.equal(
    output.match(/warning\[CA02\]/g)?.length,
    1,
    output,
  );
  assert.match(
    output,
    /m\[63\]\.out contains a total of 2 signals that do not appear in any constraint/,
  );

  const readCount = (label) => {
    const count = Number(output.match(new RegExp(`^${label}: (\\d+)`, "m"))?.[1]);
    assert.equal(Number.isInteger(count), true, `${label} is missing:\n${output}`);
    return count;
  };

  const constraints = JSON.parse(readFileSync(
    path.join(outputDirectory, `${SOURCE_NAME}_constraints.json`),
    "utf8",
  )).constraints;
  const nonzeroCoefficients = constraints.reduce(
    (total, row) => total + row.reduce(
      (rowTotal, expression) => rowTotal + Object.keys(expression).length,
      0,
    ),
    0,
  );

  return {
    nonlinear: readCount("non-linear constraints"),
    linear: readCount("linear constraints"),
    publicInputs: readCount("public inputs"),
    privateInputs: readCount("private inputs"),
    publicOutputs: readCount("public outputs"),
    wires: readCount("wires"),
    nonzeroCoefficients,
    symbols: readFileSync(
      path.join(outputDirectory, `${SOURCE_NAME}.sym`),
      "utf8",
    ),
  };
};

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
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-poseidon-batch3-"));

  try {
    const measurement = compileAndMeasure(packageRoot, outputRoot);
    assert.deepEqual(
      {
        nonlinear: measurement.nonlinear,
        linear: measurement.linear,
        wires: measurement.wires,
        nonzeroCoefficients: measurement.nonzeroCoefficients,
      },
      {
        nonlinear: 713,
        linear: 0,
        wires: 719,
        nonzeroCoefficients: 8537,
      },
    );
    assert.deepEqual(
      {
        publicInputs: measurement.publicInputs,
        privateInputs: measurement.privateInputs,
        publicOutputs: measurement.publicOutputs,
      },
      { publicInputs: 6, privateInputs: 0, publicOutputs: 2 },
    );
    const wireIndex = (signal) => Number(measurement.symbols.match(
      new RegExp(`^\\d+,(\\d+),\\d+,${signal.replace(/[\[\]]/g, "\\$&")}$`, "m"),
    )?.[1]);
    assert.deepEqual(
      [
        "main.out[0]",
        "main.out[1]",
        "main.in[0]",
        "main.in[1]",
        "main.in[2]",
        "main.in[3]",
        "main.in[4]",
        "main.in[5]",
      ].map(wireIndex),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );

    const circuit = await wasm(
      path.join(
        packageRoot,
        `subcircuits/test/circom/${SOURCE_NAME}.circom`,
      ),
      {
        include: path.join(packageRoot, "node_modules"),
        prime: "bls12381",
        O: 2,
      },
    );

    let chainMutationWitness;
    let independentMutationWitness;
    for (let index = 0n; index < 16n; index++) {
      const values = [
        index * 17n + 1n,
        index * 31n + 2n,
        index * 47n + 3n,
        index * 61n + 4n,
        index * 73n + 5n,
      ].map((value) => value % FIELD_PRIME);

      const chainFirst = poseidon2([values[0], values[1]]);
      const chainSecond = poseidon2([chainFirst, values[3]]);
      const chainWitness = await circuit.calculateWitness({
        in: [1n, values[0], values[1], values[2], values[3], values[4]],
      }, true);
      await circuit.assertOut(chainWitness, {
        out: [chainFirst, poseidon2([chainSecond, values[4]])],
      });
      chainMutationWitness ??= chainWitness;

      const independentFirst = poseidon2([values[0], values[1]]);
      const independentSecond = poseidon2([values[2], values[3]]);
      const independentWitness = await circuit.calculateWitness({
        in: [0n, values[0], values[1], values[2], values[3], values[4]],
      }, true);
      await circuit.assertOut(independentWitness, {
        out: [independentFirst, poseidon2([independentSecond, values[4]])],
      });
      independentMutationWitness ??= independentWitness;
    }

    for (const invalidMode of [2n, FIELD_PRIME - 1n]) {
      await assert.rejects(circuit.calculateWitness({
        in: [invalidMode, 1n, 2n, 3n, 4n, 5n],
      }, true));
    }

    await circuit.loadSymbols();
    for (const signalName of [
      "main.firstHash.x5F[0][1].in2",
      "main.secondHash.x5P[0].in4",
      "main.thirdHash.x5F[1][2].in4",
      "main.secondLeft",
      "main.out[0]",
      "main.out[1]",
    ]) {
      await assertMutatedSignalRejected(circuit, chainMutationWitness, signalName);
      await assertMutatedSignalRejected(circuit, independentMutationWitness, signalName);
    }

    console.log(
      "Three-Poseidon batch passed O2 interface, mode, oracle, and mutation checks",
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
