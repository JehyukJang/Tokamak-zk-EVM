const assert = require("node:assert/strict");
const path = require("node:path");

const { wasm } = require("circom_tester");

const LIMB_BASE = 1n << 128n;
const UINT160_MAX = (1n << 160n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const split = (value) => [value % LIMB_BASE, value / LIMB_BASE];

const main = async () => {
  const packageRoot = path.join(__dirname, "../..");
  const circuit = await wasm(
    path.join(packageRoot, "subcircuits/circom/StorageAccess_circuit.circom"),
    {
      include: path.join(packageRoot, "node_modules"),
      prime: "bls12381",
      O: 2,
    },
  );

  const address = UINT160_MAX;
  const key = UINT256_MAX;
  const validInput = [address, ...split(key), address, ...split(key)];
  const witness = await circuit.calculateWitness({ in: validInput }, true);
  await circuit.checkConstraints(witness);

  for (const invalidInput of [
    [address, ...split(key), address - 1n, ...split(key)],
    [address, ...split(key), address, 0n, split(key)[1]],
    [address, ...split(key), address, split(key)[0], 0n],
  ]) {
    await assert.rejects(circuit.calculateWitness({ in: invalidInput }, true));
  }

  console.log("StorageAccess binds the current address/key to the canonical pair");
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
