const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

const normalize = (value) => BigInt(value.toString());

const compileCandidate = (packageRoot, name) => wasm(
  path.join(
    packageRoot,
    `subcircuits/test/circom/transaction_signature_cofactor_${name}_test.circom`,
  ),
  {
    include: path.join(packageRoot, "node_modules"),
    prime: "bls12381",
    O: 2,
  },
);

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
  const [affineA, extendedA, affineR, extendedR] = await Promise.all([
    compileCandidate(packageRoot, "affine_a"),
    compileCandidate(packageRoot, "extended_a"),
    compileCandidate(packageRoot, "affine_r"),
    compileCandidate(packageRoot, "extended_r"),
  ]);
  const points = [
    jubjub.Point.BASE.multiply(7n),
    jubjub.Point.BASE.multiply(11n),
    jubjub.Point.BASE.multiply(19n),
  ];
  const challengePoint = jubjub.Point.BASE.multiply(23n).multiply(8n);
  const challengeAffine = challengePoint.toAffine();
  const challenge = [
    challengeAffine.x,
    challengeAffine.y,
    1n,
    challengeAffine.x * challengeAffine.y % FIELD_PRIME,
  ];

  let aWitness;
  let rWitness;
  for (const point of points) {
    const affine = point.toAffine();
    const expectedA = point.multiply(8n).toAffine();
    for (const circuit of [affineA, extendedA]) {
      const witness = await circuit.calculateWitness({
        point: [affine.x, affine.y],
      }, true);
      await circuit.assertOut(witness, { result: [expectedA.x, expectedA.y] });
      if (circuit === extendedA && aWitness === undefined) {
        aWitness = witness;
      }
    }

    const expectedR = challengePoint.add(point.multiply(8n)).toAffine();
    for (const circuit of [affineR, extendedR]) {
      const witness = await circuit.calculateWitness({
        randomizer: [affine.x, affine.y],
        challenge,
      }, true);
      await circuit.assertOut(witness, { result: [expectedR.x, expectedR.y] });
      if (circuit === extendedR && rWitness === undefined) {
        rWitness = witness;
      }
    }
  }

  await extendedA.loadSymbols();
  await assertMutatedSignalRejected(
    extendedA,
    aWitness,
    "main.cofactor.point4.A",
    "public-key cofactor doubling",
  );
  await extendedR.loadSymbols();
  for (const [signalName, label] of [
    ["main.cofactor.point4.A", "randomizer cofactor doubling"],
    ["main.addition.C", "extended terminal addition"],
  ]) {
    await assertMutatedSignalRejected(extendedR, rWitness, signalName, label);
  }

  console.log(
    "Extended cofactor candidates passed public-key, randomizer, terminal, and mutation tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
