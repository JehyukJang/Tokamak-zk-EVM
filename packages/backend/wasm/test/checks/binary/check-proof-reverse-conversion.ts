import { fileURLToPath } from "node:url";

import { createBinaryArtifactFile } from "../../../src/artifacts/binary/binary-artifact-file.js";
import {
  BINARY_FILE_KIND_TABLE_BYTES,
  BINARY_HEADER_BYTES,
  BINARY_VERSION_TABLE_BYTES,
  expectedElementByteLength,
  type BinarySectionInput,
} from "../../../src/artifacts/binary/binary-format.js";
import { BackendWasmError, convertProof } from "../../../src/converter/index.js";
import { VERIFIER_PROOF_V1_SPEC } from "../../../src/generated/browser-artifact-contracts.generated.js";
import { assertEqual } from "../../support/assertions.js";

async function main(): Promise<void> {
  const valid = await createProofBinary();
  await assertReverseConversionSucceeds(valid, "valid proof");

  const selfDigestCorrupted = valid.slice();
  selfDigestCorrupted[selfDigestOffset()] ^= 1;
  await assertReverseConversionSucceeds(selfDigestCorrupted, "self-digest-corrupted proof");

  const wrongMagic = valid.slice();
  wrongMagic[0] ^= 1;
  await assertInvalidInput(() => reverseConvert(wrongMagic), "magic mutation");

  const wrongTable = valid.slice();
  new DataView(wrongTable.buffer, wrongTable.byteOffset, wrongTable.byteLength).setUint32(40, 0, true);
  await assertInvalidInput(() => reverseConvert(wrongTable), "section-table mutation");

  const sections = proofSections();
  await assertInvalidInput(
    () => reverseConvert(createProofBinary([sections[0], ...sections])),
    "duplicate required section",
  );
  await assertInvalidInput(
    () => reverseConvert(createProofBinary([
      ...sections,
      { ...sections[0], label: "proof.g1.unexpected" },
    ])),
    "unexpected section",
  );
  await assertInvalidInput(
    () => reverseConvert(createProofBinary([
      sectionWithCount(sections[0], sections[0].elementCount + 1),
      sections[1],
    ])),
    "fixed-cardinality mutation",
  );

  console.log("Checked public proof reverse-conversion structural admission");
}

async function reverseConvert(proof: Uint8Array | Promise<Uint8Array>): Promise<unknown> {
  return convertProof({ sourceFormat: "binary", proof: await proof });
}

async function assertReverseConversionSucceeds(proof: Uint8Array, label: string): Promise<void> {
  const converted = await reverseConvert(proof) as {
    readonly proof_entries_part1?: readonly unknown[];
    readonly proof_entries_part2?: readonly unknown[];
  };
  assertEqual(converted.proof_entries_part1?.length, 38, `${label} G1 coordinate count`);
  assertEqual(converted.proof_entries_part2?.length, 42, `${label} combined coordinate and evaluation count`);
}

async function assertInvalidInput(operation: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!(error instanceof BackendWasmError)) {
      throw new Error(`${label} did not return BackendWasmError.`);
    }
    assertEqual(error.code, "INVALID_INPUT", `${label} error code`);
    assertEqual(error.message, "convertProof could not process its input.", `${label} error message`);
    return;
  }
  throw new Error(`${label} was accepted by proof reverse conversion.`);
}

async function createProofBinary(sections: readonly BinarySectionInput[] = proofSections()): Promise<Uint8Array> {
  return createBinaryArtifactFile({
    kind: VERIFIER_PROOF_V1_SPEC.kind,
    sourcePackageVersion: "0.0.0",
    sections,
  });
}

function proofSections(): readonly BinarySectionInput[] {
  return VERIFIER_PROOF_V1_SPEC.sections.map((section) => {
    if (section.elementCount === null) {
      throw new Error(`Verifier proof section '${section.label}' must have a fixed element count.`);
    }
    const elementByteLength = section.elementByteLength ?? expectedElementByteLength(section.encoding);
    if (elementByteLength === undefined) {
      throw new Error(`Verifier proof section '${section.label}' must have a runtime-ready encoding.`);
    }
    return {
      type: section.type,
      encoding: section.encoding,
      label: section.label,
      elementCount: section.elementCount,
      elementByteLength,
      data: new Uint8Array(section.elementCount * elementByteLength),
    };
  });
}

function sectionWithCount(section: BinarySectionInput, elementCount: number): BinarySectionInput {
  return {
    ...section,
    elementCount,
    data: new Uint8Array(elementCount * section.elementByteLength),
  };
}

function selfDigestOffset(): number {
  return BINARY_HEADER_BYTES + BINARY_FILE_KIND_TABLE_BYTES + BINARY_VERSION_TABLE_BYTES + 8;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
