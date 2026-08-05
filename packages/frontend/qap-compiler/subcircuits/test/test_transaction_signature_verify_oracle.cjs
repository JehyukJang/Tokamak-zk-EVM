const assert = require("node:assert/strict");

const { jubjub } = require("@noble/curves/misc.js");

const {
  CHALLENGE_INPUT_COUNT,
  DISPOSITIONS,
  MESSAGE_WORD_COUNT,
  POLICY,
  SCALAR_ORDER,
  createTransactionSignatureCorpus,
  evaluateCompleteStatement,
  getChallengeInputs,
} = require("./transaction_signature_verify_oracle.cjs");

const LIMB_BASE = 1n << 128n;

const clonePublicBoundary = ({ contractAddress, functionSelector, S, O }) => ({
  contractAddress: [...contractAddress],
  functionSelector: [...functionSelector],
  S: [...S],
  O: O.map((word) => [...word]),
});

const main = () => {
  const corpus = createTransactionSignatureCorpus();
  const ids = new Set();
  const dispositionCounts = new Map();

  assert.equal(
    POLICY.equation,
    "[8S]G = [8]R + [8h]A",
    "the oracle must state the selected cofactor-8 equation",
  );
  assert.equal(
    POLICY.contractAddressRange,
    "delegated-public-0<=contract<2^160",
  );
  assert.equal(
    POLICY.functionSelectorRange,
    "delegated-public-0<=selector<2^32",
  );
  assert.equal(
    POLICY.identityEncoding,
    "delegated-public-O=[[0,0],[1,0]]",
  );

  for (const vector of corpus) {
    assert.equal(ids.has(vector.id), false, `duplicate corpus id ${vector.id}`);
    ids.add(vector.id);
    assert.equal(
      vector.messageWords.length,
      MESSAGE_WORD_COUNT,
      `${vector.id} message length`,
    );
    assert.equal(
      getChallengeInputs(vector).length,
      CHALLENGE_INPUT_COUNT,
      `${vector.id} challenge length`,
    );
    assert.deepEqual(
      [
        vector.publicBoundary.contractAddress,
        vector.publicBoundary.functionSelector,
        vector.publicBoundary.S,
        ...vector.publicBoundary.O,
      ].map((word) => word.length),
      [2, 2, 2, 2, 2],
      `${vector.id} raw public boundary shape`,
    );

    const actual = evaluateCompleteStatement(vector);
    assert.equal(
      actual.circuit.accepted,
      vector.expected.circuit,
      `${vector.id} circuit ownership: ${actual.circuit.reason}`,
    );
    assert.equal(
      actual.delegatedPublic.accepted,
      vector.expected.delegatedPublic,
      `${vector.id} delegated ownership: ${actual.delegatedPublic.reason}`,
    );
    assert.equal(
      actual.accepted,
      vector.expected.complete,
      `${vector.id} complete statement`,
    );

    dispositionCounts.set(
      vector.disposition,
      (dispositionCounts.get(vector.disposition) ?? 0) + 1,
    );
  }

  for (const disposition of Object.values(DISPOSITIONS)) {
    assert.ok(
      (dispositionCounts.get(disposition) ?? 0) > 0,
      `corpus must contain ${disposition}`,
    );
  }

  const supported = corpus.find(({ id }) => id === "valid-supported-signer");
  assert.equal(supported.source, "tokamak-l2js-eddsaSign");

  const mixedOrder = corpus.find(
    ({ id }) => id === "valid-mixed-order-public-key",
  );
  assert.equal(mixedOrder.publicKey.isSmallOrder(), false);
  assert.equal(mixedOrder.publicKey.isTorsionFree(), false);

  const smallOrderRandomizer = corpus.find(
    ({ id }) => id === "valid-nonidentity-small-order-randomizer",
  );
  assert.equal(smallOrderRandomizer.randomizer.isSmallOrder(), true);
  assert.equal(
    smallOrderRandomizer.randomizer.equals(jubjub.Point.ZERO),
    false,
  );

  const delegated = corpus.find(
    ({ id }) => id === "delegate-s-plus-n-rejection",
  );
  assert.ok(delegated.signature >= SCALAR_ORDER);
  assert.equal(evaluateCompleteStatement(delegated).circuit.accepted, true);
  assert.equal(
    evaluateCompleteStatement(delegated).delegatedPublic.accepted,
    false,
  );

  const oversizedContract = corpus.find(
    ({ id }) => id === "delegate-oversized-contract-address-rejection",
  );
  assert.equal(evaluateCompleteStatement(oversizedContract).circuit.accepted, true);
  assert.equal(
    evaluateCompleteStatement(oversizedContract).delegatedPublic.reason,
    "contract-address-range",
  );

  const oversizedSelector = corpus.find(
    ({ id }) => id === "delegate-oversized-function-selector-rejection",
  );
  assert.equal(evaluateCompleteStatement(oversizedSelector).circuit.accepted, true);
  assert.equal(
    evaluateCompleteStatement(oversizedSelector).delegatedPublic.reason,
    "function-selector-range",
  );

  const nonCanonicalSignature = corpus.find(
    ({ id }) => id === "delegate-noncanonical-signature-limb-rejection",
  );
  assert.equal(evaluateCompleteStatement(nonCanonicalSignature).circuit.accepted, true);
  assert.equal(
    evaluateCompleteStatement(nonCanonicalSignature).delegatedPublic.reason,
    "public-limb-range",
  );

  const aliasedIdentity = corpus.find(
    ({ id }) => id === "delegate-aliased-identity-encoding-rejection",
  );
  assert.equal(evaluateCompleteStatement(aliasedIdentity).circuit.accepted, true);
  assert.equal(
    evaluateCompleteStatement(aliasedIdentity).delegatedPublic.reason,
    "identity-binding",
  );

  const valid = corpus.find(({ id }) => id === "valid-deterministic-subgroup");
  const publicWordPaths = [
    ["contractAddress"],
    ["functionSelector"],
    ["S"],
    ["O", 0],
    ["O", 1],
  ];
  for (const path of publicWordPaths) {
    for (let limbIndex = 0; limbIndex < 2; limbIndex++) {
      const publicBoundary = clonePublicBoundary(valid.publicBoundary);
      const word = path.length === 1
        ? publicBoundary[path[0]]
        : publicBoundary[path[0]][path[1]];
      word[limbIndex] = LIMB_BASE;
      assert.equal(
        evaluateCompleteStatement({ ...valid, publicBoundary }).delegatedPublic.reason,
        "public-limb-range",
        `${path.join(".")} limb ${limbIndex} range`,
      );
    }
  }

  const zeroSignature = corpus.find(
    ({ id }) => id === "reject-zero-signature",
  );
  assert.doesNotThrow(() => evaluateCompleteStatement(zeroSignature));

  console.log(
    `Transaction signature oracle passed ${corpus.length} deterministic policy vectors`,
  );
};

main();
