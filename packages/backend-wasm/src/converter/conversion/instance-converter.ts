import { createBinaryArtifactFile } from "../../artifacts/binary/binary-artifact-file.js";
import { BinaryArtifactFileKind } from "../../artifacts/binary/binary-format.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";
import { GENERATED_SETUP_PARAMS } from "../../generated/active/setup.generated.js";
import { INSTANCE_V1_SPEC } from "../../generated/browser-artifact-contracts.generated.js";
import { SYNTHESIZER_BROWSER_ARTIFACT_CONTRACT } from "../../generated/synthesizer-browser-artifact-contract.generated.js";
import { concatBytes } from "../../runtime/bytes.js";
import type { CurveRuntime } from "../../runtime/curve/curve.js";
import { isRecord, parseHexStringArray } from "./conversion-utils.js";
import { withCurveRuntime } from "./conversion-runtime.js";
import {
  requireProducerSourceField,
  requireProducerSourceFields,
} from "./producer-artifact-contract.js";

const INSTANCE_ARTIFACT_NAME = "instance";
const instanceSourceFields = requireProducerSourceFields(
  SYNTHESIZER_BROWSER_ARTIFACT_CONTRACT,
  INSTANCE_ARTIFACT_NAME,
);
const userPublicField = requireProducerSourceField(instanceSourceFields, "userPublic", INSTANCE_ARTIFACT_NAME);
const blockPublicField = requireProducerSourceField(instanceSourceFields, "blockPublic", INSTANCE_ARTIFACT_NAME);
const functionPublicField = requireProducerSourceField(instanceSourceFields, "functionPublic", INSTANCE_ARTIFACT_NAME);
const [publicInstanceSectionSpec, functionInstanceSectionSpec] = INSTANCE_V1_SPEC.sections;

interface VerifierSetupParamsJson {
  readonly l_free: number;
  readonly l_user: number;
  readonly l: number;
}

interface InstanceJson {
  readonly a_pub_user: readonly string[];
  readonly a_pub_block: readonly string[];
  readonly a_pub_function: readonly string[];
}

export async function convertInstance(instance: unknown): Promise<Uint8Array> {
  return withCurveRuntime((runtime) =>
    createInstanceArtifact(runtime, instance, BACKEND_WASM_PACKAGE_VERSION));
}

async function createInstanceArtifact(
  runtime: CurveRuntime,
  raw: unknown,
  sourcePackageVersion: string,
): Promise<Uint8Array> {
  const instance = parseInstanceJson(raw);
  const publicInstance = readPublicInstance(runtime, instance, GENERATED_SETUP_PARAMS);
  const functionInstance = readFunctionInstance(
    runtime,
    instance,
    GENERATED_SETUP_PARAMS,
  );

  return createBinaryArtifactFile({
    kind: BinaryArtifactFileKind.Instance,
    sourcePackageVersion,
    sections: [
      {
        ...publicInstanceSectionSpec,
        elementCount: publicInstance.length,
        elementByteLength: runtime.Fr.byteLength,
        data: concatBytes(publicInstance),
      },
      {
        ...functionInstanceSectionSpec,
        elementCount: functionInstance.length,
        elementByteLength: runtime.Fr.byteLength,
        data: concatBytes(functionInstance),
      },
    ],
  });
}

function readPublicInstance(
  runtime: CurveRuntime,
  instance: InstanceJson,
  setup: VerifierSetupParamsJson,
): readonly Uint8Array[] {
  const publicInstance = [
    ...instance.a_pub_user.slice(0, setup.l_user),
    ...instance.a_pub_block.slice(0, setup.l_free - setup.l_user),
  ];

  if (publicInstance.length !== setup.l_free) {
    throw new Error("Verifier public instance length does not match setupParams.l_free.");
  }

  return publicInstance.map((value) => runtime.Fr.fromHex(value));
}

function readFunctionInstance(
  runtime: CurveRuntime,
  instance: InstanceJson,
  setup: VerifierSetupParamsJson,
): readonly Uint8Array[] {
  const expectedLength = setup.l - setup.l_free;
  if (instance.a_pub_function.length !== expectedLength) {
    throw new Error(
      `Function instance length must equal setupParams.l - setupParams.l_free (${expectedLength}).`,
    );
  }

  return instance.a_pub_function.map((value) => runtime.Fr.fromHex(value));
}

function parseInstanceJson(raw: unknown): InstanceJson {
  if (!isRecord(raw)) {
    throw new Error("Instance JSON must be an object.");
  }

  return {
    a_pub_user: parseHexStringArray(raw[userPublicField], `instance.${userPublicField}`),
    a_pub_block: parseHexStringArray(raw[blockPublicField], `instance.${blockPublicField}`),
    a_pub_function: parseHexStringArray(raw[functionPublicField], `instance.${functionPublicField}`),
  };
}
