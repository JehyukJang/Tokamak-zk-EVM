import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import {
  UNIVARIATE_FIAT_SHAMIR_SCHEMA_ID,
  UnivariateTranscript,
} from "../../../src/univariate/transcript.js";

interface Fixture {
  readonly schemaId: string;
  readonly publicInputs: readonly string[];
  readonly messageBlocks: readonly { readonly index: number; readonly value: string }[];
  readonly challenges: {
    readonly upsilon: string;
    readonly beta: string;
    readonly gammaC: string;
    readonly theta: string;
  };
}

const fixture = JSON.parse(
  await readFile(new URL("../../../../common/contracts/fixtures/univariate-fiat-shamir.v3.json", import.meta.url), "utf8"),
) as Fixture;
assert.equal(fixture.schemaId, UNIVARIATE_FIAT_SHAMIR_SCHEMA_ID);

const runtime = await createCurveRuntime();
try {
  const publicInputs = fixture.publicInputs.map(value => runtime.Fr.fromBigInt(BigInt(value)));
  const transcript = new UnivariateTranscript(runtime.Fr, publicInputs);
  transcript.appendMessageBlock(fixture.messageBlocks[0]!.index, new TextEncoder().encode(fixture.messageBlocks[0]!.value));
  assert.equal(runtime.Fr.toHex(transcript.challenge(1, 0)), fixture.challenges.upsilon);
  const [beta, gammaC] = transcript.challengePair(2);
  assert.equal(runtime.Fr.toHex(beta), fixture.challenges.beta);
  assert.equal(runtime.Fr.toHex(gammaC), fixture.challenges.gammaC);
  transcript.appendMessageBlock(fixture.messageBlocks[1]!.index, new TextEncoder().encode(fixture.messageBlocks[1]!.value));
  assert.equal(runtime.Fr.toHex(transcript.challenge(3, 0)), fixture.challenges.theta);
} finally {
  await runtime.terminate();
}

console.log("Checked univariate Keccak Fiat--Shamir fixture parity");
