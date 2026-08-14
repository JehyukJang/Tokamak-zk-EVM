const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const { wasm } = require("circom_tester");
const { split256BitInteger } = require("./helper_functions.js");

const MAX_WORD = (1n << 256n) - 1n;
const MAX_OWNERSHIP = (1n << 32n) - 1n;

const shiftWord = (value, magnitude, direction) => {
  const bits = BigInt(magnitude * 8);
  return direction === 0
    ? value << bits & MAX_WORD
    : value >> bits;
};

const applyOwnership = (value, ownership) => {
  let result = 0n;
  for (let byte = 0; byte < 32; byte++) {
    if ((ownership & (1n << BigInt(byte))) !== 0n) {
      result |= value & (0xffn << BigInt(8 * byte));
    }
  }
  return result;
};

const inputFor = ({
  source,
  magnitude,
  direction,
  incomingOwnership,
  previousWord,
  previousOwnership,
  expectedFinalCoverage,
}) => [
  ...split256BitInteger(source),
  BigInt(magnitude),
  BigInt(direction),
  incomingOwnership,
  ...split256BitInteger(previousWord),
  previousOwnership,
  expectedFinalCoverage,
];

const expectedStep = ({
  source,
  magnitude,
  direction,
  incomingOwnership,
  previousWord,
  previousOwnership,
}) => ({
  nextWord: previousWord + applyOwnership(
    shiftWord(source, magnitude, direction),
    incomingOwnership,
  ),
  nextOwnership: previousOwnership + incomingOwnership,
});

const assertStep = async (circuit, vector, label) => {
  const expected = expectedStep(vector);
  const witness = await circuit.calculateWitness({ in: inputFor(vector) }, true);
  await circuit.checkConstraints(witness);
  await circuit.assertOut(witness, {
    out: [...split256BitInteger(expected.nextWord), expected.nextOwnership],
  });
  return witness;
};

const assertCompiledMetrics = (packageRoot) => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "memory-load-step-"));
  try {
    const compilation = spawnSync(
      process.env.CIRCOM_BIN || "circom",
      [
        path.join(packageRoot, "subcircuits/circom/MemoryLoadStep_circuit.circom"),
        "--r1cs",
        "--json",
        "--inspect",
        "--O2",
        "--prime",
        "bls12381",
        "-l",
        path.join(packageRoot, "node_modules"),
        "-o",
        outputDirectory,
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      compilation.status,
      0,
      `${compilation.stdout}\n${compilation.stderr}`,
    );

    const compilerOutput = `${compilation.stdout}\n${compilation.stderr}`
      .replace(/\x1b\[[0-9;]*m/g, "");
    const readMetric = (label) => {
      const match = compilerOutput.match(new RegExp(`(?:^|\\n)${label}:\\s*(\\d+)`));
      assert.notEqual(match, null, `missing compiler metric: ${label}`);
      return Number(match[1]);
    };

    assert.equal(readMetric("non-linear constraints"), 678);
    assert.equal(readMetric("linear constraints"), 1);
    assert.equal(readMetric("public inputs"), 9);
    assert.equal(readMetric("public outputs"), 3);
    assert.equal(readMetric("wires"), 618);
    assert.equal(readMetric("labels"), 728);

    const constraintsFile = JSON.parse(readFileSync(path.join(
      outputDirectory,
      "MemoryLoadStep_circuit_constraints.json",
    )));
    const constraints = constraintsFile.constraints;
    assert.equal(constraints.length, 679);
    const nonzeroCoefficients = constraints.reduce(
      (total, row) => total + row.reduce(
        (rowTotal, term) => rowTotal + Object.keys(term).length,
        0,
      ),
      0,
    );
    assert.equal(nonzeroCoefficients, 3688);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
};

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  assertCompiledMetrics(packageRoot);
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/MemoryLoadStep_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );

  const patterned = BigInt(
    `0x${Array.from({ length: 32 }, (_, index) =>
      (index * 7 + 3).toString(16).padStart(2, "0")).join("")}`,
  );
  for (const magnitude of [0, 1, 15, 16, 31]) {
    for (const direction of [0, 1]) {
      const ownership = magnitude === 31
        ? (direction === 0 ? 1n << 31n : 1n)
        : 0x80010001n;
      await assertStep(circuit, {
        source: patterned,
        magnitude,
        direction,
        incomingOwnership: ownership,
        previousWord: 0n,
        previousOwnership: 0n,
        expectedFinalCoverage: ownership,
      }, `boundary shift ${magnitude}:${direction}`);
    }
  }

  const partialCoverage = 0x0000ffffn;
  const realCoverage = 0x0000000fn;
  await assertStep(circuit, {
    source: patterned,
    magnitude: 0,
    direction: 0,
    incomingOwnership: realCoverage,
    previousWord: 0n,
    previousOwnership: 0n,
    expectedFinalCoverage: partialCoverage,
  }, "step retains real ownership");

  const first = {
    source: patterned,
    magnitude: 1,
    direction: 0,
    incomingOwnership: 0x0000ffffn,
    previousWord: 0n,
    previousOwnership: 0n,
    expectedFinalCoverage: MAX_OWNERSHIP,
  };
  const firstExpected = expectedStep(first);
  const second = {
    source: MAX_WORD ^ patterned,
    magnitude: 1,
    direction: 1,
    incomingOwnership: 0xffff0000n,
    previousWord: firstExpected.nextWord,
    previousOwnership: firstExpected.nextOwnership,
    expectedFinalCoverage: MAX_OWNERSHIP,
  };
  await assertStep(circuit, first, "first serial transition");
  const finalWitness = await assertStep(circuit, second, "final serial transition");

  const invalidVectors = [
    {
      label: "non-canonical source limb",
      input: inputFor(first).map((value, index) => index === 0 ? 1n << 128n : value),
    },
    { label: "oversized shift", input: inputFor({ ...first, magnitude: 32 }) },
    { label: "non-Boolean direction", input: inputFor({ ...first, direction: 2 }) },
    {
      label: "oversized incoming ownership",
      input: inputFor({ ...first, incomingOwnership: 1n << 32n }),
    },
    {
      label: "oversized previous ownership",
      input: inputFor({ ...first, previousOwnership: 1n << 32n }),
    },
    {
      label: "oversized expected coverage",
      input: inputFor({ ...first, expectedFinalCoverage: 1n << 32n }),
    },
    {
      label: "overlapping ownership",
      input: inputFor({
        ...first,
        incomingOwnership: 1n,
        previousOwnership: 1n,
      }),
    },
    {
      label: "real ownership outside expected coverage",
      input: inputFor({
        ...first,
        expectedFinalCoverage: first.incomingOwnership ^ 1n,
      }),
    },
    {
      label: "previous ownership outside expected coverage",
      input: inputFor({
        ...first,
        incomingOwnership: 0n,
        previousOwnership: 1n,
        expectedFinalCoverage: 0n,
      }),
    },
  ];
  for (const { label, input } of invalidVectors) {
    await assert.rejects(
      circuit.calculateWitness({ in: input }, true),
      undefined,
      label,
    );
  }

  await circuit.loadSymbols();
  const nextWordLowIndex = circuit.symbols["main.out[0]"]?.varIdx;
  assert.notEqual(nextWordLowIndex, undefined);
  const mutatedWitness = [...finalWitness];
  mutatedWitness[nextWordLowIndex] = BigInt(mutatedWitness[nextWordLowIndex]) ^ 1n;
  await assert.rejects(
    circuit.checkConstraints(mutatedWitness),
    /Constraint doesn't match/,
  );

  const composed = await wasm(
    path.join(packageRoot, "subcircuits/test/circom/memory_load_step_composed.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );
  const composedInput = [
    ...split256BitInteger(first.source),
    BigInt(first.magnitude),
    BigInt(first.direction),
    first.incomingOwnership,
    ...split256BitInteger(second.source),
    BigInt(second.magnitude),
    BigInt(second.direction),
    second.incomingOwnership,
    MAX_OWNERSHIP,
  ];
  const composedWitness = await composed.calculateWitness({ in: composedInput }, true);
  await composed.checkConstraints(composedWitness);
  const finalExpected = expectedStep(second);
  await composed.assertOut(composedWitness, {
    out: [...split256BitInteger(finalExpected.nextWord), finalExpected.nextOwnership],
  });

  const gapFirst = {
    ...first,
    incomingOwnership: 0x0000000fn,
    expectedFinalCoverage: 0x00ffffffn,
  };
  const gapFirstExpected = expectedStep(gapFirst);
  const gapSecond = {
    ...second,
    incomingOwnership: 0x00f00000n,
    previousWord: gapFirstExpected.nextWord,
    previousOwnership: gapFirstExpected.nextOwnership,
    expectedFinalCoverage: 0x00ffffffn,
  };
  const gapComposedInput = [
    ...split256BitInteger(gapFirst.source),
    BigInt(gapFirst.magnitude),
    BigInt(gapFirst.direction),
    gapFirst.incomingOwnership,
    ...split256BitInteger(gapSecond.source),
    BigInt(gapSecond.magnitude),
    BigInt(gapSecond.direction),
    gapSecond.incomingOwnership,
    gapSecond.expectedFinalCoverage,
  ];
  const gapComposedWitness = await composed.calculateWitness(
    { in: gapComposedInput },
    true,
  );
  await composed.checkConstraints(gapComposedWitness);
  const gapFinalExpected = expectedStep(gapSecond);
  await composed.assertOut(gapComposedWitness, {
    out: [
      ...split256BitInteger(gapFinalExpected.nextWord),
      gapFinalExpected.nextOwnership,
    ],
  });

  await composed.loadSymbols();
  for (const symbol of ["main.first.out[0]", "main.first.out[1]", "main.first.out[2]"]) {
    const wireIndex = composed.symbols[symbol]?.varIdx;
    assert.notEqual(wireIndex, undefined, `${symbol} must exist`);
    const serialMutation = [...composedWitness];
    serialMutation[wireIndex] = BigInt(serialMutation[wireIndex]) ^ 1n;
    await assert.rejects(
      composed.checkConstraints(serialMutation),
      /Constraint doesn't match/,
      `${symbol} substitution must fail`,
    );
  }

  console.log(
    "MemoryLoadStep passed byte-shift boundaries, local and serial sparse coverage, exact state wiring, malformed-input rejection, overlap rejection, and output mutation rejection",
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
