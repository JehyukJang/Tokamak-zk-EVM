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
    path.join(__dirname, "circom/add_unsafe_test.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
    },
  );
  const witness = await circuit.calculateWitness({ in1: [0n, 0n], in2: [0n, 0n] }, true);
  await circuit.loadSymbols();

  const lowCarryIndex = circuit.symbols["main.low_add_carry"]?.varIdx;
  const finalCarryIndex = circuit.symbols["main.carry"]?.varIdx;
  const outputLowIndex = circuit.symbols["main.out[0]"]?.varIdx;
  assert.notEqual(lowCarryIndex, undefined);
  assert.notEqual(finalCarryIndex, undefined);
  assert.notEqual(outputLowIndex, undefined);

  const inverseBase = modularInverse(LIMB_BASE, FIELD_PRIME);
  const maliciousLowCarry = (FIELD_PRIME - inverseBase) % FIELD_PRIME;
  const maliciousFinalCarry = maliciousLowCarry * inverseBase % FIELD_PRIME;
  assert.notEqual(maliciousLowCarry, 0n);
  assert.notEqual(maliciousLowCarry, 1n);
  assert.equal((1n + maliciousLowCarry * LIMB_BASE) % FIELD_PRIME, 0n);
  assert.equal(
    (maliciousFinalCarry * LIMB_BASE - maliciousLowCarry) % FIELD_PRIME,
    0n,
  );
  const maliciousWitness = [...witness];
  maliciousWitness[outputLowIndex] = 1n;
  maliciousWitness[lowCarryIndex] = maliciousLowCarry;
  maliciousWitness[finalCarryIndex] = maliciousFinalCarry;

  await assert.rejects(
    circuit.checkConstraints(maliciousWitness),
    /Constraint doesn't match/,
  );
  console.log("Add256_unsafe rejects a non-boolean carry witness");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
