const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const SCALAR_ORDER = jubjub.Point.Fn.ORDER;

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
  const candidates = await Promise.all([2, 3, 4].map(async (width) => ({
    width,
    circuit: await wasm(
      path.join(
        packageRoot,
        `subcircuits/test/circom/transaction_signature_variable_base_window${width}_extended_test.circom`,
      ),
      {
        include: path.join(packageRoot, "node_modules"),
        prime: "bls12381",
        O: 1,
      },
    ),
  })));
  const identity = jubjub.Point.ZERO.toAffine();
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

  for (const { width, circuit } of candidates) {
    let mutationWitness;
    for (const base of bases) {
      const affineBase = base.toAffine();
      for (const scalar of scalars) {
        const witness = await circuit.calculateWitness({
          identity: [identity.x, identity.y],
          base: [affineBase.x, affineBase.y],
          scalar,
        }, true);
        const reducedScalar = scalar % SCALAR_ORDER;
        const expected = (
          reducedScalar === 0n ? jubjub.Point.ZERO : base.multiply(reducedScalar)
        ).toAffine();
        assert.equal(
          normalize(witness[1]),
          expected.x,
          `window${width} scalar ${scalar} result.x`,
        );
        assert.equal(
          normalize(witness[2]),
          expected.y,
          `window${width} scalar ${scalar} result.y`,
        );
        await circuit.assertOut(witness, { result: [expected.x, expected.y] });
        if (mutationWitness === undefined && scalar === 0xa55an) {
          mutationWitness = witness;
        }
      }
    }

    await circuit.loadSymbols();
    const numWindows = Math.ceil(255 / width);
    const middleWindow = Math.floor(numWindows / 2);
    const tableSize = 1 << width;
    for (const [signalName, label] of [
      ["main.core.tableAdditions[0].inter1", "runtime table"],
      [
        `main.core.selectors[${middleWindow}].nodes[${tableSize}][0]`,
        "selection tree",
      ],
      [
        `main.core.doublings[${middleWindow * width}].A`,
        "extended doubling",
      ],
      [
        `main.core.additions[${middleWindow}].affineT`,
        "mixed addition",
      ],
      [
        `main.core.accumulators[${middleWindow}][0]`,
        "extended accumulator",
      ],
    ]) {
      await assertMutatedSignalRejected(
        circuit,
        mutationWitness,
        signalName,
        `window${width} ${label}`,
      );
    }
  }

  console.log(
    "Extended variable-base windows passed scalar boundaries and internal mutation tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
