const assert = require("node:assert/strict");

const LIMIT = 1024;
const MONOLITH_TOTAL = 44094;
const PRIVATE_INPUT_COUNT = 29;

const atoms = new Map();
const addAtom = (id, constraints, dependencies = []) => {
  assert.equal(atoms.has(id), false, `duplicate atom ${id}`);
  atoms.set(id, Object.freeze({ id, constraints, dependencies }));
  return id;
};

const poseidonPublicKey = addAtom("poseidon-public-key", 624);
const poseidonChallenge = Array.from({ length: 35 }, (_, index) => addAtom(
  `poseidon-challenge-${index}`,
  624,
  index === 0 ? [] : [`poseidon-challenge-${index - 1}`],
));

const privateWords = Array.from({ length: PRIVATE_INPUT_COUNT }, (_, index) => {
  const merge = addAtom(`input-${index}-merge`, 1);
  return Object.freeze({
    merge,
    lowCheck: addAtom(`input-${index}-low-check`, 129, [merge]),
    highCheck: addAtom(`input-${index}-high-check`, 128, [merge]),
    fieldBound: addAtom(`input-${index}-field-bound`, 260, [merge]),
  });
});

const contractSplit = addAtom("contract-split", 163);
const selectorView = addAtom("selector-view", 2);
const challengeCanonical = addAtom(
  "challenge-canonical",
  518,
  [poseidonChallenge.at(-1)],
);
const publicKeyHashCanonical = addAtom(
  "public-key-hash-canonical",
  518,
  [poseidonPublicKey],
);
const responseScalarBits = addAtom("response-scalar-bits", 253);
const publicKeyValid = addAtom("public-key-valid", 3);
const publicKeyCofactor = addAtom(
  "public-key-cofactor-policy",
  28,
  [publicKeyValid],
);
const randomizerValid = addAtom("randomizer-valid", 4);
const randomizerCofactor = addAtom(
  "randomizer-cofactor",
  25,
  [randomizerValid],
);
const challengeRuntimeTable = addAtom(
  "challenge-runtime-table",
  20,
  [publicKeyCofactor],
);

const fixedWindows = Array.from({ length: 84 }, (_, index) => addAtom(
  `fixed-window-${index}`,
  index === 0 ? 11 : 14,
  index === 0
    ? [responseScalarBits]
    : [responseScalarBits, `fixed-window-${index - 1}`],
));
const fixedLinearGlue = addAtom(
  "fixed-linear-glue",
  5,
  [fixedWindows.at(-1)],
);

const variableWindows = Array.from({ length: 128 }, (_, index) => addAtom(
  `variable-window-${index}`,
  index === 0 ? 12 : 30,
  index === 0
    ? [challengeCanonical, challengeRuntimeTable]
    : [
      challengeCanonical,
      challengeRuntimeTable,
      `variable-window-${index - 1}`,
    ],
));
const variableLinearGlue = addAtom(
  "variable-linear-glue",
  5,
  [variableWindows.at(-1)],
);
const terminalEquation = addAtom(
  "terminal-equation",
  11,
  [fixedLinearGlue, variableLinearGlue, randomizerCofactor],
);

const range = (values, start, endInclusive) => (
  values.slice(start, endInclusive + 1)
);
const privateValidation = (index) => [
  privateWords[index].merge,
  privateWords[index].fieldBound,
  privateWords[index].highCheck,
];

const bins = [
  [
    poseidonPublicKey,
    contractSplit,
    selectorView,
    publicKeyValid,
    publicKeyCofactor,
    randomizerValid,
    randomizerCofactor,
    challengeRuntimeTable,
    privateWords[0].merge,
    privateWords[0].lowCheck,
  ],
  [poseidonChallenge[0], responseScalarBits, ...range(fixedWindows, 0, 9)],
  [poseidonChallenge[1], ...range(fixedWindows, 10, 37)],
  [poseidonChallenge[2], ...range(fixedWindows, 38, 65)],
  [
    poseidonChallenge[3],
    ...range(fixedWindows, 66, 83),
    fixedLinearGlue,
    privateWords[1].merge,
    privateWords[1].lowCheck,
  ],
  ...Array.from({ length: 27 }, (_, offset) => [
    poseidonChallenge[offset + 4],
    ...privateValidation(offset + 2),
  ]),
  [poseidonChallenge[31], privateWords[0].fieldBound, privateWords[0].highCheck],
  [poseidonChallenge[32], privateWords[1].fieldBound, privateWords[1].highCheck],
  [
    poseidonChallenge[33],
    privateWords[2].lowCheck,
    privateWords[3].lowCheck,
    privateWords[4].lowCheck,
  ],
  [
    poseidonChallenge[34],
    privateWords[5].lowCheck,
    privateWords[6].lowCheck,
    privateWords[7].lowCheck,
  ],
  [challengeCanonical, ...range(variableWindows, 0, 16)],
  range(variableWindows, 17, 50),
  range(variableWindows, 51, 84),
  range(variableWindows, 85, 118),
  [
    ...range(variableWindows, 119, 127),
    variableLinearGlue,
    terminalEquation,
    publicKeyHashCanonical,
  ],
  range(privateWords, 8, 14).map(({ lowCheck }) => lowCheck),
  range(privateWords, 15, 21).map(({ lowCheck }) => lowCheck),
  range(privateWords, 22, 28).map(({ lowCheck }) => lowCheck),
];

const placementTopologies = [
  "initial-policy-and-hash",
  "fixed-scalar-start",
  "fixed-scalar-batch-28",
  "fixed-scalar-batch-28",
  "fixed-scalar-tail",
  ...Array(27).fill("poseidon-word-bound-high"),
  "poseidon-bound-high",
  "poseidon-bound-high",
  "poseidon-low-check-3",
  "poseidon-low-check-3",
  "variable-scalar-start",
  "variable-scalar-batch-34",
  "variable-scalar-batch-34",
  "variable-scalar-batch-34",
  "variable-scalar-tail",
  "low-check-batch-7",
  "low-check-batch-7",
  "low-check-batch-7",
];
const expectedTopologyMultiplicities = Object.freeze({
  "initial-policy-and-hash": 1,
  "fixed-scalar-start": 1,
  "fixed-scalar-batch-28": 2,
  "fixed-scalar-tail": 1,
  "poseidon-word-bound-high": 27,
  "poseidon-bound-high": 2,
  "poseidon-low-check-3": 2,
  "variable-scalar-start": 1,
  "variable-scalar-batch-34": 3,
  "variable-scalar-tail": 1,
  "low-check-batch-7": 3,
});

const poseidonWordBoundHighInterface = Object.freeze({
  inputs: Object.freeze([
    Object.freeze({ name: "previousChallengeHash", logicalType: "bls12-381-fr", physicalWires: 1 }),
    Object.freeze({ name: "challengeWord", logicalType: "bls12-381-fr", physicalWires: 1 }),
    Object.freeze({ name: "transactionInput", logicalType: "bls12-381-fr", physicalWires: 1 }),
  ]),
  outputs: Object.freeze([
    Object.freeze({
      name: "nextChallengeHash",
      logicalType: "bls12-381-fr",
      physicalWires: Object.freeze(["nextChallengeHash"]),
    }),
    Object.freeze({
      name: "transactionInputEvmWord",
      logicalType: "uint256",
      physicalWires: Object.freeze(["low128", "high128"]),
    }),
  ]),
});

const challengeWordSource = (challengeIndex) => {
  if (challengeIndex === 4) {
    return Object.freeze({ operand: "contract", operandIndex: 5 });
  }
  if (challengeIndex === 5) {
    return Object.freeze({ operand: "selector", operandIndex: 6 });
  }
  const transactionInputIndex = challengeIndex - 6;
  return Object.freeze({
    operand: `input${transactionInputIndex}`,
    operandIndex: 7 + transactionInputIndex,
  });
};

const lowCheckPlacement = (transactionInputIndex) => {
  if (transactionInputIndex <= 4) return 34;
  if (transactionInputIndex <= 7) return 35;
  if (transactionInputIndex <= 14) return 41;
  if (transactionInputIndex <= 21) return 42;
  return 43;
};

const poseidonWordBoundHighBindings = Object.freeze(Array.from(
  { length: 27 },
  (_, offset) => {
    const placement = 5 + offset;
    const challengeIndex = 4 + offset;
    const transactionInputIndex = 2 + offset;
    return Object.freeze({
      placement,
      inputs: Object.freeze({
        previousChallengeHash: Object.freeze({
          producerPlacement: placement - 1,
          challengeIndex: challengeIndex - 1,
        }),
        challengeWord: challengeWordSource(challengeIndex),
        transactionInput: Object.freeze({
          operand: `input${transactionInputIndex}`,
          operandIndex: 7 + transactionInputIndex,
        }),
      }),
      outputs: Object.freeze({
        nextChallengeHash: Object.freeze({
          challengeIndex,
          consumerPlacement: placement + 1,
        }),
        transactionInputEvmWord: Object.freeze({
          resultIndex: 2 + transactionInputIndex,
          lowCheckPlacement: lowCheckPlacement(transactionInputIndex),
        }),
      }),
    });
  },
));

assert.equal(bins.length, 44, "the arithmetic lower bound requires 44 placements");
assert.equal(placementTopologies.length, bins.length);

const assignedBin = new Map();
let partitionTotal = 0;
for (const [binIndex, bin] of bins.entries()) {
  let binTotal = 0;
  for (const atomId of bin) {
    const atom = atoms.get(atomId);
    assert.notEqual(atom, undefined, `unknown atom ${atomId}`);
    assert.equal(assignedBin.has(atomId), false, `atom ${atomId} assigned twice`);
    assignedBin.set(atomId, binIndex);
    binTotal += atom.constraints;
  }
  assert.ok(binTotal <= LIMIT, `fragment ${binIndex} has ${binTotal} constraints`);
  partitionTotal += binTotal;
}

assert.equal(assignedBin.size, atoms.size, "every atom must be assigned exactly once");
for (const atom of atoms.values()) {
  const consumerBin = assignedBin.get(atom.id);
  for (const dependency of atom.dependencies) {
    const producerBin = assignedBin.get(dependency);
    assert.notEqual(producerBin, undefined, `${atom.id} dependency ${dependency}`);
    assert.ok(
      producerBin <= consumerBin,
      `${atom.id} in ${consumerBin} precedes ${dependency} in ${producerBin}`,
    );
  }
}

const expectedPartitionTotal = MONOLITH_TOTAL - PRIVATE_INPUT_COUNT * 2;
assert.equal(partitionTotal, expectedPartitionTotal);
assert.ok(43 * LIMIT < partitionTotal, "43 placements must be arithmetically impossible");
assert.equal(44 * LIMIT - partitionTotal, 1020);

const binTotals = bins.map((bin) => bin.reduce(
  (sum, atomId) => sum + atoms.get(atomId).constraints,
  0,
));
assert.equal(Math.max(...binTotals), 1020);

const normalizeAtomRole = (atomId) => {
  if (/^poseidon-challenge-\d+$/.test(atomId)) return "poseidon-challenge";
  const privateWordMatch = atomId.match(/^input-\d+-(.+)$/);
  if (privateWordMatch !== null) return `input-${privateWordMatch[1]}`;
  if (atomId === "fixed-window-0") return "fixed-window-partial";
  if (/^fixed-window-\d+$/.test(atomId)) return "fixed-window-regular";
  if (atomId === "variable-window-0") return "variable-window-partial";
  if (/^variable-window-\d+$/.test(atomId)) return "variable-window-regular";
  return atomId;
};
const topologySignatures = bins.map((bin) => (
  bin.map(normalizeAtomRole).sort().join("|")
));
const actualTopologyMultiplicities = Object.fromEntries(
  [...new Set(placementTopologies)].map((topology) => [
    topology,
    placementTopologies.filter((candidate) => candidate === topology).length,
  ]),
);
assert.deepEqual(actualTopologyMultiplicities, expectedTopologyMultiplicities);
assert.equal(Object.keys(actualTopologyMultiplicities).length, 11);
for (const topology of Object.keys(actualTopologyMultiplicities)) {
  const totals = new Set(
    placementTopologies.flatMap((candidate, index) => (
      candidate === topology ? [binTotals[index]] : []
    )),
  );
  assert.equal(totals.size, 1, `${topology} placements must have one fixed topology`);
  const signatures = new Set(
    placementTopologies.flatMap((candidate, index) => (
      candidate === topology ? [topologySignatures[index]] : []
    )),
  );
  assert.equal(signatures.size, 1, `${topology} placements must own the same atom roles`);
}

assert.deepEqual(
  poseidonWordBoundHighInterface.inputs.map(({ name, physicalWires }) => [name, physicalWires]),
  [
    ["previousChallengeHash", 1],
    ["challengeWord", 1],
    ["transactionInput", 1],
  ],
);
assert.deepEqual(
  poseidonWordBoundHighInterface.outputs.flatMap(({ name, physicalWires }) => (
    physicalWires.map((wire) => `${name}.${wire}`)
  )),
  [
    "nextChallengeHash.nextChallengeHash",
    "transactionInputEvmWord.low128",
    "transactionInputEvmWord.high128",
  ],
);
assert.equal(poseidonWordBoundHighBindings.length, 27);
for (const [offset, binding] of poseidonWordBoundHighBindings.entries()) {
  const expectedPlacement = 5 + offset;
  const expectedChallengeIndex = 4 + offset;
  const expectedTransactionInputIndex = 2 + offset;
  assert.equal(placementTopologies[binding.placement], "poseidon-word-bound-high");
  assert.equal(binding.placement, expectedPlacement);
  assert.deepEqual(binding.inputs.previousChallengeHash, {
    producerPlacement: expectedPlacement - 1,
    challengeIndex: expectedChallengeIndex - 1,
  });
  assert.deepEqual(binding.inputs.challengeWord, challengeWordSource(expectedChallengeIndex));
  assert.deepEqual(binding.inputs.transactionInput, {
    operand: `input${expectedTransactionInputIndex}`,
    operandIndex: 7 + expectedTransactionInputIndex,
  });
  assert.notEqual(
    binding.inputs.challengeWord.operandIndex,
    binding.inputs.transactionInput.operandIndex,
    `placement ${expectedPlacement} must not conflate its packed Poseidon and EVM-view inputs`,
  );
  assert.deepEqual(binding.outputs.nextChallengeHash, {
    challengeIndex: expectedChallengeIndex,
    consumerPlacement: expectedPlacement + 1,
  });
  assert.deepEqual(binding.outputs.transactionInputEvmWord, {
    resultIndex: 2 + expectedTransactionInputIndex,
    lowCheckPlacement: lowCheckPlacement(expectedTransactionInputIndex),
  });
}
assert.deepEqual(poseidonWordBoundHighBindings[0], {
  placement: 5,
  inputs: {
    previousChallengeHash: { producerPlacement: 4, challengeIndex: 3 },
    challengeWord: { operand: "contract", operandIndex: 5 },
    transactionInput: { operand: "input2", operandIndex: 9 },
  },
  outputs: {
    nextChallengeHash: { challengeIndex: 4, consumerPlacement: 6 },
    transactionInputEvmWord: { resultIndex: 4, lowCheckPlacement: 34 },
  },
});
assert.deepEqual(poseidonWordBoundHighBindings.at(-1), {
  placement: 31,
  inputs: {
    previousChallengeHash: { producerPlacement: 30, challengeIndex: 29 },
    challengeWord: { operand: "input24", operandIndex: 31 },
    transactionInput: { operand: "input28", operandIndex: 35 },
  },
  outputs: {
    nextChallengeHash: { challengeIndex: 30, consumerPlacement: 32 },
    transactionInputEvmWord: { resultIndex: 30, lowCheckPlacement: 43 },
  },
});

console.log(
  `Transaction signature partition plan assigns ${atoms.size} atoms once across 44 acyclic placements of 11 reusable types at ${partitionTotal} constraints; P05-P31 reuse one 3-wire-input/3-wire-output interface`,
);
