const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { wasm } = require("circom_tester");
const { poseidon2 } = require("poseidon-bls12381");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;
const MAX_255 = (1n << 255n) - 1n;
const EXPECTED_WARNING_COUNTS = {
  poseidon: 1,
  candidate: 3,
  composition: 5,
};

const split = (value) => [value & LIMB_MASK, value >> 128n];
const normalize = (value) => BigInt(value.toString());
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
    `subcircuits/test/circom/transaction_signature_poseidon_anchor_${name}_test.circom`,
  );
  const result = spawnSync("circom", [
    source,
    "--r1cs",
    "--sym",
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
  assert.equal(
    output.match(/warning\[CA0[12]\]/g)?.length,
    EXPECTED_WARNING_COUNTS[name],
    output,
  );
  const readCount = (label) => {
    const count = Number(output.match(new RegExp(`^${label}: (\\d+)`, "m"))?.[1]);
    assert.equal(Number.isInteger(count), true, `${label} is missing:\n${output}`);
    return count;
  };
  const sourceBase = path.basename(source, ".circom");
  const symbols = readFileSync(path.join(outputDirectory, `${sourceBase}.sym`), "utf8");

  return {
    nonlinear: readCount("non-linear constraints"),
    linear: readCount("linear constraints"),
    publicInputs: readCount("public inputs"),
    privateInputs: readCount("private inputs"),
    publicOutputs: readCount("public outputs"),
    symbols,
  };
};

const expectWitnessFailure = async (circuit, input) => {
  await assert.rejects(circuit.calculateWitness(input, true));
};

const assertMutatedSignalRejected = async (circuit, witness, signalName) => {
  const signalIndex = circuit.symbols[signalName]?.varIdx;
  assert.notEqual(signalIndex, undefined, `${signalName} must exist in the witness`);
  assert.notEqual(signalIndex, -1, `${signalName} must own a witness wire`);
  const mutated = [...witness];
  mutated[signalIndex] = (normalize(mutated[signalIndex]) + 1n) % FIELD_PRIME;
  await assert.rejects(circuit.checkConstraints(mutated), /Constraint doesn't match/);
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputRoot = mkdtempSync(path.join(tmpdir(), "tokamak-poseidon-anchor-"));

  try {
    const poseidon = compileAndMeasure(packageRoot, outputRoot, "poseidon");
    const anchor = compileAndMeasure(packageRoot, outputRoot, "candidate");
    const composition = compileAndMeasure(packageRoot, outputRoot, "composition");

    assert.deepEqual(
      { nonlinear: poseidon.nonlinear, linear: poseidon.linear },
      { nonlinear: 240, linear: 384 },
    );
    assert.deepEqual(
      { nonlinear: anchor.nonlinear, linear: anchor.linear },
      { nonlinear: 496, linear: 389 },
    );
    assert.deepEqual(
      { nonlinear: composition.nonlinear, linear: composition.linear },
      { nonlinear: 751, linear: 391 },
    );
    assert.equal(anchor.nonlinear + anchor.linear, 885);
    assert.equal(composition.nonlinear + composition.linear, 1142);
    assert.equal(composition.nonlinear + composition.linear, 257 + 885);

    assert.deepEqual(
      {
        publicInputs: anchor.publicInputs,
        privateInputs: anchor.privateInputs,
        publicOutputs: anchor.publicOutputs,
      },
      { publicInputs: 0, privateInputs: 3, publicOutputs: 1 },
    );
    for (const signal of [
      "main.previousHash",
      "main.word[0]",
      "main.word[1]",
      "main.nextHash",
    ]) {
      assert.match(anchor.symbols, new RegExp(`(?:^|,)${signal.replace(/[\[\]]/g, "\\$&")}$`, "m"));
    }

    const [anchorCircuit, compositionCircuit] = await Promise.all([
      wasm(
        path.join(
          packageRoot,
          "subcircuits/test/circom/transaction_signature_poseidon_anchor_candidate_test.circom",
        ),
        { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 1 },
      ),
      wasm(
        path.join(
          packageRoot,
          "subcircuits/test/circom/transaction_signature_poseidon_anchor_composition_test.circom",
        ),
        { include: path.join(packageRoot, "node_modules"), prime: "bls12381", O: 1 },
      ),
    ]);

    const vectors = [
      { previousHash: 0n, word: 0n },
      { previousHash: 1n, word: 1n },
      { previousHash: 17n, word: LIMB_BASE - 1n },
      { previousHash: FIELD_PRIME - 1n, word: FIELD_PRIME - 1n },
    ];
    let mutationWitness;
    for (const vector of vectors) {
      const input = { previousHash: vector.previousHash, word: split(vector.word) };
      const expected = poseidon2([vector.previousHash, vector.word]);
      const anchorWitness = await anchorCircuit.calculateWitness(input, true);
      const compositionWitness = await compositionCircuit.calculateWitness(input, true);
      await anchorCircuit.assertOut(anchorWitness, { nextHash: expected });
      await compositionCircuit.assertOut(compositionWitness, { nextHash: expected });
      mutationWitness ??= anchorWitness;
    }

    for (const value of [FIELD_PRIME, FIELD_PRIME + 1n, MAX_255]) {
      await expectWitnessFailure(compositionCircuit, { previousHash: 9n, word: split(value) });
    }
    const nonCanonicalLimbInput = {
      previousHash: 9n,
      word: [LIMB_BASE, 0n],
    };
    const anchorOnlyWitness = await anchorCircuit.calculateWitness(
      nonCanonicalLimbInput,
      true,
    );
    await anchorCircuit.assertOut(anchorOnlyWitness, {
      nextHash: poseidon2([nonCanonicalLimbInput.previousHash, LIMB_BASE]),
    });
    await expectWitnessFailure(compositionCircuit, {
      ...nonCanonicalLimbInput,
    });
    await expectWitnessFailure(compositionCircuit, {
      previousHash: 9n,
      word: [0n, 1n << 127n],
    });

    await anchorCircuit.loadSymbols();
    await assertMutatedSignalRejected(
      anchorCircuit,
      mutationWitness,
      "main.nextHash",
    );

    console.log(
      "Representative Poseidon anchor preserves the 1,142-constraint composed relation with a 3-input, 1-output, 885-constraint anchor",
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
