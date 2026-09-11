import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeProofBytes, encodeProofBytes, decodePreprocessBytes, encodePreprocessBytes } from "./artifact-bytes.js";

const contract = JSON.parse(readFileSync(new URL("../../contracts/univariate-artifact-contract.json", import.meta.url), "utf8"));
const transcript = JSON.parse(readFileSync(new URL("../../contracts/fixtures/univariate-fiat-shamir.json", import.meta.url), "utf8"));
const bytes = new Uint8Array(1184);
// Independent existing F4 generator vector is big-endian x||y.
const point = Buffer.from(transcript.messages[0][0], "hex");
bytes.set(point.subarray(0, 48).reverse(), 0);
bytes.set(point.subarray(48).reverse(), 48);
bytes[960] = 1;
assert.deepEqual(encodeProofBytes(decodeProofBytes(bytes)), bytes);
assert.deepEqual(encodePreprocessBytes(decodePreprocessBytes(new Uint8Array(384))), new Uint8Array(384));
assert.throws(() => decodeProofBytes(bytes.subarray(1)), /length/);
assert.throws(() => decodeProofBytes(new Uint8Array(1185)), /length/);
assert.throws(() => decodePreprocessBytes(new Uint8Array(385)), /length/);
for (const [offset, modulus] of [[0, contract.encoding.baseFieldModulus], [48, contract.encoding.baseFieldModulus], [960, contract.encoding.scalarModulus]] as const) {
  const invalid = bytes.slice();
  invalid.set(Buffer.from(modulus, "hex").reverse(), offset);
  assert.throws(() => decodeProofBytes(invalid), /noncanonical/);
}
const record = decodeProofBytes(bytes);
record.c_l = new Uint8Array(95);
assert.throws(() => encodeProofBytes(record), /length/);
console.log("Common artifact binary codec tests passed.");
