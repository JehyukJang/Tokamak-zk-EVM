const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;

const split = (value) => [value & LIMB_MASK, value >> 128n];
const normalize = (value) => BigInt(value.toString());
const normalizeField = (value) => value % FIELD_PRIME;
const stripAnsi = (value) => value.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g,
  "",
);

const compileAndMeasure = (packageRoot, outputRoot, name) => {
  const outputDirectory = path.join(outputRoot, name);
  mkdirSync(outputDirectory);
  const source = path.join(
    packageRoot,
    `subcircuits/test/circom/transaction_signature_native_evm_word_${name}_test.circom`,
  );
  const result = spawnSync("circom", [
    source,
    "--r1cs",
    "--inspect",
    "--O1",
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

  const readCount = (label) => {
    const count = Number(output.match(new RegExp(`^${label}: (\\d+)`, "m"))?.[1]);
    assert.equal(Number.isInteger(count), true, `${label} is missing:\n${output}`);
    return count;
  };

  return {
    nonlinear: readCount("non-linear constraints"),
    linear: readCount("linear constraints"),
  };
};

const assertMutatedSignalRejected = async (circuit, witness, signalName) => {
  await circuit.loadSymbols();
  const signalIndex = circuit.symbols[signalName]?.varIdx;
  assert.notEqual(signalIndex, undefined, `${signalName} must exist in the witness`);
  const mutated = [...witness];
  mutated[signalIndex] = (normalize(mutated[signalIndex]) + 1n) % FIELD_PRIME;
  await assert.rejects(circuit.checkConstraints(mutated), /Constraint doesn't match/);
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-native-word-partition-"));

  try {
    const merge = compileAndMeasure(packageRoot, outputRoot, "merge_candidate");
    const lowCheck = compileAndMeasure(packageRoot, outputRoot, "low_check_candidate");
    const highCheck = compileAndMeasure(packageRoot, outputRoot, "high_check_candidate");
    const fieldBound = compileAndMeasure(packageRoot, outputRoot, "field_bound_candidate");
    const partition = compileAndMeasure(packageRoot, outputRoot, "partition_candidate");

    assert.deepEqual(merge, { nonlinear: 0, linear: 1 });
    assert.deepEqual(lowCheck, { nonlinear: 128, linear: 1 });
    assert.deepEqual(highCheck, { nonlinear: 127, linear: 1 });
    assert.deepEqual(fieldBound, { nonlinear: 256, linear: 4 });
    assert.equal(
      merge.nonlinear
        + lowCheck.nonlinear
        + highCheck.nonlinear
        + fieldBound.nonlinear,
      partition.nonlinear,
    );
    assert.equal(
      merge.linear + lowCheck.linear + highCheck.linear + fieldBound.linear,
      partition.linear,
    );
    assert.deepEqual(partition, { nonlinear: 511, linear: 7 });

    const [mergeCircuit, partitionCircuit] = await Promise.all([
      wasm(
        path.join(
          packageRoot,
          "subcircuits/test/circom/transaction_signature_native_evm_word_merge_candidate_test.circom",
        ),
        { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 1 },
      ),
      wasm(
        path.join(
          packageRoot,
          "subcircuits/test/circom/transaction_signature_native_evm_word_partition_candidate_test.circom",
        ),
        { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 1 },
      ),
    ]);

    let mutationWitness;
    for (const value of [0n, 1n, LIMB_BASE - 1n, LIMB_BASE, FIELD_PRIME - 1n]) {
      const expected = split(value);
      const mergeWitness = await mergeCircuit.calculateWitness(
        { in: value },
        true,
      );
      const partitionWitness = await partitionCircuit.calculateWitness({ in: value }, true);
      await mergeCircuit.assertOut(mergeWitness, { limbs: expected });
      await partitionCircuit.assertOut(partitionWitness, { limbs: expected });
      mutationWitness ??= partitionWitness;
    }

    for (const alias of [FIELD_PRIME, FIELD_PRIME + 1n, (1n << 255n) - 1n]) {
      const expected = split(normalizeField(alias));
      const mergeWitness = await mergeCircuit.calculateWitness(
        { in: alias },
        true,
      );
      const partitionWitness = await partitionCircuit.calculateWitness({ in: alias }, true);
      await mergeCircuit.assertOut(mergeWitness, { limbs: expected });
      await partitionCircuit.assertOut(partitionWitness, { limbs: expected });
    }

    await mergeCircuit.loadSymbols();
    await partitionCircuit.loadSymbols();
    const mergeAlias = await mergeCircuit.calculateWitness({ in: 0n }, true);
    const partitionAlias = await partitionCircuit.calculateWitness({ in: 0n }, true);
    const fieldAliasLimbs = split(FIELD_PRIME);
    for (let limb = 0; limb < 2; limb++) {
      mergeAlias[
        mergeCircuit.symbols[`main.limbs[${limb}]`].varIdx
      ] = fieldAliasLimbs[limb];
      partitionAlias[
        partitionCircuit.symbols[`main.limbs[${limb}]`].varIdx
      ] = fieldAliasLimbs[limb];
    }
    await mergeCircuit.checkConstraints(mergeAlias);
    await assert.rejects(
      partitionCircuit.checkConstraints(partitionAlias),
      /Constraint doesn't match/,
      "the paired field-bound fragment must reject the x + Fr decomposition",
    );

    await assertMutatedSignalRejected(
      partitionCircuit,
      mutationWitness,
      "main.limbs[0]",
    );
    await assertMutatedSignalRejected(
      partitionCircuit,
      mutationWitness,
      "main.limbs[1]",
    );

    console.log(
      `Native EVM-word partition preserves the ${partition.nonlinear + partition.linear}-constraint relation`,
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
