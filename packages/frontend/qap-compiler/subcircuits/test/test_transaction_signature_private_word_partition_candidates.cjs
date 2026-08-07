const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;
const MAX_255 = (1n << 255n) - 1n;

const split = (value) => [value & LIMB_MASK, value >> 128n];
const expectedWarningCounts = {
  limb_check: 2,
  bound_merge: 2,
  partition: 4,
};
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
    `subcircuits/test/circom/transaction_signature_private_word_${name}_candidate_test.circom`,
  );
  const result = spawnSync("circom", [
    source,
    "--r1cs",
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
    output.match(/warning\[CA0[12]\]/g)?.length,
    expectedWarningCounts[name],
    output,
  );
  const nonlinear = Number(output.match(/^non-linear constraints: (\d+)/m)?.[1]);
  const linear = Number(output.match(/^linear constraints: (\d+)/m)?.[1]);
  assert.equal(Number.isInteger(nonlinear), true, output);
  assert.equal(Number.isInteger(linear), true, output);
  return { nonlinear, linear, total: nonlinear + linear };
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(
    path.join(tmpdir(), "tokamak-private-word-partition-"),
  );

  try {
    const limbCheck = compileAndMeasure(packageRoot, outputRoot, "limb_check");
    const boundMerge = compileAndMeasure(packageRoot, outputRoot, "bound_merge");
    const partition = compileAndMeasure(packageRoot, outputRoot, "partition");

    assert.deepEqual(limbCheck, { nonlinear: 255, linear: 0, total: 255 });
    assert.deepEqual(boundMerge, { nonlinear: 256, linear: 0, total: 256 });
    assert.deepEqual(partition, { nonlinear: 511, linear: 0, total: 511 });
    assert.equal(limbCheck.total + boundMerge.total, partition.total);

    const circuit = await wasm(
      path.join(
        packageRoot,
        "subcircuits/test/circom/transaction_signature_private_word_partition_candidate_test.circom",
      ),
      {
        include: path.join(packageRoot, "node_modules"),
        prime: "bls12381",
        O: 2,
      },
    );

    for (const value of [
      0n,
      1n,
      LIMB_BASE - 1n,
      LIMB_BASE,
      FIELD_PRIME - 2n,
      FIELD_PRIME - 1n,
    ]) {
      const witness = await circuit.calculateWitness({ in: split(value) }, true);
      await circuit.assertOut(witness, { value });
    }

    for (const value of [FIELD_PRIME, FIELD_PRIME + 1n, MAX_255]) {
      await assert.rejects(circuit.calculateWitness({ in: split(value) }, true));
    }
    await assert.rejects(
      circuit.calculateWitness({ in: [LIMB_BASE, 0n] }, true),
    );
    await assert.rejects(
      circuit.calculateWitness({ in: [0n, 1n << 127n] }, true),
    );

    console.log(
      "Transaction signature private-word partition preserves the 511-constraint O2 relation",
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
