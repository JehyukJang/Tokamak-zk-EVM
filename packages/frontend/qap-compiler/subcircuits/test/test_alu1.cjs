const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { wasm } = require("circom_tester");

const { split256BitInteger } = require("./helper_functions.js");

const WORD_BASE = 1n << 256n;
const MAX_UINT256 = WORD_BASE - 1n;
const RANDOM_CASES = 128;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
const operations = [
  { name: "ADD", selector: 1n << 1n, evaluate: (lhs, rhs) => (lhs + rhs) & MAX_UINT256 },
  { name: "MUL", selector: 1n << 2n, evaluate: (lhs, rhs) => (lhs * rhs) & MAX_UINT256 },
  { name: "SUB", selector: 1n << 3n, evaluate: (lhs, rhs) => (lhs - rhs) & MAX_UINT256 },
  { name: "NOT", selector: 1n << 25n, evaluate: (lhs) => MAX_UINT256 ^ lhs },
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
    path.join(packageRoot, "subcircuits/circom/ALU1_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );
  const boundaries = [
    0n,
    1n,
    (1n << 128n) - 1n,
    1n << 128n,
    1n << 255n,
    MAX_UINT256,
  ];

  for (const operation of operations) {
    for (const lhs of boundaries) {
      for (const rhs of boundaries) {
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
      await assertOperation(
        circuit,
        operation,
        randomWord(),
        randomWord(),
        `${operation.name} randomized ${index}`,
      );
    }
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 1n, 0n, 0n, 0n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      circuit.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }

  for (const selector of [
    0n,
    1n,
    1n << 20n,
    1n << 21n,
    (1n << 1n) + (1n << 2n),
    (1n << 3n) + (1n << 25n),
    MAX_UINT256,
  ]) {
    await assert.rejects(
      circuit.calculateWitness(encodeInput(selector, 0n, 1n), true),
      undefined,
      `unsupported selector ${selector} must be rejected`,
    );
  }

  const witness = await circuit.calculateWitness(
    encodeInput(1n << 2n, MAX_UINT256, MAX_UINT256),
    true,
  );
  await circuit.loadSymbols();
  const mutationTargets = [
    "main.out[0]",
    "main.out[1]",
    "main.mul.out[0]",
    "main.mul.out[1]",
    "main.basis2",
    "main.basis3",
    "main.term1[0]",
    "main.term2[1]",
    "main.term3[0]",
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
    `ALU1 passed four operations, ${boundaries.length ** 2} boundary pairs and ${RANDOM_CASES} randomized cases per operation, canonicality, selector, and ${mutatedWires.size} distinct mutation checks`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
