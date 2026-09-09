import { preprocessSnark } from "../../src/preprocess/protocol/preprocess-snark.js";
import { createCurveRuntime } from "../../src/runtime/curve/curve.js";
import { parseUnivariatePreprocessCrs, parseUnivariateProverCrs, parseUnivariateVerifierCrs } from "../../src/univariate/crs.js";
import { proveUnivariateReference } from "../../src/univariate/reference-prover.js";
import { verifyUnivariateReference } from "../../src/univariate/reference-verifier.js";
import type { UnivariateSparseMatrix, UnivariateSubcircuit } from "../../src/univariate/relation.js";

declare global {
  interface Window {
    __tokamakUnivariateReferenceResult?: BrowserReferenceResult;
  }
}

interface BrowserReferenceResult {
  readonly status: "pending" | "ok" | "error";
  readonly valid?: boolean;
  readonly timings?: readonly BrowserTiming[];
  readonly error?: string;
}

interface BrowserTiming {
  readonly label: string;
  readonly ms: number;
}

const setup = {
  l_free: 0,
  l: 1,
  l_user_out: 0,
  l_user: 0,
  l_D: 3,
  m_D: 3,
  n: 2,
  s_D: 1,
  s_max: 2,
} as const;
const selector = [0, null] as const;
const subcircuitInfos = [{
  id: 0,
  name: "public-buffer",
  Nwires: 3,
  Nconsts: 0,
  Out_idx: [],
  In_idx: [1, 1],
  flattenMap: [2, 0, 1],
  bufferDirection: "in" as const,
}];

window.__tokamakUnivariateReferenceResult = { status: "pending" };
main().catch((error: unknown) => {
  window.__tokamakUnivariateReferenceResult = {
    status: "error",
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
});

async function main(): Promise<void> {
  const timings: BrowserTiming[] = [];
  const runtime = await timed(timings, "initialize runtime", createCurveRuntime);
  try {
    const input = await timed(timings, "admit split CRS", async () => {
      const crsInput = await openCrs();
      const [preprocessCrs, proverCrs, verifierCrs] = await Promise.all([
        parseUnivariatePreprocessCrs(crsInput),
        parseUnivariateProverCrs(crsInput),
        parseUnivariateVerifierCrs(crsInput),
      ]);
      return { preprocessCrs, proverCrs, verifierCrs };
    });
    const publicInputs = [runtime.Fr.fromBigInt(5n)];
    const zeroMatrix = emptyMatrix();
    const subcircuits: readonly UnivariateSubcircuit[] = [{
      id: 0,
      flattenMap: [2, 0, 1],
      A: zeroMatrix,
      B: zeroMatrix,
      C: zeroMatrix,
    }];
    const placements = {
      subcircuitIds: Uint32Array.of(0),
      variableOffsets: Uint32Array.of(0, 3),
      variables: runtime.Fr.concat([
        runtime.Fr.zero,
        runtime.Fr.fromBigInt(5n),
        runtime.Fr.zero,
      ]),
      fieldByteLength: runtime.Fr.byteLength,
    };
    const preprocess = await timed(timings, "preprocess", () => preprocessSnark(runtime, {
      setup,
      selector,
      permutation: [],
      crs: input.preprocessCrs,
    }, { denseMsmChunkPoints: 4 }));
    const proof = await timed(timings, "prove", () => proveUnivariateReference(runtime, {
      setup,
      selector,
      permutation: [],
      placements,
      subcircuitInfos,
      subcircuits,
      publicInputs,
      crs: input.proverCrs,
      chunkPoints: 4,
    }));
    const valid = await timed(timings, "verify", () => verifyUnivariateReference(runtime, {
      setup,
      subcircuitInfos,
      selector,
      publicInputs,
      crs: input.verifierCrs,
      preprocess: [preprocess.sKappa, preprocess.sC],
      proof,
    }));
    if (!valid) throw new Error("Chromium verifier rejected the reference proof.");
    window.__tokamakUnivariateReferenceResult = { status: "ok", valid, timings };
  } finally {
    await runtime.terminate();
  }
}

function emptyMatrix(): UnivariateSparseMatrix {
  return {
    activeWires: [],
    rowOffsets: new Uint8Array(Uint32Array.of(0).buffer),
    columns: new Uint8Array(),
    coefficients: new Uint8Array(),
    rowCount: 0,
  };
}

async function openCrs() {
  return {
    manifest: await fetchJson("/fixtures/small/runtime/crs/univariate-crs-manifest.json"),
    loadChunk: (relativePath: string) => fetchBinary(`/fixtures/small/runtime/crs/${relativePath}`),
  };
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function fetchBinary(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function timed<T>(timings: BrowserTiming[], label: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await operation();
  timings.push({ label, ms: performance.now() - started });
  return result;
}
