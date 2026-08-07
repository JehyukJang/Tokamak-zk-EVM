const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SCALAR_BITS = 252;
const SCALAR_ORDER = jubjub.Point.Fn.ORDER;
const MAX_SCALAR = (1n << BigInt(SCALAR_BITS)) - 1n;
const G8 = jubjub.Point.BASE.multiply(8n);

const normalize = (value) => BigInt(value.toString());

const expectedPoint = (scalar) => {
  const reducedScalar = scalar % SCALAR_ORDER;
  return (
    reducedScalar === 0n ? jubjub.Point.ZERO : G8.multiply(reducedScalar)
  ).toAffine();
};

const compileCandidate = (packageRoot, name) => wasm(
  path.join(
    packageRoot,
    `subcircuits/test/circom/transaction_signature_fixed_base_${name}_test.circom`,
  ),
  {
    include: path.join(packageRoot, "node_modules"),
    prime: "bls12381",
    O: 2,
  },
);

const assertScalar = async (circuit, scalar, label) => {
  const witness = await circuit.calculateWitness({ scalar }, true);
  const expected = expectedPoint(scalar);
  await circuit.assertOut(witness, { result: [expected.x, expected.y] });
  assert.equal(normalize(witness[1]), expected.x, `${label} result.x`);
  assert.equal(normalize(witness[2]), expected.y, `${label} result.y`);
  return witness;
};

const assertMutatedSignalRejected = async (
  circuit,
  witness,
  signalName,
  label,
) => {
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
  const definitions = [
    ["binary", null],
    ["window2", 2],
    ["window3", 3],
    ["window4", 4],
  ];
  const candidates = await Promise.all(definitions.map(async ([name, width]) => ({
    name,
    width,
    circuit: await compileCandidate(packageRoot, name),
  })));

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
  for (const { name, circuit } of candidates) {
    for (const scalar of scalars) {
      await assertScalar(circuit, scalar, `${name} scalar ${scalar}`);
    }
    await assert.rejects(
      circuit.calculateWitness({ scalar: 1n << 252n }, true),
      undefined,
      `${name} rejects a 253-bit scalar`,
    );
  }

  for (const { name, width, circuit } of candidates.filter(
    ({ width }) => width !== null,
  )) {
    const witness = await assertScalar(circuit, 0x123456789abcdefn, name);
    await circuit.loadSymbols();
    const middleWindow = Math.floor((SCALAR_BITS / width) / 2);
    await assertMutatedSignalRejected(
      circuit,
      witness,
      `main.core.selected[${middleWindow}][0]`,
      `${name} selected point`,
    );
    await assertMutatedSignalRejected(
      circuit,
      witness,
      `main.core.products[${middleWindow}][0]`,
      `${name} selector monomial`,
    );
    await assertMutatedSignalRejected(
      circuit,
      witness,
      `main.core.accumulators[${middleWindow}][0]`,
      `${name} accumulator`,
    );
  }

  console.log(
    "Fixed-base scalar candidates passed scalar-boundary, table-selection, accumulator, and mutation tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
