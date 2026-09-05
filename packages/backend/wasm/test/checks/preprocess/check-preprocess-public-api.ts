import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  BackendWasmError,
  install,
  preprocess,
} from "../../../src/preprocess/index.js";

const fixtureRoot = path.resolve("fixtures/small/runtime");

async function main(): Promise<void> {
  const [permutation, legacyPreprocessCrs] = await Promise.all([
    readBinary("permutation.bin"),
    readBinary("preprocess-crs.bin"),
  ]);

  await assertBackendError(() => preprocess({} as never), "INSTALL_REQUIRED");
  await assertBackendError(() => install({ chunkSizeExponent: 9 }), "INVALID_OPTION");
  await assertBackendError(() => install({ chunkSizeExponent: 20 }), "INVALID_OPTION");
  await assertBackendError(() => install({ chunkSizeExponent: 10.5 }), "INVALID_OPTION");
  await assertBackendError(() => install({ unsupported: true } as never), "INVALID_OPTION");

  assertInstallation(await install(), 17);
  assertInstallation(await install({ chunkSizeExponent: 18 }), 18);
  assertInstallation(await install({ chunkSizeExponent: 17 }), 17);

  await assertBackendError(
    () => preprocess({
      permutation,
      instance: new Uint8Array([1]),
      preprocessCrs: legacyPreprocessCrs,
    } as never),
    "INVALID_INPUT",
  );
  await assertBackendError(
    () => preprocess({
      selector: new Uint8Array([1]),
      permutation,
      preprocessCrs: legacyPreprocessCrs,
    }),
    "INVALID_INPUT",
  );
  await assertBackendError(
    () => preprocess({
      selector: new Uint8Array([1]),
      permutation: new Uint8Array([1]),
      preprocessCrs: legacyPreprocessCrs,
    }),
    "INVALID_INPUT",
  );

  console.log("Checked univariate preprocess public API installation and input admission");
}

async function readBinary(fileName: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path.join(fixtureRoot, fileName)));
}

async function assertBackendError(
  execute: () => Promise<unknown>,
  expectedCode: BackendWasmError["code"],
): Promise<void> {
  try {
    await execute();
  } catch (error) {
    if (error instanceof BackendWasmError && error.code === expectedCode) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected BackendWasmError code ${expectedCode}.`);
}

function assertInstallation(
  info: Awaited<ReturnType<typeof install>>,
  expectedExponent: number,
): void {
  if (info.chunkSizeExponent !== expectedExponent || info.chunkSize !== 2 ** expectedExponent) {
    throw new Error(`Expected chunk exponent ${expectedExponent}; received ${info.chunkSizeExponent}.`);
  }
}

await main();
