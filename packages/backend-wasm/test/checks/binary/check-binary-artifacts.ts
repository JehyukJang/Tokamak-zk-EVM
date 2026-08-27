import { fileURLToPath } from "node:url";

import {
  INSTANCE_V1_SPEC,
  PREPROCESS_CRS_V1_SPEC,
  PROVER_CRS_V1_SPEC,
  SIGMA_VERIFY_V1_SPEC,
  VERIFIER_PREPROCESS_V1_SPEC,
  VERIFIER_PROOF_V1_SPEC,
} from "../../../src/generated/browser-artifact-contracts.generated.js";
import {
  BinaryArtifactFileKind,
  BinarySectionEncoding,
  BinarySectionType,
  type BinarySectionInput,
} from "../../../src/artifacts/binary/binary-format.js";
import {
  createBinaryArtifactFile,
  decodeBinaryArtifactFile,
} from "../../../src/artifacts/binary/binary-artifact-file.js";
import { admitRuntimeBinaryArtifact } from "../../../src/artifacts/binary/runtime-admission.js";
import { loadNamedArtifactPoints } from "../../../src/artifacts/specs/format-spec-loader.js";
import {
  createCurveRuntime,
  type CurveRuntime,
} from "../../../src/runtime/curve/curve.js";
import { inspectBinary } from "../../../src/converter/conversion/binary-inspection.js";
import { validateBinary } from "../../../src/converter/index.js";
import { assertJsonEqual as assertEqual } from "../../support/assertions.js";
import { concatBytes } from "../../support/bytes.js";

async function main(): Promise<void> {
  await checkSelfDigestPolicy();
  await checkRuntimeStructuralAdmission();
  const runtime = await createCurveRuntime();

  try {
    await checkSigmaVerifyArtifact(runtime);
    await checkVerifierPreprocessArtifact(runtime);
    await checkProverCrsArtifact(runtime);
    await checkPreprocessCrsArtifact();
  } finally {
    await runtime.terminate();
  }

  console.log("Checked production runtime artifact formats");
}

async function checkRuntimeStructuralAdmission(): Promise<void> {
  const validInstance = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.Instance,
    sourcePackageVersion: "0.0.0",
    sections: [
      instanceSection("instance.public", 1),
      instanceSection("instance.function", 1),
    ],
  });
  admitRuntimeBinaryArtifact(validInstance, BinaryArtifactFileKind.Instance, INSTANCE_V1_SPEC);

  const wrongMagic = validInstance.slice();
  wrongMagic[0] ^= 1;
  assertThrows(() => admitRuntimeBinaryArtifact(wrongMagic, BinaryArtifactFileKind.Instance, INSTANCE_V1_SPEC), "magic mismatch");

  const wrongKind = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.VerifierProof,
    sourcePackageVersion: "0.0.0",
    sections: [instanceSection("instance.public", 1), instanceSection("instance.function", 1)],
  });
  assertThrows(() => admitRuntimeBinaryArtifact(wrongKind, BinaryArtifactFileKind.Instance, INSTANCE_V1_SPEC), "kind mismatch");

  const duplicate = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.Instance,
    sourcePackageVersion: "0.0.0",
    sections: [instanceSection("instance.public", 1), instanceSection("instance.public", 1)],
  });
  assertThrows(() => admitRuntimeBinaryArtifact(duplicate, BinaryArtifactFileKind.Instance, INSTANCE_V1_SPEC), "exactly one");

  const wrongProofShape = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.VerifierProof,
    sourcePackageVersion: "0.0.0",
    sections: [
      {
        type: BinarySectionType.Proof,
        encoding: BinarySectionEncoding.FfjsG1Affine96,
        label: "proof.g1",
        elementCount: 18,
        elementByteLength: 96,
        data: new Uint8Array(18 * 96),
      },
      {
        type: BinarySectionType.Proof,
        encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
        label: "proof.evals",
        elementCount: 4,
        elementByteLength: 32,
        data: new Uint8Array(4 * 32),
      },
    ],
  });
  assertThrows(() => admitRuntimeBinaryArtifact(wrongProofShape, BinaryArtifactFileKind.VerifierProof, VERIFIER_PROOF_V1_SPEC), "element count mismatch");
}

function instanceSection(label: string, elementCount: number): BinarySectionInput {
  return {
    type: BinarySectionType.Instance,
    encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
    label,
    elementCount,
    elementByteLength: 32,
    data: new Uint8Array(elementCount * 32),
  };
}

async function checkSelfDigestPolicy(): Promise<void> {
  const binary = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.Instance,
    sourcePackageVersion: "0.0.0",
    sections: [
      {
        type: BinarySectionType.Instance,
        encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
        label: "instance.public",
        elementCount: 128,
        elementByteLength: 32,
        data: new Uint8Array(128 * 32),
      },
      {
        type: BinarySectionType.Instance,
        encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
        label: "instance.function",
        elementCount: 600,
        elementByteLength: 32,
        data: new Uint8Array(600 * 32),
      },
    ],
  });
  const artifactFile = await decodeBinaryArtifactFile(binary);
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);

  assertEqual(view.getUint16(54, true), 1, "self digest entry count");
  assertEqual(artifactFile.selfDigest.byteLength, 32, "self digest byte length");
  const inspection = await inspectBinary(binary);
  assertEqual(inspection.selfDigestHex.length, 64, "inspected self digest hex length");
  assertEqual("digests" in inspection, false, "obsolete digest collection");
  assertEqual("digestHex" in inspection.sections[0], false, "obsolete section digest");
  await validateBinary(binary);

  const corrupted = binary.slice();
  corrupted[artifactFile.sections[0].byteOffset] ^= 1;
  await assertRejects(
    () => validateBinary(corrupted),
    "validateBinary could not process its input.",
    "Binary artifact self digest mismatch.",
  );
}

async function checkSigmaVerifyArtifact(runtime: CurveRuntime): Promise<void> {
  const binary = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.VerifierCrs,
    sourcePackageVersion: "0.0.0",
    sections: [
      {
        type: BinarySectionType.CrsG1,
        encoding: BinarySectionEncoding.FfjsG1Affine96,
        label: "sigma.g1",
        elementCount: 4,
        elementByteLength: 96,
        data: concatBytes([runtime.G1.generator, runtime.G1.generator, runtime.G1.generator, runtime.G1.generator]),
      },
      {
        type: BinarySectionType.CrsG2,
        encoding: BinarySectionEncoding.FfjsG2Affine192,
        label: "sigma.g2",
        elementCount: 10,
        elementByteLength: 192,
        data: concatBytes(
          Array.from({ length: 10 }, () => runtime.G2.generator),
        ),
      },
    ],
  });
  const artifactFile = await decodeBinaryArtifactFile(binary);
  await validateBinary(binary);
  const sigma = loadNamedArtifactPoints(artifactFile, SIGMA_VERIFY_V1_SPEC);

  assertEqual(artifactFile.sections.length, 2, "sigma_verify section count");
  assertEqual(sigma.G.byteLength, 96, "sigma_verify G byte length");
  assertEqual(sigma["sigma2.y"].byteLength, 192, "sigma_verify sigma2.y byte length");
}

async function checkVerifierPreprocessArtifact(runtime: CurveRuntime): Promise<void> {
  const binary = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.VerifierPreprocess,
    sourcePackageVersion: "0.0.0",
    sections: [
      {
        type: BinarySectionType.Preprocess,
        encoding: BinarySectionEncoding.FfjsG1Affine96,
        label: "preprocess.g1",
        elementCount: 3,
        elementByteLength: 96,
        data: concatBytes([runtime.G1.generator, runtime.G1.generator, runtime.G1.generator]),
      },
    ],
  });
  const artifactFile = await decodeBinaryArtifactFile(binary);
  await validateBinary(binary);
  const preprocess = loadNamedArtifactPoints(artifactFile, VERIFIER_PREPROCESS_V1_SPEC);

  assertEqual(artifactFile.sections.length, 1, "verifier_preprocess section count");
  assertEqual(preprocess.s0.byteLength, 96, "verifier_preprocess s0 byte length");
  assertEqual(preprocess.O_pub_fix.byteLength, 96, "verifier_preprocess O_pub_fix byte length");
}

async function checkProverCrsArtifact(runtime: CurveRuntime): Promise<void> {
  const binary = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.ProverCrs,
    sourcePackageVersion: "0.0.0",
    sections: [
      createRepeatedG1Section(runtime, "sigma.g1", BinarySectionType.CrsG1, 6),
      createRepeatedG1Section(runtime, "sigma1.xy-powers", BinarySectionType.CrsG1, 2),
      createRepeatedG1Section(runtime, "sigma1.gamma-inv-o-inst", BinarySectionType.CrsG1, 1),
      createRepeatedG1Section(runtime, "sigma1.eta-inv-li-o-inter-alpha4-kj", BinarySectionType.CrsG1, 1),
      createRepeatedG1Section(runtime, "sigma1.delta-inv-li-o-prv", BinarySectionType.CrsG1, 1),
      createRepeatedG1Section(runtime, "sigma1.delta-inv-alphak-xh-tx", BinarySectionType.CrsG1, 9),
      createRepeatedG1Section(runtime, "sigma1.delta-inv-alpha4-xj-tx", BinarySectionType.CrsG1, 2),
      createRepeatedG1Section(runtime, "sigma1.delta-inv-alphak-yi-ty", BinarySectionType.CrsG1, 12),
      {
        type: BinarySectionType.CrsG2,
        encoding: BinarySectionEncoding.FfjsG2Affine192,
        label: "sigma.g2",
        elementCount: 10,
        elementByteLength: 192,
        data: concatBytes(Array.from({ length: 10 }, () => runtime.G2.generator)),
      },
    ],
  });
  const artifactFile = await decodeBinaryArtifactFile(binary);
  await validateBinary(binary);
  const proverCrs = loadNamedArtifactPoints(artifactFile, PROVER_CRS_V1_SPEC);

  assertEqual(artifactFile.sections.length, 9, "prover_crs section count");
  assertEqual(proverCrs.G.byteLength, 96, "prover_crs G byte length");
  assertEqual(proverCrs["sigma1.delta"].byteLength, 96, "prover_crs sigma1.delta byte length");
  assertEqual(proverCrs["sigma2.y"].byteLength, 192, "prover_crs sigma2.y byte length");
}

async function checkPreprocessCrsArtifact(): Promise<void> {
  const binary = await createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.PreprocessCrs,
    sourcePackageVersion: "0.0.0",
    sections: [
      {
        type: BinarySectionType.CrsG1,
        encoding: BinarySectionEncoding.FfjsG1Affine96,
        label: "sigma1.xy-powers",
        elementCount: 1_048_576,
        elementByteLength: 96,
        data: new Uint8Array(1_048_576 * 96),
      },
      {
        type: BinarySectionType.CrsG1,
        encoding: BinarySectionEncoding.FfjsG1Affine96,
        label: "sigma1.gamma-inv-o-inst",
        elementCount: 600,
        elementByteLength: 96,
        data: new Uint8Array(600 * 96),
      },
    ],
  });
  const artifactFile = await decodeBinaryArtifactFile(binary);
  await validateBinary(binary);
  loadNamedArtifactPoints(artifactFile, PREPROCESS_CRS_V1_SPEC);

  assertEqual(artifactFile.sections.length, 2, "preprocess_crs section count");
  assertEqual(
    artifactFile.sections[0].elementCount,
    1_048_576,
    "preprocess_crs xy-powers point count",
  );
  assertEqual(
    artifactFile.sections[1].elementCount,
    600,
    "preprocess_crs gamma point count",
  );
}

function createRepeatedG1Section(
  runtime: CurveRuntime,
  label: string,
  type: BinarySectionType,
  elementCount: number,
): BinarySectionInput {
  return {
    type,
    encoding: BinarySectionEncoding.FfjsG1Affine96,
    label,
    elementCount,
    elementByteLength: 96,
    data: concatBytes(Array.from({ length: elementCount }, () => runtime.G1.generator)),
  };
}

async function assertRejects(
  operation: () => Promise<unknown>,
  expectedMessage: string,
  expectedCauseMessage?: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === expectedMessage) {
      if (expectedCauseMessage !== undefined) {
        const cause = error instanceof Error && "cause" in error ? error.cause : undefined;
        const causeMessage = cause instanceof Error ? cause.message : String(cause);
        if (causeMessage !== expectedCauseMessage) {
          throw new Error(`Expected cause '${expectedCauseMessage}', got '${causeMessage}'.`);
        }
      }
      return;
    }
    throw new Error(
      `Expected '${expectedMessage}', got '${message}'.`,
    );
  }
  throw new Error(`Expected operation to reject with '${expectedMessage}'.`);
}

function assertThrows(operation: () => unknown, expectedMessageFragment: string): void {
  try {
    operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessageFragment)) {
      return;
    }
    throw new Error(`Expected an error containing '${expectedMessageFragment}', got '${message}'.`);
  }
  throw new Error(`Expected an error containing '${expectedMessageFragment}'.`);
}

const entrypoint = fileURLToPath(import.meta.url);

if (process.argv[1] === entrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Binary artifact check failed: ${message}`);
    process.exitCode = 1;
  });
}
