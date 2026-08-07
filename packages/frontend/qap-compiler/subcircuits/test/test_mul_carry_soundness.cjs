const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const LIMB_BASE = 1n << 128n;

const modularInverse = (value, modulus) => {
  let [oldRemainder, remainder] = [value, modulus];
  let [oldCoefficient, coefficient] = [1n, 0n];
  while (remainder !== 0n) {
    const quotient = oldRemainder / remainder;
    [oldRemainder, remainder] = [remainder, oldRemainder - quotient * remainder];
    [oldCoefficient, coefficient] = [coefficient, oldCoefficient - quotient * coefficient];
  }
  return (oldCoefficient + modulus) % modulus;
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(__dirname, "circom/mul_truncated_unsafe_test.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );
  const witness = await circuit.calculateWitness({
    in1: [0n, 0n, 0n, 0n],
    in2: [0n, 0n, 0n, 0n],
  }, true);
  await circuit.loadSymbols();

  const carryLowIndex = circuit.symbols["main.carryLow"]?.varIdx;
  const carryHighIndex = circuit.symbols["main.carryHigh"]?.varIdx;
  const outputLowIndex = circuit.symbols["main.out[0]"]?.varIdx;
  assert.notEqual(carryLowIndex, undefined);
  assert.notEqual(carryHighIndex, undefined);
  assert.notEqual(outputLowIndex, undefined);

  const inverseBase = modularInverse(LIMB_BASE, FIELD_PRIME);
  const maliciousCarryLow = (FIELD_PRIME - inverseBase) % FIELD_PRIME;
  const maliciousCarryHigh = maliciousCarryLow * inverseBase % FIELD_PRIME;
  assert.equal((1n + maliciousCarryLow * LIMB_BASE) % FIELD_PRIME, 0n);
  assert.equal(
    (maliciousCarryHigh * LIMB_BASE - maliciousCarryLow) % FIELD_PRIME,
    0n,
  );
  const maliciousWitness = [...witness];
  maliciousWitness[outputLowIndex] = 1n;
  maliciousWitness[carryLowIndex] = maliciousCarryLow;
  maliciousWitness[carryHighIndex] = maliciousCarryHigh;

  await assert.rejects(
    circuit.checkConstraints(maliciousWitness),
    /Constraint doesn't match/,
  );
  console.log("Mul256TruncatedFrom64_unsafe rejects out-of-range carry witnesses");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
