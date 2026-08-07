const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SCALAR_BITS = 16;
const MAX_SCALAR = (1n << BigInt(SCALAR_BITS)) - 1n;

const normalize = (value) => BigInt(value.toString());

const calculate = (circuit, base, scalar) => {
  const identity = jubjub.Point.ZERO.toAffine();
  const baseAffine = base.toAffine();
  return circuit.calculateWitness({
    identity: [identity.x, identity.y],
    base: [baseAffine.x, baseAffine.y],
    scalar,
  }, true);
};

const assertScalarMultiplication = async (circuit, base, scalar, label) => {
  const expected = (
    scalar === 0n ? jubjub.Point.ZERO : base.multiply(scalar)
  ).toAffine();
  const witness = await calculate(circuit, base, scalar);
  const resultX = normalize(witness[1]);
  const resultY = normalize(witness[2]);
  assert.equal(resultX, expected.x, `${label} result.x`);
  assert.equal(resultY, expected.y, `${label} result.y`);
  return witness;
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(
      packageRoot,
      "subcircuits/test/circom/transaction_signature_scalar_multiplication_test.circom",
    ),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );

  const bases = [
    [jubjub.Point.BASE, "fixed base"],
    [jubjub.Point.BASE.multiply(7n).multiply(8n), "validated variable base A8"],
  ];
  const scalars = [0n, 1n, 2n, 3n, 255n, 256n, 1n << 15n, MAX_SCALAR];
  for (const [base, baseLabel] of bases) {
    for (const scalar of scalars) {
      await assertScalarMultiplication(
        circuit,
        base,
        scalar,
        `${baseLabel} scalar ${scalar}`,
      );
    }
  }

  await assert.rejects(
    calculate(circuit, jubjub.Point.BASE, 1n << BigInt(SCALAR_BITS)),
    undefined,
    "a scalar outside the upstream bit decomposition must be rejected",
  );

  const witness = await assertScalarMultiplication(
    circuit,
    jubjub.Point.BASE.multiply(7n).multiply(8n),
    0xa55an,
    "mutation baseline",
  );
  await circuit.loadSymbols();

  const resultXIndex = circuit.symbols["main.result[0]"]?.varIdx;
  assert.notEqual(resultXIndex, undefined, "result.x must exist in the witness");
  const wrongResult = [...witness];
  wrongResult[resultXIndex] = (
    normalize(wrongResult[resultXIndex]) + 1n
  ) % FIELD_PRIME;
  await assert.rejects(
    circuit.checkConstraints(wrongResult),
    /Constraint doesn't match/,
    "a mutated scalar-multiplication result must be rejected",
  );

  const accumulatorIndex = circuit.symbols[
    "main.core.accumulators[8][0]"
  ]?.varIdx;
  assert.notEqual(accumulatorIndex, undefined, "the middle accumulator must exist");
  const wrongAccumulator = [...witness];
  wrongAccumulator[accumulatorIndex] = (
    normalize(wrongAccumulator[accumulatorIndex]) + 1n
  ) % FIELD_PRIME;
  await assert.rejects(
    circuit.checkConstraints(wrongAccumulator),
    /Constraint doesn't match/,
    "a mutated middle accumulator must be rejected",
  );

  const powerIndex = circuit.symbols["main.core.powers[8][1]"]?.varIdx;
  assert.notEqual(powerIndex, undefined, "the middle base power must exist");
  const wrongPower = [...witness];
  wrongPower[powerIndex] = (normalize(wrongPower[powerIndex]) + 1n) % FIELD_PRIME;
  await assert.rejects(
    circuit.checkConstraints(wrongPower),
    /Constraint doesn't match/,
    "a mutated middle base power must be rejected",
  );

  const finalDoublingPrefix = `main.core.doublings[${SCALAR_BITS - 1}]`;
  assert.equal(
    Object.keys(circuit.symbols).some(
      (name) => name.startsWith(finalDoublingPrefix),
    ),
    false,
    "the unused final base doubling must not exist",
  );

  console.log(
    "Transaction signature scalar core passed fixed-base, variable-base, bit-boundary, mutation, and final-doubling tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
