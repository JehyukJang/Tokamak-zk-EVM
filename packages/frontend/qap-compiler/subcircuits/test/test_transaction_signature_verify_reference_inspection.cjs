const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const stripAnsi = (value) => value.replace(
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-9;]*m/g,
  "",
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const main = () => {
  const packageRoot = path.join(__dirname, "../..");
  const outputDirectory = mkdtempSync(
    path.join(tmpdir(), "tokamak-transaction-signature-inspect-"),
  );

  try {
    const result = spawnSync("circom", [
      path.join(
        packageRoot,
        "subcircuits/test/circom/transaction_signature_verify_reference_test.circom",
      ),
      "--r1cs",
      "--sym",
      "--inspect",
      "--O1",
      "--prime",
      "bls12381",
      "-l",
      path.join(packageRoot, "node_modules"),
      "-o",
      outputDirectory,
    ], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`);

    assert.equal(result.status, 0, output);
    assert.match(output, /non-linear constraints: 30077\b/);
    assert.match(output, /linear constraints: 14321\b/);
    assert.match(output, /public inputs: 10\b/);
    assert.match(output, /private inputs: 68\b/);
    assert.match(output, /public outputs: 2\b/);
    assert.match(output, /wires: 44346\b/);
    assert.match(output, /labels: 68368\b/);

    const expectedWarnings = [
      "StrictBls12381FieldBoundFromLimbs_unsafe()\": Array of subcomponent input/output signals highDifference.out contains a total of 127 signals",
      "StrictBls12381FieldBoundFromLimbs_unsafe()\": Array of subcomponent input/output signals lowDifference.out contains a total of 128 signals",
      "CanonicalPrivateFieldWord()\": Array of subcomponent input/output signals highBits.out contains a total of 127 signals",
      "CanonicalPrivateFieldWord()\": Array of subcomponent input/output signals lowBits.out contains a total of 128 signals",
      "ExtendedJubjubDouble_unsafe()\": Local signal point[3] does not appear in any constraint",
      "ExtendedJubjubToAffine_unsafe()\": Local signal point[3] does not appear in any constraint",
      "Poseidon255(2)\": Array of subcomponent input/output signals m[63].out contains a total of 2 signals",
      "AssertExtendedJubjubEqual_unsafe()\": Local signal lhs[3] does not appear in any constraint",
      "AssertExtendedJubjubEqual_unsafe()\": Local signal rhs[3] does not appear in any constraint",
      "TransactionSignatureVerifyReference(29)\": Array of subcomponent input/output signals canonicalPublicKeyHash.bits contains a total of 95 signals",
    ];

    assert.equal(
      output.match(/warning\[CA0[12]\]/g)?.length,
      expectedWarnings.length,
      output,
    );
    for (const warning of expectedWarnings) {
      assert.equal(
        output.includes(warning),
        true,
        `missing approved inspection warning: ${warning}`,
      );
    }

    const symbols = readFileSync(
      path.join(
        outputDirectory,
        "transaction_signature_verify_reference_test.sym",
      ),
      "utf8",
    );
    const expectedPublicWires = [
      [1, "main.origin[0]"],
      [2, "main.origin[1]"],
      [3, "main.contractAddress[0]"],
      [4, "main.contractAddress[1]"],
      [5, "main.functionSelector[0]"],
      [6, "main.functionSelector[1]"],
      [7, "main.S[0]"],
      [8, "main.S[1]"],
      [9, "main.O[0][0]"],
      [10, "main.O[0][1]"],
      [11, "main.O[1][0]"],
      [12, "main.O[1][1]"],
    ];
    for (const [wireIndex, signalName] of expectedPublicWires) {
      assert.match(
        symbols,
        new RegExp(`^\\d+,${wireIndex},\\d+,${escapeRegExp(signalName)}$`, "m"),
      );
    }

    console.log(
      "Transaction signature reference inspection matched the frozen constraint graph and approved warning inventory",
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
};

main();
