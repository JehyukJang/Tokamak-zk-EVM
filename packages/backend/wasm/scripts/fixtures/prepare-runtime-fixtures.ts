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
import { GENERATED_SETUP_PARAMS } from "../../src/generated/active/setup.generated.js";
import { GENERATED_PROVER_SUBCIRCUIT_INFOS } from "../../src/prover/generated/active/subcircuit-library.generated.js";
import type { ProverSubcircuitInfo } from "../../src/prover/protocol/witness.js";
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
  validateFixtureStructure(instance, placementVariables, permutation);

  const payloadDecoder = await loadCombinedSigmaPayloadDecoder();
  const crs = await convertCombinedSigmaRkyvToCrsBinaries(
    await readBinary(path.join(sourceRoot, "setup", "combined_sigma.rkyv")),
    {
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      decoder: createCombinedSigmaRkyvPayloadDecoder(payloadDecoder.decodeCombinedSigmaPayload),
      setup: GENERATED_SETUP_PARAMS,
    },
  );
  const outputs: Readonly<Record<string, Uint8Array>> = {
    "witness.bin": await convertWitness(
      placementVariables,
    ),
    "permutation.bin": await convertPermutation(
      permutation,
    ),
    "instance.bin": await convertInstance(instance),
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

function validateFixtureStructure(
  instance: unknown,
  placementVariables: unknown,
  permutation: unknown,
): void {
  const instanceRecord = requireRecord(instance, "instance");
  assertArrayLength(instanceRecord.a_pub_user, GENERATED_SETUP_PARAMS.l_user, "instance.a_pub_user");
  assertArrayLength(
    instanceRecord.a_pub_block,
    GENERATED_SETUP_PARAMS.l_free - GENERATED_SETUP_PARAMS.l_user,
    "instance.a_pub_block",
  );
  assertArrayLength(
    instanceRecord.a_pub_function,
    GENERATED_SETUP_PARAMS.l - GENERATED_SETUP_PARAMS.l_free,
    "instance.a_pub_function",
  );

  if (!Array.isArray(placementVariables)) {
    throw new Error("placementVariables must be an array.");
  }
  if (placementVariables.length > GENERATED_SETUP_PARAMS.s_max) {
    throw new Error(
      `placementVariables length ${placementVariables.length} exceeds setupParams.s_max ${GENERATED_SETUP_PARAMS.s_max}.`,
    );
  }
  const subcircuitsById = new Map<number, ProverSubcircuitInfo>(
    GENERATED_PROVER_SUBCIRCUIT_INFOS.map(
      (subcircuit): [number, ProverSubcircuitInfo] => [subcircuit.id, subcircuit],
    ),
  );
  placementVariables.forEach((rawPlacement, index) => {
    const placement = requireRecord(rawPlacement, `placementVariables[${index}]`);
    const subcircuitId = requireNonNegativeInteger(
      placement.subcircuitId,
      `placementVariables[${index}].subcircuitId`,
    );
    const subcircuit = subcircuitsById.get(subcircuitId);
    if (subcircuit === undefined) {
      throw new Error(`placementVariables[${index}] references unknown subcircuit ${subcircuitId}.`);
    }
    assertArrayLength(
      placement.variables,
      subcircuit.Nwires,
      `placementVariables[${index}].variables`,
    );
  });

  if (!Array.isArray(permutation)) {
    throw new Error("permutation must be an array.");
  }
  const rowLimit = GENERATED_SETUP_PARAMS.l_D - GENERATED_SETUP_PARAMS.l;
  permutation.forEach((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `permutation[${index}]`);
    assertBoundedInteger(entry.row, rowLimit, `permutation[${index}].row`);
    assertBoundedInteger(entry.X, rowLimit, `permutation[${index}].X`);
    assertBoundedInteger(entry.col, GENERATED_SETUP_PARAMS.s_max, `permutation[${index}].col`);
    assertBoundedInteger(entry.Y, GENERATED_SETUP_PARAMS.s_max, `permutation[${index}].Y`);
  });
}

function assertArrayLength(value: unknown, expected: number, label: string): void {
  if (!Array.isArray(value) || value.length !== expected) {
    const actual = Array.isArray(value) ? value.length : "not an array";
    throw new Error(`${label} length ${actual} does not match expected ${expected}.`);
  }
}

function assertBoundedInteger(value: unknown, upperBound: number, label: string): void {
  const integer = requireNonNegativeInteger(value, label);
  if (integer >= upperBound) {
    throw new Error(`${label} ${integer} is outside [0, ${upperBound}).`);
  }
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

const entrypoint = fileURLToPath(import.meta.url);

if (process.argv[1] === entrypoint) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Runtime fixture preparation failed: ${message}`);
    process.exitCode = 1;
  });
}
