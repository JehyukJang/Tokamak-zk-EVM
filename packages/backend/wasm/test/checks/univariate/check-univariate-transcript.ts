import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import { CanonicalTranscriptEncoder, UnivariateTranscript } from "../../../src/univariate/transcript.js";

interface Fixture {
  readonly schemaId: string;
  readonly context: { readonly library: string; readonly instance: number };
  readonly messageBlocks: readonly { readonly index: number; readonly value: string }[];
  readonly challenges: { readonly beta: string; readonly gammaC: string; readonly theta: string };
}

const fixture = JSON.parse(
  await readFile(new URL("../../../../common/contracts/fixtures/univariate-fiat-shamir.v1.json", import.meta.url), "utf8"),
) as Fixture;
assert.equal(fixture.schemaId, "tokamak-zk-evm-univariate-fs-v1");

const runtime = await createCurveRuntime();
try {
  const context = new CanonicalTranscriptEncoder()
    .bytes("library", new TextEncoder().encode(fixture.context.library))
    .scalar("instance", runtime.Fr, runtime.Fr.fromBigInt(BigInt(fixture.context.instance)))
    .finish();
  const transcript = new UnivariateTranscript(runtime.Fr, context);
  transcript.appendMessageBlock(fixture.messageBlocks[0]!.index, new TextEncoder().encode(fixture.messageBlocks[0]!.value));
  assert.equal(runtime.Fr.toHex(transcript.challenge(1, 0)), fixture.challenges.beta);
  assert.equal(runtime.Fr.toHex(transcript.challenge(1, 1)), fixture.challenges.gammaC);
  transcript.appendMessageBlock(fixture.messageBlocks[1]!.index, new TextEncoder().encode(fixture.messageBlocks[1]!.value));
  assert.equal(runtime.Fr.toHex(transcript.challenge(2, 0)), fixture.challenges.theta);
} finally {
  await runtime.terminate();
}

console.log("Checked univariate Keccak Fiat--Shamir fixture parity");
