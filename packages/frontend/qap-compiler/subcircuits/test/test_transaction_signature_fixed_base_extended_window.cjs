const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SCALAR_ORDER = jubjub.Point.Fn.ORDER;
const MAX_SCALAR = (1n << 252n) - 1n;
const G8 = jubjub.Point.BASE.multiply(8n);

const normalize = (value) => BigInt(value.toString());

const assertMutatedSignalRejected = async (circuit, witness, signalName, label) => {
  const signalIndex = circuit.symbols[signalName]?.varIdx;
  assert.notEqual(signalIndex, undefined, `${label} must exist in the witness`);
  assert.notEqual(signalIndex, -1, `${label} must own a witness wire`);
  const mutated = [...witness];
  mutated[signalIndex] = (normalize(mutated[signalIndex]) + 1n) % FIELD_PRIME;
  await assert.rejects(
    circuit.checkConstraints(mutated),
    /Constraint doesn't match/,
    `a mutated ${label} must be rejected`,
  );
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(
      packageRoot,
      "subcircuits/test/circom/transaction_signature_fixed_base_window3_extended_test.circom",
    ),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 1,
    },
  );
  const scalars = [
    0n,
    1n,
    2n,
    3n,
    7n,
    8n,
    0xa55an,
    SCALAR_ORDER - 1n,
    SCALAR_ORDER,
    SCALAR_ORDER + 1n,
    1n << 251n,
    MAX_SCALAR,
  ];

  let mutationWitness;
  for (const scalar of scalars) {
    const witness = await circuit.calculateWitness({ scalar }, true);
    const reducedScalar = scalar % SCALAR_ORDER;
    const expected = (
      reducedScalar === 0n ? jubjub.Point.ZERO : G8.multiply(reducedScalar)
    ).toAffine();
    await circuit.assertOut(witness, { result: [expected.x, expected.y] });
    assert.equal(normalize(witness[1]), expected.x, `scalar ${scalar} result.x`);
    assert.equal(normalize(witness[2]), expected.y, `scalar ${scalar} result.y`);
    if (scalar === 0xa55an) {
      mutationWitness = witness;
    }
  }
  await assert.rejects(
    circuit.calculateWitness({ scalar: 1n << 252n }, true),
    undefined,
    "the extended candidate rejects a 253-bit scalar",
  );

  await circuit.loadSymbols();
  for (const [signalName, label] of [
    ["main.core.products[42][0]", "selector monomial"],
    ["main.core.selected[42][2]", "selected affine T"],
    ["main.core.additions[42].C", "mixed addition"],
    ["main.core.accumulators[42][0]", "extended accumulator"],
  ]) {
    await assertMutatedSignalRejected(circuit, mutationWitness, signalName, label);
  }

  console.log(
    "Extended fixed-base window passed scalar boundaries, table selection, and internal mutation tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
