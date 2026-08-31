import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";
import { chromium } from "playwright";
import { startIsolatedFileServer } from "../../support/browser/static-file-server.js";

const OUTPUT_DIR = "tmp/browser/prover";
const BUNDLE_PATH = path.join(OUTPUT_DIR, "prover-entry.js");
const DEFAULT_TIMEOUT_MS = 1_800_000;
type ProverExecutionMode = "one-call" | "staged";
type ProverPhase =
  | "preparing"
  | "arithmetic"
  | "copy"
  | "binding"
  | "finalizing"
  | "completed";
const EXPECTED_STAGED_PHASES: readonly ProverPhase[] = [
  "preparing",
  "arithmetic",
  "copy",
  "binding",
  "finalizing",
  "completed",
];

async function main(): Promise<void> {
  const releaseBuild = process.env.BACKEND_WASM_BROWSER_RELEASE_BUILD === "true";
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await build({
    entryPoints: ["test/browser/prover-entry.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: BUNDLE_PATH,
    sourcemap: false,
    minify: releaseBuild,
    plugins: releaseBuild ? [releaseEntrypointPlugin()] : [],
  });

  const timeoutMs = parseTimeoutMs(process.env.BACKEND_WASM_BROWSER_PROVER_TIMEOUT_MS);
  const mode = parseExecutionMode(process.env.BACKEND_WASM_BROWSER_PROVER_MODE);
  const server = await startIsolatedFileServer(resolveFile);

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error") {
        errors.push(text);
        return;
      }
      console.log(`[browser:${message.type()}] ${text}`);
    });

    await page.goto(`${server.origin}/browser/prover.html?mode=${mode}`, {
      waitUntil: "networkidle",
    });
    const result = await page.waitForFunction(() => {
      return window.__tokamakProverResult?.status !== "pending" ? window.__tokamakProverResult : undefined;
    }, undefined, { timeout: timeoutMs });
    const value = await result.jsonValue() as BrowserProverResult;

    if (value.status !== "ok" || value.valid !== true) {
      throw new Error(`Browser prover failed: ${value.error ?? JSON.stringify(value)}.`);
    }

    if (errors.length > 0) {
      throw new Error(`Browser prover emitted console/page errors:\n${errors.join("\n")}`);
    }

    if (value.mode !== mode) {
      throw new Error(`Browser prover reported mode '${value.mode}' instead of '${mode}'.`);
    }
    assertObservedPhases(value, mode);
    printTimings(value);
    await writeBenchmarkResult(value, releaseBuild, browser.version());
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(`Checked ${mode} prover proof generation and verifier acceptance in Chromium`);
}

function releaseEntrypointPlugin(): Plugin {
  return {
    name: "release-entrypoints",
    setup(buildContext) {
      buildContext.onResolve(
        { filter: /^\.\.\/\.\.\/src\/(prover|verifier)\/index\.js$/ },
        (args) => ({
          path: path.resolve(
            path.dirname(args.importer),
            "../../dist",
            args.path.includes("/prover/") ? "prover" : "verifier",
            "index.js",
          ),
        }),
      );
    },
  };
}

async function writeBenchmarkResult(
  result: BrowserProverResult,
  releaseBuild: boolean,
  browserVersion: string,
): Promise<void> {
  const outputPath = process.env.BACKEND_WASM_BROWSER_RESULT_PATH;
  if (outputPath === undefined || outputPath.trim() === "") {
    return;
  }

  const resolvedOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeFile(
    resolvedOutputPath,
    `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      browserVersion,
      releaseBuild,
      result,
    }, null, 2)}\n`,
  );
}

interface BrowserProverResult {
  readonly status: "pending" | "ok" | "error";
  readonly mode?: ProverExecutionMode;
  readonly valid?: boolean;
  readonly proofBytes?: number;
  readonly phases?: readonly ProverPhase[];
  readonly timings?: readonly BrowserTiming[];
  readonly error?: string;
}

interface BrowserTiming {
  readonly label: string;
  readonly ms: number;
}

function resolveFile(pathname: string): string | undefined {
  if (pathname === "/browser/prover.html") {
    return "test/browser/prover.html";
  }
  if (pathname === "/browser/prover-entry.js") {
    return BUNDLE_PATH;
  }
  return pathname.startsWith("/fixtures/") ? pathname.slice(1) : undefined;
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`BACKEND_WASM_BROWSER_PROVER_TIMEOUT_MS must be a positive integer: ${raw}`);
  }

  return value;
}

function parseExecutionMode(raw: string | undefined): ProverExecutionMode {
  if (raw === undefined || raw === "" || raw === "one-call") {
    return "one-call";
  }
  if (raw === "staged") {
    return raw;
  }
  throw new Error(`BACKEND_WASM_BROWSER_PROVER_MODE must be 'one-call' or 'staged': ${raw}`);
}

function assertObservedPhases(result: BrowserProverResult, mode: ProverExecutionMode): void {
  const expected = mode === "staged" ? EXPECTED_STAGED_PHASES : [];
  const actual = result.phases ?? [];
  if (
    actual.length !== expected.length
    || actual.some((phase, index) => phase !== expected[index])
  ) {
    throw new Error(
      `Browser prover phase sequence mismatch: expected ${expected.join(" -> ") || "(none)"}, `
        + `got ${actual.join(" -> ") || "(none)"}.`,
    );
  }
}

function printTimings(result: BrowserProverResult): void {
  console.log(`Browser prover (${result.mode}) generated ${result.proofBytes ?? 0} proof bytes.`);
  if (result.phases !== undefined) {
    console.log(`Observed prover phases: ${result.phases.join(" -> ")}`);
  }
  for (const timing of result.timings ?? []) {
    console.log(`${timing.label}: ${formatDuration(timing.ms)}`);
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds.toFixed(0)} ms`;
  }

  return `${(milliseconds / 1000).toFixed(2)} s`;
}

const entrypoint = fileURLToPath(import.meta.url);

if (process.argv[1] === entrypoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Browser prover check failed: ${message}`);
    process.exitCode = 1;
  });
}
