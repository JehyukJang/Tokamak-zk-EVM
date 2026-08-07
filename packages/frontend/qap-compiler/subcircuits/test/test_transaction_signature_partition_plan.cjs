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
    privateWords[8].lowCheck,
  ],
  range(privateWords, 9, 14).map(({ lowCheck }) => lowCheck),
  range(privateWords, 15, 21).map(({ lowCheck }) => lowCheck),
  range(privateWords, 22, 28).map(({ lowCheck }) => lowCheck),
];

assert.equal(bins.length, 44, "the arithmetic lower bound requires 44 fragments");

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
assert.ok(43 * LIMIT < partitionTotal, "43 fragments must be arithmetically impossible");
assert.equal(44 * LIMIT - partitionTotal, 1020);

const binTotals = bins.map((bin) => bin.reduce(
  (sum, atomId) => sum + atoms.get(atomId).constraints,
  0,
));
assert.equal(Math.max(...binTotals), 1020);

console.log(
  `Transaction signature partition plan assigns ${atoms.size} atoms once across 44 acyclic fragments at ${partitionTotal} constraints`,
);
