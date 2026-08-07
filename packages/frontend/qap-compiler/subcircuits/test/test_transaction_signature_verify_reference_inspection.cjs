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
      "--O2",
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
    assert.match(output, /non-linear constraints: 29615\b/);
    assert.match(output, /linear constraints: 3\b/);
    assert.match(output, /public inputs: 5\b/);
    assert.match(output, /private inputs: 34\b/);
    assert.match(output, /public outputs: 64\b/);
    assert.match(output, /wires: 29559\b/);
    assert.match(output, /labels: 75506\b/);

    const expectedWarnings = [
      {
        classification: "internally-constrained range-proof output",
        text: "StrictBls12381FieldBoundFromLimbs_unsafe()\": Array of subcomponent input/output signals highDifference.out contains a total of 127 signals",
      },
      {
        classification: "internally-constrained range-proof output",
        text: "StrictBls12381FieldBoundFromLimbs_unsafe()\": Array of subcomponent input/output signals lowDifference.out contains a total of 128 signals",
      },
      {
        classification: "redundant valid extended-point coordinate",
        text: "ExtendedJubjubDouble_unsafe()\": Local signal point[3] does not appear in any constraint",
      },
      {
        classification: "redundant valid extended-point coordinate",
        text: "ExtendedJubjubToAffine_unsafe()\": Local signal point[3] does not appear in any constraint",
      },
      {
        classification: "unused non-hash Poseidon state output",
        text: "Poseidon255(2)\": Array of subcomponent input/output signals m[63].out contains a total of 2 signals",
      },
      {
        classification: "redundant valid extended-point coordinate",
        text: "AssertExtendedJubjubEqual_unsafe()\": Local signal lhs[3] does not appear in any constraint",
      },
      {
        classification: "redundant valid extended-point coordinate",
        text: "AssertExtendedJubjubEqual_unsafe()\": Local signal rhs[3] does not appear in any constraint",
      },
      {
        classification: "canonical hash bits outside the 160-bit origin",
        text: "TransactionSignatureVerifyReference(29)\": Array of subcomponent input/output signals canonicalPublicKeyHash.bits contains a total of 95 signals",
      },
    ];

    assert.equal(
      output.match(/warning\[CA0[12]\]/g)?.length,
      expectedWarnings.length,
      output,
    );
    for (const { classification, text } of expectedWarnings) {
      assert.equal(
        output.includes(text),
        true,
        `missing approved ${classification} warning: ${text}`,
      );
    }

    const symbols = readFileSync(
      path.join(
        outputDirectory,
        "transaction_signature_verify_reference_test.sym",
      ),
      "utf8",
    );
    const expectedInterfaceWires = [
      [1, "main.evmContractAddress[0]"],
      [2, "main.evmContractAddress[1]"],
      [3, "main.evmFunctionSelector[0]"],
      [4, "main.evmFunctionSelector[1]"],
      ...Array.from(
        { length: 29 },
        (_, inputIndex) => [
          [5 + inputIndex * 2, `main.evmTransactionInputs[${inputIndex}][0]`],
          [6 + inputIndex * 2, `main.evmTransactionInputs[${inputIndex}][1]`],
        ],
      ).flat(),
      [63, "main.origin[0]"],
      [64, "main.origin[1]"],
      [65, "main.contractAddress"],
      [66, "main.functionSelector"],
      [67, "main.S"],
      [68, "main.O[0]"],
      [69, "main.O[1]"],
      ...Array.from(
        { length: 5 },
        (_, inputIndex) => [70 + inputIndex, `main.privateIn[${inputIndex}]`],
      ),
    ];
    for (const [wireIndex, signalName] of expectedInterfaceWires) {
      assert.match(
        symbols,
        new RegExp(`^\\d+,${wireIndex},\\d+,${escapeRegExp(signalName)}$`, "m"),
      );
    }
    for (let inputIndex = 5; inputIndex < 34; inputIndex++) {
      assert.match(
        symbols,
        new RegExp(`^\\d+,-1,\\d+,${escapeRegExp(`main.privateIn[${inputIndex}]`)}$`, "m"),
      );
    }

    console.log(
      "Transaction signature reference inspection matched the O2 constraint graph, substitutions, and approved warning inventory",
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
};

main();
