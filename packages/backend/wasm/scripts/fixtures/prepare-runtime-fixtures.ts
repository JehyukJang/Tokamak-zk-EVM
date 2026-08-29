import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  convertInstance,
  convertPermutation,
  convertProof,
  convertVerifierPreprocess,
  convertWitness,
} from "../../src/converter/index.js";
import {
  convertCombinedSigmaRkyvToCrsBinaries,
  createCombinedSigmaRkyvPayloadDecoder,
} from "../../src/converter/conversion/rkyv-to-binary.js";
import { decodeBinaryArtifactFile } from "../../src/artifacts/binary/binary-artifact-file.js";
import { GENERATED_SETUP_PARAMS } from "../../src/generated/active/setup.generated.js";
import { GENERATED_PROVER_SUBCIRCUIT_INFOS } from "../../src/prover/generated/active/subcircuit-library.generated.js";
import { loadProverRuntimeWitnessInputParts } from "../../src/prover/api/binary-input.js";
import { loadPreprocessInputFromBinaryInput } from "../../src/preprocess/api/binary-input.js";
import { validateProverPlacements } from "../../src/prover/protocol/witness.js";
import { createCurveRuntime } from "../../src/runtime/curve/curve.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../src/version.js";
import { loadCombinedSigmaPayloadDecoder } from "../../tools/rkyv-decoder-wasm/src/node.js";
import { resolveFixtureWorkDirectory } from "./fixture-paths.js";

interface CopyManifest {
  readonly schemaVersion: 2;
  readonly suite: string;
  readonly workDirectory: string;
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length !== 1) {
    throw new Error("Usage: prepare-runtime-fixtures <copy-manifest.json>");
  }

  const manifestPath = path.resolve(argv[0]);
  const manifestDirectory = path.dirname(manifestPath);
  const backendWasmRoot = path.resolve(manifestDirectory, "../..");
  const repositoryRoot = path.resolve(backendWasmRoot, "../../..");
  const manifest = parseCopyManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const sourceRoot = resolveFixtureWorkDirectory(
    repositoryRoot,
    backendWasmRoot,
    manifest.workDirectory,
  );
  const runtimeRoot = path.join(backendWasmRoot, "fixtures", manifest.suite, "runtime");
  const instance = await readJson(path.join(sourceRoot, "synthesizer", "instance.json"));
  const placementVariables = await readJson(
    path.join(sourceRoot, "synthesizer", "placementVariables.json"),
  );
  const permutation = await readJson(path.join(sourceRoot, "synthesizer", "permutation.json"));
  const payloadDecoder = await loadCombinedSigmaPayloadDecoder();
  const crs = await convertCombinedSigmaRkyvToCrsBinaries(
    await readBinary(path.join(sourceRoot, "setup", "combined_sigma.rkyv")),
    {
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      decoder: createCombinedSigmaRkyvPayloadDecoder(payloadDecoder.decodeCombinedSigmaPayload),
      setup: GENERATED_SETUP_PARAMS,
    },
  );
  const witness = await convertWitness(placementVariables);
  const permutationArtifact = await convertPermutation(permutation);
  const instanceArtifact = await convertInstance(instance);
  await validateFixtureRuntimeInputs({
    witness,
    permutation: permutationArtifact,
    instance: instanceArtifact,
    preprocessCrs: crs.preprocessCrs,
  });
  const outputs: Readonly<Record<string, Uint8Array>> = {
    "witness.bin": witness,
    "permutation.bin": permutationArtifact,
    "instance.bin": instanceArtifact,
    "prover-crs.bin": crs.proverCrs,
    "preprocess-crs.bin": crs.preprocessCrs,
    "verifier-crs.bin": crs.verifierCrs,
    "proof.bin": await convertProof({
      sourceFormat: "json",
      proof: await readJson(path.join(sourceRoot, "prove", "proof.json")),
    }),
    "verifier-preprocess.bin": await convertVerifierPreprocess(
      await readJson(path.join(sourceRoot, "preprocess", "preprocess.json")),
    ),
  };

  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(runtimeRoot, { recursive: true });
  await Promise.all(Object.entries(outputs).map(([fileName, bytes]) =>
    writeFile(path.join(runtimeRoot, fileName), bytes),
  ));
}

async function validateFixtureRuntimeInputs(input: {
  readonly witness: Uint8Array;
  readonly permutation: Uint8Array;
  readonly instance: Uint8Array;
  readonly preprocessCrs: Uint8Array;
}): Promise<void> {
  const runtime = await createCurveRuntime();
  try {
    await loadPreprocessInputFromBinaryInput(runtime, {
      permutation: input.permutation,
      instance: input.instance,
      preprocessCrs: input.preprocessCrs,
    });
    const [placementVariables, permutation, instance] = await Promise.all([
      decodeBinaryArtifactFile(input.witness),
      decodeBinaryArtifactFile(input.permutation),
      decodeBinaryArtifactFile(input.instance),
    ]);
    const witnessParts = loadProverRuntimeWitnessInputParts(runtime, {
      placementVariables,
      permutation,
      instance,
    });
    validateProverPlacements(
      witnessParts.placementVariables,
      GENERATED_PROVER_SUBCIRCUIT_INFOS,
      GENERATED_SETUP_PARAMS,
    );
  } finally {
    await runtime.terminate();
  }
}

function parseCopyManifest(raw: unknown): CopyManifest {
  if (!isRecord(raw)) {
    throw new Error("Copy manifest must be a JSON object.");
  }

  if (raw.schemaVersion !== 2) {
    throw new Error("Copy manifest schemaVersion must be 2.");
  }

  if (typeof raw.suite !== "string" || raw.suite.trim() === "") {
    throw new Error("Copy manifest suite must be a non-empty string.");
  }

  if (typeof raw.workDirectory !== "string" || raw.workDirectory.trim() === "" || path.isAbsolute(raw.workDirectory)) {
    throw new Error("Copy manifest workDirectory must be a non-empty relative path.");
  }

  return {
    schemaVersion: 2,
    suite: raw.suite,
    workDirectory: path.normalize(raw.workDirectory),
  };
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read copied fixture source ${filePath}: ${message}`);
  }
}

async function readBinary(filePath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(filePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read copied fixture source ${filePath}: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const entrypoint = fileURLToPath(import.meta.url);

if (process.argv[1] === entrypoint) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Runtime fixture preparation failed: ${message}`);
    process.exitCode = 1;
  });
}
