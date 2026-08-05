const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;
const MAX_255 = (1n << 255n) - 1n;

const split = (value) => [value & LIMB_MASK, value >> 128n];

const compileCandidate = (packageRoot, name) => wasm(
  path.join(
    packageRoot,
    `subcircuits/test/circom/canonical_private_field_word_${name}_test.circom`,
  ),
  {
    include: path.join(packageRoot, "node_modules"),
    prime: "bls12381",
    O: 1,
  },
);

const assertAccepted = async (circuit, value, label) => {
  const witness = await circuit.calculateWitness({ in: split(value) }, true);
  await circuit.assertOut(witness, { value });
  assert.equal(BigInt(witness[1].toString()), value, label);
};

const assertRejected = (circuit, limbs, label) => assert.rejects(
  circuit.calculateWitness({ in: limbs }, true),
  undefined,
  label,
);

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const candidates = await Promise.all(
    ["baseline", "lexicographic", "complement_carry"].map(async (name) => [
      name,
      await compileCandidate(packageRoot, name),
    ]),
  );

  for (const [name, circuit] of candidates) {
    for (const value of [
      0n,
      1n,
      LIMB_BASE - 1n,
      LIMB_BASE,
      FIELD_PRIME - 2n,
      FIELD_PRIME - 1n,
    ]) {
      await assertAccepted(circuit, value, `${name} accepts ${value}`);
    }

    for (const value of [FIELD_PRIME, FIELD_PRIME + 1n, MAX_255]) {
      await assertRejected(circuit, split(value), `${name} rejects ${value}`);
    }

    for (const value of [0n, 1n, LIMB_BASE - 1n]) {
      await assertRejected(
        circuit,
        split(value + FIELD_PRIME),
        `${name} rejects the ${value} + Fr alias`,
      );
    }

    await assertRejected(
      circuit,
      [LIMB_BASE, 0n],
      `${name} rejects a 129-bit low limb`,
    );
    await assertRejected(
      circuit,
      [0n, 1n << 127n],
      `${name} rejects a 128-bit high limb`,
    );

    let state = 0x9e3779b97f4a7c15n;
    for (let index = 0; index < 64; index++) {
      state = (
        state * 0x5851f42d4c957f2dn + 0x14057b7ef767814fn
      ) & MAX_255;
      if (state < FIELD_PRIME) {
        await assertAccepted(circuit, state, `${name} accepts sample ${index}`);
      } else {
        await assertRejected(
          circuit,
          split(state),
          `${name} rejects sample ${index}`,
        );
      }
    }
  }

  console.log(
    "Canonical private field-word candidates passed boundary, alias, limb, and differential tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
