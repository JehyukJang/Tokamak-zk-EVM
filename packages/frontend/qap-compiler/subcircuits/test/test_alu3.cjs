const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { wasm } = require("circom_tester");

const { split256BitInteger } = require("./helper_functions.js");

const WORD_BASE = 1n << 256n;
const MAX_UINT256 = WORD_BASE - 1n;
const RANDOM_CASES = 64;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
const expectedByte = (index, value) => (
  index >= 32n ? 0n : value >> (8n * (31n - index)) & 0xffn
);
const expectedSignExtend = (index, value) => {
  if (index >= 32n) {
    return value;
  }
  const signPosition = 8n * index + 7n;
  const retainedMask = (1n << (signPosition + 1n)) - 1n;
  return (value >> signPosition & 1n) === 1n
    ? value | (MAX_UINT256 ^ retainedMask)
    : value & retainedMask;
};

const operations = [
  { name: "SIGNEXTEND", selector: 1n << 11n, evaluate: expectedSignExtend },
  { name: "AND", selector: 1n << 22n, evaluate: (lhs, rhs) => lhs & rhs },
  { name: "OR", selector: 1n << 23n, evaluate: (lhs, rhs) => lhs | rhs },
  { name: "XOR", selector: 1n << 24n, evaluate: (lhs, rhs) => lhs ^ rhs },
  { name: "BYTE", selector: 1n << 26n, evaluate: expectedByte },
];

const encodeInput = (selector, lhs, rhs) => ({
  in: [selector, ...split256BitInteger(lhs), ...split256BitInteger(rhs)],
});

const assertOperation = async (circuit, operation, lhs, rhs, label) => {
  const witness = await circuit.calculateWitness(
    encodeInput(operation.selector, lhs, rhs),
    true,
  );
  const [expectedLow, expectedHigh] = split256BitInteger(
    operation.evaluate(lhs, rhs),
  );
  assert.equal(BigInt(witness[1].toString()), expectedLow, `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), expectedHigh, `${label} high limb`);
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/ALU3_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );

  const patternedValue = BigInt(
    `0x${Array.from({ length: 32 }, (_, index) => (
      (index * 7 + 3).toString(16).padStart(2, "0")
    )).join("")}`,
  );
  const indexBoundaries = [
    0n,
    31n,
    32n,
    1n << 128n,
    MAX_UINT256,
  ];
  const wordBoundaries = [
    0n,
    MAX_UINT256,
    0xaaaaaaaaffffffff5555555500000000aaaaaaaaffffffff5555555500000000n,
    1n << 255n,
    patternedValue,
  ];

  for (const operation of operations) {
    const lhsValues = operation.name === "BYTE" || operation.name === "SIGNEXTEND"
      ? indexBoundaries
      : wordBoundaries;
    for (const lhs of lhsValues) {
      for (const rhs of wordBoundaries) {
        await assertOperation(
          circuit,
          operation,
          lhs,
          rhs,
          `${operation.name} boundary ${lhs}:${rhs}`,
        );
      }
    }
    for (let index = 0; index < RANDOM_CASES; index++) {
      const lhs = operation.name === "BYTE" || operation.name === "SIGNEXTEND"
        ? (index % 2 === 0 ? BigInt(crypto.randomBytes(1)[0] & 31) : randomWord())
        : randomWord();
      await assertOperation(
        circuit,
        operation,
        lhs,
        randomWord(),
        `${operation.name} randomized ${index}`,
      );
    }
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 22n, 0n, 0n, 0n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      circuit.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }

  for (const selector of [
    0n,
    1n << 12n,
    1n << 25n,
    (1n << 11n) + (1n << 22n),
    (1n << 23n) + (1n << 24n),
    MAX_UINT256,
  ]) {
    await assert.rejects(
      circuit.calculateWitness(encodeInput(selector, 0n, patternedValue), true),
      undefined,
      `unsupported selector ${selector} must be rejected`,
    );
  }

  const witness = await circuit.calculateWitness(
    encodeInput(1n << 11n, 0n, 0x80n),
    true,
  );
  await circuit.loadSymbols();
  const mutationTargets = [
    ...Array.from({ length: 2 }, (_, limb) => (
      Array.from({ length: 128 }, (_, bit) => `main.bitProduct[${limb}][${bit}]`)
    )).flat(),
    "main.andResult[0]",
    "main.andResult[1]",
    "main.orResult[0]",
    "main.orResult[1]",
    "main.xorResult[0]",
    "main.xorResult[1]",
    "main.selectedByte[5][0]",
    "main.selectedSign",
    "main.fillActive[0]",
    ...Array.from({ length: 5 }, (_, index) => `main.selectorFlags[${index}]`),
    "main.out[0]",
    "main.out[1]",
  ];
  const mutatedWires = new Set();
  for (const symbolName of mutationTargets) {
    const wireIndex = circuit.symbols[symbolName]?.varIdx;
    assert.notEqual(wireIndex, undefined, `${symbolName} must be present in the witness`);
    if (mutatedWires.has(wireIndex)) {
      continue;
    }
    mutatedWires.add(wireIndex);
    const maliciousWitness = [...witness];
    maliciousWitness[wireIndex] = BigInt(maliciousWitness[wireIndex].toString()) + 1n;
    await assert.rejects(
      circuit.checkConstraints(maliciousWitness),
      /Constraint doesn't match/,
      `${symbolName} mutation must be rejected`,
    );
  }

  console.log(
    `ALU3 passed five operations, ${RANDOM_CASES} randomized cases per operation, canonicality, selector, and ${mutatedWires.size} distinct mutation checks`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
