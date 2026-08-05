const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { jubjub } = require("@noble/curves/misc.js");
const { poseidon2 } = require("poseidon-bls12381");
const { FUNCTION_INPUT_LENGTH } = require("tokamak-l2js");
const {
  DISPOSITIONS,
  createTransactionSignatureCorpus,
  evaluateCompleteStatement,
  getChallengeInputs,
} = require("./transaction_signature_verify_oracle.cjs");

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
const PRIVATE_KEY = 7n;
const RANDOMIZER_SCALAR = 11n;

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

const toBoundaryInputs = (encodedValues) => ({
  privateIn: [
    ...encodedValues.slice(0, 5),
    ...encodedValues.slice(7),
  ],
  contractAddress: encodedValues[5],
  functionSelector: encodedValues[6],
});

const toBits = (value) => Array.from(
  { length: 255 },
  (_, index) => value >> BigInt(index) & 1n,
);

const normalize = (value) => BigInt(value.toString());

const encodePoint = (point) => {
  const affine = point.toAffine();
  return [split(affine.x), split(affine.y)];
};

const signatureFor = (
  values,
  privateKey = PRIVATE_KEY,
  randomizer = RANDOMIZER_SCALAR,
) => (
  randomizer + poseidonChainCompress(values) * privateKey
) % SCALAR_ORDER;

const calculateReferenceWitness = (
  circuit,
  values,
  signature = signatureFor(values),
  identity = jubjub.Point.ZERO,
) => {
  return circuit.calculateWitness({
    ...toBoundaryInputs(encode(values)),
    S: split(signature),
    O: encodePoint(identity),
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

const assertReference = async (
  circuit,
  values,
  label,
  signature = signatureFor(values),
) => {
  const expectedPublicKeyHash = poseidon2([values[2], values[3]]);
  const expectedOrigin = [
    expectedPublicKeyHash & LIMB_MASK,
    expectedPublicKeyHash >> 128n & ((1n << 32n) - 1n),
  ];
  const witness = await calculateReferenceWitness(
    circuit,
    values,
    signature,
  );
  await circuit.assertOut(witness, {
    origin: expectedOrigin,
  });
  assert.equal(normalize(witness[1]), expectedOrigin[0], `${label} low limb`);
  assert.equal(normalize(witness[2]), expectedOrigin[1], `${label} high limb`);
};

const assertRejectedWord = async (circuit, wordIndex, value, label) => {
  const encoded = encode(makeValues());
  encoded[wordIndex] = split(value);
  await assert.rejects(
    circuit.calculateWitness({
      ...toBoundaryInputs(encoded),
      S: split(signatureFor(makeValues())),
      O: encodePoint(jubjub.Point.ZERO),
    }, true),
    undefined,
    label,
  );
};

const assertPolicyCorpus = async (circuit) => {
  const corpus = createTransactionSignatureCorpus();

  for (const vector of corpus) {
    const oracle = evaluateCompleteStatement(vector);
    const values = getChallengeInputs(vector);

    if (vector.disposition === DISPOSITIONS.CIRCUIT_LOCAL_REJECTION) {
      assert.equal(oracle.circuit.accepted, false, `${vector.id} oracle`);
      assert.equal(
        oracle.delegatedPublic.accepted,
        true,
        `${vector.id} must remain a circuit-owned rejection`,
      );
      await assert.rejects(
        calculateReferenceWitness(circuit, values, vector.signature),
        undefined,
        `${vector.id} must be rejected by the circuit`,
      );
      continue;
    }

    assert.equal(oracle.circuit.accepted, true, `${vector.id} oracle`);
    await assertReference(circuit, values, vector.id, vector.signature);

    if (vector.disposition === DISPOSITIONS.DELEGATED_PUBLIC_REJECTION) {
      assert.equal(oracle.delegatedPublic.accepted, false, `${vector.id} boundary`);
      assert.equal(oracle.accepted, false, `${vector.id} complete statement`);
    } else {
      assert.equal(oracle.delegatedPublic.accepted, true, `${vector.id} boundary`);
      assert.equal(oracle.accepted, true, `${vector.id} complete statement`);
    }
  }

  return corpus.length;
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
  await assertReference(circuit, ordinary, "ordinary challenge");

  const ordinaryWitness = await calculateReferenceWitness(circuit, ordinary);
  await circuit.loadSymbols();

  const boundaries = makeValues();
  boundaries[4] = FIELD_PRIME - 1n;
  boundaries[7] = 0n;
  boundaries[CHALLENGE_INPUT_COUNT - 1] = FIELD_PRIME - 1n;
  await assertReference(circuit, boundaries, "private-message boundaries");

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
      ...toBoundaryInputs(invalidLowLimb),
      S: split(signatureFor(makeValues())),
      O: encodePoint(jubjub.Point.ZERO),
    }, true),
    undefined,
    "a 129-bit private low limb must be rejected",
  );

  const invalidHighLimb = encode(makeValues());
  invalidHighLimb[7] = [0n, 1n << 127n];
  await assert.rejects(
    circuit.calculateWitness({
      ...toBoundaryInputs(invalidHighLimb),
      S: split(signatureFor(makeValues())),
      O: encodePoint(jubjub.Point.ZERO),
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
  await assertReference(
    circuit,
    orderTwoRandomizer,
    "non-identity order-two randomizer",
    poseidonChainCompress(orderTwoRandomizer) * PRIVATE_KEY % SCALAR_ORDER,
  );

  let outOfRangeSignatureValues;
  let outOfRangeSignature;
  for (let candidate = 0n; candidate < 64n; candidate++) {
    const candidateValues = makeValues();
    candidateValues[7] += candidate;
    const canonicalSignature = signatureFor(candidateValues);
    if (canonicalSignature + SCALAR_ORDER < 1n << 252n) {
      outOfRangeSignatureValues = candidateValues;
      outOfRangeSignature = canonicalSignature + SCALAR_ORDER;
      break;
    }
  }
  assert.notEqual(
    outOfRangeSignatureValues,
    undefined,
    "a deterministic S + n test vector must exist",
  );
  await assertReference(
    circuit,
    outOfRangeSignatureValues,
    "externally invalid S + n",
    outOfRangeSignature,
  );
  await assert.rejects(
    calculateReferenceWitness(circuit, ordinary, 1n << 252n),
    undefined,
    "a 253-bit S must be rejected by the scalar decomposition",
  );

  const ordinarySignature = signatureFor(ordinary);
  for (const [wordIndex, label] of [
    [5, "contract address"],
    [6, "function selector"],
  ]) {
    const changedPublicWord = [...ordinary];
    changedPublicWord[wordIndex] += 1n;
    await assert.rejects(
      calculateReferenceWitness(circuit, changedPublicWord, ordinarySignature),
      undefined,
      `a changed public ${label} must invalidate the signed statement`,
    );
  }
  const swappedPublicWords = [...ordinary];
  [swappedPublicWords[5], swappedPublicWords[6]] = [
    swappedPublicWords[6],
    swappedPublicWords[5],
  ];
  await assert.rejects(
    calculateReferenceWitness(circuit, swappedPublicWords, ordinarySignature),
    undefined,
    "swapped contract-address and function-selector inputs must be rejected",
  );

  await assert.rejects(
    calculateReferenceWitness(circuit, ordinary, ordinarySignature + 1n),
    undefined,
    "an invalid terminal signature equation must be rejected",
  );
  const [ordinarySignatureLow, ordinarySignatureHigh] = split(ordinarySignature);
  assert.notEqual(
    ordinarySignatureHigh,
    0n,
    "the non-canonical public-limb test requires a nonzero high limb",
  );
  const nonCanonicalPublicLowLimb = await circuit.calculateWitness({
    ...toBoundaryInputs(encode(ordinary)),
    S: [ordinarySignatureLow + LIMB_BASE, ordinarySignatureHigh - 1n],
    O: encodePoint(jubjub.Point.ZERO),
  }, true);
  await circuit.checkConstraints(nonCanonicalPublicLowLimb);

  const originIndex = circuit.symbols["main.origin[0]"]?.varIdx;
  assert.notEqual(originIndex, undefined, "origin must exist in the witness");
  const wrongOrigin = [...ordinaryWitness];
  wrongOrigin[originIndex] = (
    normalize(wrongOrigin[originIndex]) + 1n
  ) % FIELD_PRIME;
  await assert.rejects(
    circuit.checkConstraints(wrongOrigin),
    /Constraint doesn't match/,
    "a mutated origin must be rejected",
  );

  for (const [signalName, label] of [
    [
      "main.reference.privateWords[0].lowBits.out[0]",
      "private-word low-limb range-check bit",
    ],
    [
      "main.reference.privateWords[0].highBits.out[126]",
      "private-word high-limb range-check bit",
    ],
    [
      "main.reference.privateWords[0].fieldBound.lowDifference.out[0]",
      "private-word field-bound low-difference bit",
    ],
    [
      "main.reference.privateWords[0].fieldBound.highDifference.out[126]",
      "private-word field-bound high-difference bit",
    ],
    ["main.reference.hashes[0].m[63].out[1]", "Poseidon terminal state word 1"],
    ["main.reference.hashes[0].m[63].out[2]", "Poseidon terminal state word 2"],
    [
      "main.reference.pointValidation.publicKeyCofactor.point4.A",
      "public-key cofactor intermediate",
    ],
    [
      "main.reference.randomizerCofactor.randomizerCofactor.point4.A",
      "randomizer cofactor intermediate",
    ],
    [
      "main.reference.responseScalar.accumulators[42][0]",
      "response scalar accumulator",
    ],
    ["main.reference.responseScalar.selected[42][2]", "response selected T"],
    ["main.reference.responseScalar.selected[42][0]", "response table selection"],
    ["main.reference.responseScalar.products[42][0]", "response selector monomial"],
    [
      "main.reference.challengeScalar.tableAdditions[0].inter1",
      "challenge scalar runtime table",
    ],
    [
      "main.reference.challengeScalar.selectors[64].nodes[4][0]",
      "challenge scalar selection tree",
    ],
    [
      "main.reference.challengeScalar.doublings[128].A",
      "challenge scalar doubling chain",
    ],
    [
      "main.reference.challengeScalar.additions[64].affineT",
      "challenge scalar mixed addition",
    ],
    [
      "main.reference.challengeScalar.accumulators[64][0]",
      "challenge scalar accumulator",
    ],
    ["main.reference.terminalAddition.C", "terminal mixed-addition intermediate"],
    ["main.reference.responseScalar.result[3]", "response terminal T coordinate"],
    ["main.reference.terminalAddition.result[3]", "sum terminal T coordinate"],
    ["main.reference.terminalEquality.scale", "terminal projective scale"],
    ["main.reference.canonicalPublicKeyHash.bits[0]", "public-key hash low bit"],
    ["main.reference.canonicalPublicKeyHash.bits[254]", "public-key hash high bit"],
  ]) {
    const signalIndex = circuit.symbols[signalName]?.varIdx;
    assert.notEqual(signalIndex, undefined, `${label} must exist in the witness`);
    const wrongIntermediate = [...ordinaryWitness];
    wrongIntermediate[signalIndex] = (
      normalize(wrongIntermediate[signalIndex]) + 1n
    ) % FIELD_PRIME;
    await assert.rejects(
      circuit.checkConstraints(wrongIntermediate),
      /Constraint doesn't match/,
      `a mutated ${label} must be rejected`,
    );
  }

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

  const corpusSize = await assertPolicyCorpus(circuit);

  console.log(
    `Transaction signature reference passed canonicality, cofactored-equation, point-policy, verified-origin, and ${corpusSize} policy-corpus tests`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
