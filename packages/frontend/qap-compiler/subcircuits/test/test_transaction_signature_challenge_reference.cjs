const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { poseidon2 } = require("poseidon-bls12381");
const { FUNCTION_INPUT_LENGTH } = require("tokamak-l2js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;
const PRIVATE_INPUT_COUNT = FUNCTION_INPUT_LENGTH;
const CHALLENGE_INPUT_COUNT = PRIVATE_INPUT_COUNT + 7;

const split = (value) => [value & LIMB_MASK, value >> 128n];

const poseidonChainCompress = (values) => {
  let accumulator = poseidon2([values[0], values[1]]);
  for (let index = 2; index < values.length; index++) {
    accumulator = poseidon2([accumulator, values[index]]);
  }
  return accumulator;
};

const makeValues = () => Array.from(
  { length: CHALLENGE_INPUT_COUNT },
  (_, index) => BigInt(index + 1) * 0x10000000000000001n,
);

const encode = (values) => values.map(split);

const toBits = (value) => Array.from(
  { length: 255 },
  (_, index) => value >> BigInt(index) & 1n,
);

const normalize = (value) => BigInt(value.toString());

const assertChallenge = async (circuit, values, label) => {
  const expected = poseidonChainCompress(values);
  const witness = await circuit.calculateWitness({ in: encode(values) }, true);
  await circuit.assertOut(witness, {
    challenge: split(expected),
    challengeBits: toBits(expected),
  });
  assert.equal(normalize(witness[1]), expected & LIMB_MASK, `${label} low limb`);
  assert.equal(normalize(witness[2]), expected >> 128n, `${label} high limb`);
};

const assertRejectedWord = async (circuit, wordIndex, value, label) => {
  const encoded = encode(makeValues());
  encoded[wordIndex] = split(value);
  await assert.rejects(
    circuit.calculateWitness({ in: encoded }, true),
    undefined,
    label,
  );
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(
      packageRoot,
      "subcircuits/test/circom/transaction_signature_challenge_reference_test.circom",
    ),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 1,
    },
  );
  const canonicalFieldBits = await wasm(
    path.join(
      packageRoot,
      "subcircuits/test/circom/canonical_bls_field_bits_test.circom",
    ),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 1,
    },
  );

  const ordinary = makeValues();
  await assertChallenge(circuit, ordinary, "ordinary challenge");

  const boundaries = makeValues();
  boundaries[4] = FIELD_PRIME - 1n;
  boundaries[7] = 0n;
  boundaries[CHALLENGE_INPUT_COUNT - 1] = FIELD_PRIME - 1n;
  await assertChallenge(circuit, boundaries, "private-message boundaries");

  for (const value of [FIELD_PRIME, FIELD_PRIME + 1n, (1n << 255n) - 1n]) {
    await assertRejectedWord(
      circuit,
      4,
      value,
      `nonce ${value} must be rejected`,
    );
    await assertRejectedWord(
      circuit,
      7,
      value,
      `first private input ${value} must be rejected`,
    );
    await assertRejectedWord(
      circuit,
      CHALLENGE_INPUT_COUNT - 1,
      value,
      `last private input ${value} must be rejected`,
    );
  }

  const invalidLowLimb = encode(makeValues());
  invalidLowLimb[4] = [LIMB_BASE, 0n];
  await assert.rejects(
    circuit.calculateWitness({ in: invalidLowLimb }, true),
    undefined,
    "a 129-bit private low limb must be rejected",
  );

  const invalidHighLimb = encode(makeValues());
  invalidHighLimb[7] = [0n, 1n << 127n];
  await assert.rejects(
    circuit.calculateWitness({ in: invalidHighLimb }, true),
    undefined,
    "a 128-bit private high limb must be rejected",
  );

  await canonicalFieldBits.calculateWitness({
    fieldValue: FIELD_PRIME - 1n,
    claimedBits: toBits(FIELD_PRIME - 1n),
  }, true);
  for (const alias of [FIELD_PRIME, FIELD_PRIME + 1n, (1n << 255n) - 1n]) {
    await assert.rejects(
      canonicalFieldBits.calculateWitness({
        fieldValue: alias,
        claimedBits: toBits(alias),
      }, true),
      undefined,
      `non-canonical field-element bit representation ${alias} must be rejected`,
    );
  }

  console.log(
    "Transaction signature challenge reference passed fixed-chain, canonical-output, and private-message boundary tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
