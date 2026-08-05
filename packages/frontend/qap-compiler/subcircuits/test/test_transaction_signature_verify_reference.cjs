const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");
const { poseidon2 } = require("poseidon-bls12381");
const { FUNCTION_INPUT_LENGTH } = require("tokamak-l2js");

const FIELD_PRIME = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const JUBJUB_A = FIELD_PRIME - 1n;
const JUBJUB_D = 19257038036680949359750312669786877991949435402254120286184196891950884077233n;
const LIMB_BASE = 1n << 128n;
const LIMB_MASK = LIMB_BASE - 1n;
const PRIVATE_INPUT_COUNT = FUNCTION_INPUT_LENGTH;
const CHALLENGE_INPUT_COUNT = PRIVATE_INPUT_COUNT + 7;
const PUBLIC_KEY = jubjub.Point.BASE.multiply(7n);
const RANDOMIZER = jubjub.Point.BASE.multiply(11n);
const SCALAR_ORDER = jubjub.Point.Fn.ORDER;
const DEFAULT_SIGNATURE = 123456789n;

const split = (value) => [value & LIMB_MASK, value >> 128n];

const poseidonChainCompress = (values) => {
  let accumulator = poseidon2([values[0], values[1]]);
  for (let index = 2; index < values.length; index++) {
    accumulator = poseidon2([accumulator, values[index]]);
  }
  return accumulator;
};

const makeValues = () => {
  const values = Array.from(
    { length: CHALLENGE_INPUT_COUNT },
    (_, index) => BigInt(index + 1) * 0x10000000000000001n,
  );
  const randomizer = RANDOMIZER.toAffine();
  const publicKey = PUBLIC_KEY.toAffine();
  values[0] = randomizer.x;
  values[1] = randomizer.y;
  values[2] = publicKey.x;
  values[3] = publicKey.y;
  return values;
};

const encode = (values) => values.map(split);

const toBits = (value) => Array.from(
  { length: 255 },
  (_, index) => value >> BigInt(index) & 1n,
);

const normalize = (value) => BigInt(value.toString());

const calculateReferenceWitness = (circuit, values, signature = DEFAULT_SIGNATURE) => {
  return circuit.calculateWitness({
    in: encode(values),
    S: split(signature),
  }, true);
};

const powMod = (base, exponent) => {
  let result = 1n;
  let factor = base % FIELD_PRIME;
  let remaining = exponent;
  while (remaining !== 0n) {
    if ((remaining & 1n) === 1n) {
      result = result * factor % FIELD_PRIME;
    }
    factor = factor * factor % FIELD_PRIME;
    remaining >>= 1n;
  }
  return result;
};

const assertChallenge = async (
  circuit,
  values,
  label,
  signature = DEFAULT_SIGNATURE,
) => {
  const expected = poseidonChainCompress(values);
  const expectedA8 = jubjub.Point.fromAffine({
    x: values[2],
    y: values[3],
  }).multiply(8n).toAffine();
  const witness = await calculateReferenceWitness(circuit, values, signature);
  await circuit.assertOut(witness, {
    challenge: split(expected),
    challengeBits: toBits(expected),
    sBits: toBits(signature).slice(0, 252),
    A8: [expectedA8.x, expectedA8.y],
  });
  assert.equal(normalize(witness[1]), expected & LIMB_MASK, `${label} low limb`);
  assert.equal(normalize(witness[2]), expected >> 128n, `${label} high limb`);
};

const assertRejectedWord = async (circuit, wordIndex, value, label) => {
  const encoded = encode(makeValues());
  encoded[wordIndex] = split(value);
  await assert.rejects(
    circuit.calculateWitness({ in: encoded, S: split(DEFAULT_SIGNATURE) }, true),
    undefined,
    label,
  );
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(
      packageRoot,
      "subcircuits/test/circom/transaction_signature_verify_reference_test.circom",
    ),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 1,
    },
  );

  const legendreExponent = (FIELD_PRIME - 1n) / 2n;
  assert.equal(
    powMod(JUBJUB_A, legendreExponent),
    1n,
    "Jubjub a must be a square for the complete affine addition law",
  );
  assert.equal(
    powMod(JUBJUB_D, legendreExponent),
    FIELD_PRIME - 1n,
    "Jubjub d must be a nonsquare for the complete affine addition law",
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

  const ordinaryWitness = await calculateReferenceWitness(circuit, ordinary);
  await circuit.loadSymbols();
  const A8XIndex = circuit.symbols["main.A8[0]"]?.varIdx;
  assert.notEqual(A8XIndex, undefined, "A8.x must be present in the reference witness");
  const wrongA8Witness = [...ordinaryWitness];
  wrongA8Witness[A8XIndex] = (normalize(wrongA8Witness[A8XIndex]) + 1n) % FIELD_PRIME;
  await assert.rejects(
    circuit.checkConstraints(wrongA8Witness),
    /Constraint doesn't match/,
    "a mutated A8 output must be rejected",
  );

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
    circuit.calculateWitness({
      in: invalidLowLimb,
      S: split(DEFAULT_SIGNATURE),
    }, true),
    undefined,
    "a 129-bit private low limb must be rejected",
  );

  const invalidHighLimb = encode(makeValues());
  invalidHighLimb[7] = [0n, 1n << 127n];
  await assert.rejects(
    circuit.calculateWitness({
      in: invalidHighLimb,
      S: split(DEFAULT_SIGNATURE),
    }, true),
    undefined,
    "a 128-bit private high limb must be rejected",
  );

  for (const [coordinate, value] of [[0, 1n], [1, 1n], [2, 1n], [3, 1n]]) {
    const invalidPoint = makeValues();
    invalidPoint[coordinate] = value;
    await assert.rejects(
      calculateReferenceWitness(circuit, invalidPoint),
      undefined,
      `invalid curve coordinate ${coordinate} must be rejected`,
    );
  }

  const identityPublicKey = makeValues();
  identityPublicKey[2] = 0n;
  identityPublicKey[3] = 1n;
  await assert.rejects(
    calculateReferenceWitness(circuit, identityPublicKey),
    undefined,
    "the identity public key must be rejected",
  );

  const orderTwoPublicKey = makeValues();
  orderTwoPublicKey[2] = 0n;
  orderTwoPublicKey[3] = FIELD_PRIME - 1n;
  await assert.rejects(
    calculateReferenceWitness(circuit, orderTwoPublicKey),
    undefined,
    "a pure order-two public key must be rejected by A8 != O",
  );

  const identityRandomizer = makeValues();
  identityRandomizer[0] = 0n;
  identityRandomizer[1] = 1n;
  await assert.rejects(
    calculateReferenceWitness(circuit, identityRandomizer),
    undefined,
    "the identity randomizer must be rejected",
  );

  const orderTwoRandomizer = makeValues();
  orderTwoRandomizer[0] = 0n;
  orderTwoRandomizer[1] = FIELD_PRIME - 1n;
  await assertChallenge(
    circuit,
    orderTwoRandomizer,
    "non-identity order-two randomizer",
  );

  for (const signature of [
    0n,
    SCALAR_ORDER - 1n,
    SCALAR_ORDER,
    (1n << 252n) - 1n,
  ]) {
    await assertChallenge(
      circuit,
      ordinary,
      `signature scalar ${signature}`,
      signature,
    );
  }
  await assert.rejects(
    calculateReferenceWitness(circuit, ordinary, 1n << 252n),
    undefined,
    "a 253-bit S must be rejected by the scalar decomposition",
  );

  const nonCanonicalPublicLowLimb = await circuit.calculateWitness({
    in: encode(ordinary),
    S: [LIMB_BASE, 0n],
  }, true);
  await circuit.assertOut(nonCanonicalPublicLowLimb, {
    sBits: toBits(LIMB_BASE).slice(0, 252),
  });

  const sBitIndex = circuit.symbols["main.sBits[0]"]?.varIdx;
  assert.notEqual(sBitIndex, undefined, "sBits[0] must be present in the reference witness");
  const wrongSBitWitness = [...ordinaryWitness];
  wrongSBitWitness[sBitIndex] = 1n - normalize(wrongSBitWitness[sBitIndex]);
  await assert.rejects(
    circuit.checkConstraints(wrongSBitWitness),
    /Constraint doesn't match/,
    "a mutated S decomposition bit must be rejected",
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
    "Transaction signature reference passed challenge, canonicality, public-scalar, complete-addition, and point-policy tests",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
