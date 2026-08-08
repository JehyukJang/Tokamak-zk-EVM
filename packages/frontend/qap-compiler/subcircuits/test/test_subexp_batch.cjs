const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { wasm } = require("circom_tester");

const { split256BitInteger } = require("./helper_functions.js");

const WORD_MASK = (1n << 256n) - 1n;
const BATCH_SIZE = 8;
const RANDOM_CASES = 32;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);

const executeBatch = (accumulator, basePower, bits) => {
  let nextAccumulator = accumulator;
  let nextBasePower = basePower;
  for (const bit of bits) {
    if (bit === 1n) {
      nextAccumulator = nextAccumulator * nextBasePower & WORD_MASK;
    }
    nextBasePower = nextBasePower * nextBasePower & WORD_MASK;
  }
  return [nextAccumulator, nextBasePower];
};

const executeExponentiation = (base, exponent) => {
  let result = 1n;
  let currentBase = base;
  let currentExponent = exponent;
  while (currentExponent > 0n) {
    if ((currentExponent & 1n) === 1n) {
      result = result * currentBase & WORD_MASK;
    }
    currentBase = currentBase * currentBase & WORD_MASK;
    currentExponent >>= 1n;
  }
  return result;
};

const encodeInput = (accumulator, basePower, bits) => ({
  in: [
    ...split256BitInteger(accumulator),
    ...split256BitInteger(basePower),
    ...bits,
  ],
});

const assertBatch = async (
  circuit,
  accumulator,
  basePower,
  bits,
  label,
) => {
  const witness = await circuit.calculateWitness(
    encodeInput(accumulator, basePower, bits),
    true,
  );
  const [nextAccumulator, nextBasePower] = executeBatch(
    accumulator,
    basePower,
    bits,
  );
  assert.deepEqual(
    witness.slice(1, 5).map((value) => BigInt(value.toString())),
    [
      ...split256BitInteger(nextAccumulator),
      ...split256BitInteger(nextBasePower),
    ],
    label,
  );
  return witness;
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/SubExpBatch_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );

  const zeros = Array(BATCH_SIZE).fill(0n);
  await assertBatch(circuit, 0n, 0n, zeros, "zero state");
  await assertBatch(circuit, 1n, 0n, Array(BATCH_SIZE).fill(1n), "zero base");
  await assertBatch(circuit, WORD_MASK, 1n, Array(BATCH_SIZE).fill(1n), "one base");
  await assertBatch(
    circuit,
    WORD_MASK,
    WORD_MASK,
    Array(BATCH_SIZE).fill(1n),
    "maximum words",
  );

  for (let bitIndex = 0; bitIndex < BATCH_SIZE; bitIndex++) {
    const bits = [...zeros];
    bits[bitIndex] = 1n;
    await assertBatch(circuit, 7n, 3n, bits, `bit position ${bitIndex}`);
  }

  for (let index = 0; index < RANDOM_CASES; index++) {
    const randomBits = Array.from(
      { length: BATCH_SIZE },
      () => BigInt(crypto.randomBytes(1)[0] & 1),
    );
    await assertBatch(
      circuit,
      randomWord(),
      randomWord(),
      randomBits,
      `randomized ${index}`,
    );
  }

  const exponentiationCases = [
    [0n, 0n],
    [0n, WORD_MASK],
    [1n, WORD_MASK],
    [2n, 255n],
    [WORD_MASK, WORD_MASK],
    [randomWord(), randomWord()],
    [randomWord(), randomWord()],
    [randomWord(), randomWord()],
  ];
  for (const [caseIndex, [base, exponent]] of exponentiationCases.entries()) {
    let accumulator = 1n;
    let basePower = base;
    for (let batchIndex = 0; batchIndex < 256 / BATCH_SIZE; batchIndex++) {
      const bits = Array.from(
        { length: BATCH_SIZE },
        (_, bitIndex) => (
          exponent >> BigInt(batchIndex * BATCH_SIZE + bitIndex)
        ) & 1n,
      );
      const witness = await circuit.calculateWitness(
        encodeInput(accumulator, basePower, bits),
        true,
      );
      accumulator = BigInt(witness[1].toString())
        + (BigInt(witness[2].toString()) << 128n);
      basePower = BigInt(witness[3].toString())
        + (BigInt(witness[4].toString()) << 128n);
    }
    assert.equal(
      accumulator,
      executeExponentiation(base, exponent),
      `full exponentiation ${caseIndex}`,
    );
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 0; limb < 4; limb++) {
    const input = [0n, 0n, 0n, 0n, ...zeros];
    input[limb] = invalidLimb;
    await assert.rejects(
      circuit.calculateWitness({ in: input }, true),
      undefined,
      `entry limb ${limb} must be canonical`,
    );
  }
  const mutationWitness = await assertBatch(
    circuit,
    WORD_MASK,
    WORD_MASK - 1n,
    [1n, 0n, 1n, 1n, 0n, 1n, 0n, 1n],
    "mutation baseline",
  );
  await circuit.loadSymbols();
  const mutationSignals = [
    "main.out[0]",
    "main.out[3]",
    "main.accumulatorWords[4][0]",
    "main.basePowerWords[4][2]",
    "main.factorWords[3][1]",
    "main.square[3].product01",
  ];
  for (const signalName of mutationSignals) {
    const wireIndex = circuit.symbols[signalName]?.varIdx;
    assert.notEqual(wireIndex, undefined, `${signalName} must exist`);
    assert.notEqual(wireIndex, -1, `${signalName} must survive O2`);
    const mutated = [...mutationWitness];
    mutated[wireIndex] = BigInt(mutated[wireIndex].toString()) + 1n;
    await assert.rejects(
      circuit.checkConstraints(mutated),
      /Constraint doesn't match/,
      `${signalName} mutation must be rejected`,
    );
  }

  console.log(
    `SubExpBatch passed ${BATCH_SIZE} bit positions, ${RANDOM_CASES} randomized batches, ${exponentiationCases.length} complete exponentiations, canonicality, and mutation checks`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
