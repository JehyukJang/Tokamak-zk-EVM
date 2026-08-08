const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const { wasm } = require("circom_tester");

const { split256BitInteger } = require("./helper_functions.js");

const WORD_BASE = 1n << 256n;
const SIGN_BIT = 1n << 255n;
const MAX_UINT256 = WORD_BASE - 1n;
const RANDOM_CASES = 128;

const randomWord = () => BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
const toSigned = (value) => value >= SIGN_BIT ? value - WORD_BASE : value;

const operations = [
  { name: "LT", selector: 1n << 16n, evaluate: (lhs, rhs) => BigInt(lhs < rhs) },
  { name: "GT", selector: 1n << 17n, evaluate: (lhs, rhs) => BigInt(lhs > rhs) },
  { name: "SLT", selector: 1n << 18n, evaluate: (lhs, rhs) => BigInt(toSigned(lhs) < toSigned(rhs)) },
  { name: "SGT", selector: 1n << 19n, evaluate: (lhs, rhs) => BigInt(toSigned(lhs) > toSigned(rhs)) },
  { name: "EQ", selector: 1n << 20n, evaluate: (lhs, rhs) => BigInt(lhs === rhs) },
  { name: "ISZERO", selector: 1n << 21n, evaluate: (lhs) => BigInt(lhs === 0n) },
];

const encodeInput = (selector, lhs, rhs) => ({
  in: [selector, ...split256BitInteger(lhs), ...split256BitInteger(rhs)],
});

const assertOperation = async (circuit, operation, lhs, rhs, label) => {
  const witness = await circuit.calculateWitness(
    encodeInput(operation.selector, lhs, rhs),
    true,
  );
  assert.equal(BigInt(witness[1].toString()), operation.evaluate(lhs, rhs), `${label} low limb`);
  assert.equal(BigInt(witness[2].toString()), 0n, `${label} high limb`);
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/ALU2_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );
  const boundaries = [
    0n,
    1n,
    SIGN_BIT - 1n,
    SIGN_BIT,
    MAX_UINT256 - 1n,
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
      const lhs = operation.name === "ISZERO" && index % 16 === 0 ? 0n : randomWord();
      const rhs = operation.name === "EQ" && index % 16 === 0 ? lhs : randomWord();
      await assertOperation(
        circuit,
        operation,
        lhs,
        rhs,
        `${operation.name} randomized ${index}`,
      );
    }
  }

  const invalidLimb = 1n << 128n;
  for (let limb = 1; limb <= 4; limb++) {
    const input = [1n << 16n, 0n, 0n, 0n, 0n];
    input[limb] = invalidLimb;
    await assert.rejects(
      circuit.calculateWitness({ in: input }, true),
      undefined,
      `non-canonical input limb ${limb} must be rejected`,
    );
  }

  for (const selector of [
    0n,
    1n << 15n,
    1n << 22n,
    (1n << 16n) + (1n << 17n),
    (1n << 20n) + (1n << 21n),
    MAX_UINT256,
  ]) {
    await assert.rejects(
      circuit.calculateWitness(encodeInput(selector, 0n, 1n), true),
      undefined,
      `unsupported selector ${selector} must be rejected`,
    );
  }

  const witness = await circuit.calculateWitness(
    encodeInput(1n << 18n, SIGN_BIT, 0n),
    true,
  );
  await circuit.loadSymbols();
  const mutationTargets = [
    "main.out[0]",
    "main.equal",
    "main.signedLess",
    "main.basis3",
  ];
  for (const symbolName of mutationTargets) {
    const wireIndex = circuit.symbols[symbolName]?.varIdx;
    assert.notEqual(wireIndex, undefined, `${symbolName} must be present in the witness`);
    const maliciousWitness = [...witness];
    maliciousWitness[wireIndex] = BigInt(maliciousWitness[wireIndex].toString()) + 1n;
    await assert.rejects(
      circuit.checkConstraints(maliciousWitness),
      /Constraint doesn't match/,
      `${symbolName} mutation must be rejected`,
    );
  }

  console.log(
    `ALU2 passed six operations, ${boundaries.length ** 2} boundary pairs and ${RANDOM_CASES} randomized cases per operation, canonicality, selector, and mutation checks`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
