const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SCALAR_BITS = 255;
const SCALAR_ORDER = jubjub.Point.Fn.ORDER;

const normalize = (value) => BigInt(value.toString());

const expectedPoint = (base, scalar) => {
  const reducedScalar = scalar % SCALAR_ORDER;
  return (
    reducedScalar === 0n ? jubjub.Point.ZERO : base.multiply(reducedScalar)
  ).toAffine();
};

const compileCandidate = (packageRoot, name) => wasm(
  path.join(
    packageRoot,
    `subcircuits/test/circom/transaction_signature_variable_base_${name}_test.circom`,
  ),
  {
    include: path.join(packageRoot, "node_modules"),
    prime: "bls12381",
    O: 1,
  },
);

const calculate = (circuit, base, scalar) => {
  const identity = jubjub.Point.ZERO.toAffine();
  const affineBase = base.toAffine();
  return circuit.calculateWitness({
    identity: [identity.x, identity.y],
    base: [affineBase.x, affineBase.y],
    scalar,
  }, true);
};

const assertScalar = async (circuit, base, scalar, label) => {
  const witness = await calculate(circuit, base, scalar);
  const expected = expectedPoint(base, scalar);
  assert.equal(normalize(witness[1]), expected.x, `${label} result.x`);
  assert.equal(normalize(witness[2]), expected.y, `${label} result.y`);
  await circuit.assertOut(witness, { result: [expected.x, expected.y] });
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
  const bases = [
    jubjub.Point.BASE.multiply(7n).multiply(8n),
    jubjub.Point.BASE.multiply(19n).multiply(8n),
  ];
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
    1n << 254n,
    FIELD_PRIME - 1n,
  ];

  for (const { name, circuit } of candidates) {
    for (const base of bases) {
      for (const scalar of scalars) {
        await assertScalar(circuit, base, scalar, `${name} scalar ${scalar}`);
      }
    }
  }

  for (const { name, width, circuit } of candidates.filter(
    ({ width }) => width !== null,
  )) {
    const witness = await assertScalar(
      circuit,
      bases[0],
      0x123456789abcdefn,
      name,
    );
    await circuit.loadSymbols();
    const numWindows = Math.ceil(SCALAR_BITS / width);
    const middleWindow = Math.floor(numWindows / 2);
    const tableSize = 1 << width;
    await assertMutatedSignalRejected(
      circuit,
      witness,
      "main.core.tableAdditions[0].inter1",
      `${name} runtime table`,
    );
    await assertMutatedSignalRejected(
      circuit,
      witness,
      `main.core.selectors[${middleWindow}].nodes[${tableSize}][0]`,
      `${name} selected-point tree`,
    );
    await assertMutatedSignalRejected(
      circuit,
      witness,
      `main.core.doublings[${middleWindow * width}].inter1`,
      `${name} doubling chain`,
    );
    await assertMutatedSignalRejected(
      circuit,
      witness,
      `main.core.accumulators[${middleWindow}][0]`,
      `${name} accumulator`,
    );
  }

  console.log(
    "Variable-base scalar candidates passed base, scalar-boundary, padding, table, selection, and mutation tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
