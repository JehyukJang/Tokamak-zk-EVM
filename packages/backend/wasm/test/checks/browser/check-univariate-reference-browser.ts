import { rm } from "node:fs/promises";

import { build } from "esbuild";
import { chromium } from "playwright";

import { startIsolatedFileServer } from "../../support/browser/static-file-server.js";

const OUTPUT_DIR = "tmp/browser/univariate-reference";
const BUNDLE_PATH = `${OUTPUT_DIR}/entry.js`;

interface BrowserReferenceResult {
  readonly status: "pending" | "ok" | "error";
  readonly valid?: boolean;
  readonly timings?: readonly { readonly label: string; readonly ms: number }[];
  readonly error?: string;
}

await rm(OUTPUT_DIR, { recursive: true, force: true });
await build({
  entryPoints: ["test/browser/univariate-reference-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: BUNDLE_PATH,
});
const server = await startIsolatedFileServer((pathname) => {
  if (pathname === "/browser/reference.html") return "test/browser/prover.html";
  if (pathname === "/browser/prover-entry.js") return BUNDLE_PATH;
  return pathname.startsWith("/fixtures/") ? pathname.slice(1) : undefined;
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${server.origin}/browser/reference.html`, { waitUntil: "networkidle" });
  const handle = await page.waitForFunction(
    () => window.__tokamakUnivariateReferenceResult?.status !== "pending"
      ? window.__tokamakUnivariateReferenceResult
      : undefined,
    undefined,
    { timeout: 120_000 },
  );
  const result = await handle.jsonValue() as BrowserReferenceResult;
  if (result.status !== "ok" || result.valid !== true) {
    throw new Error(`Browser reference workflow failed: ${result.error ?? JSON.stringify(result)}.`);
  }
  if (errors.length > 0) throw new Error(`Browser workflow emitted errors:\n${errors.join("\n")}`);
  for (const timing of result.timings ?? []) console.log(`${timing.label}: ${timing.ms.toFixed(2)} ms`);
} finally {
  await browser.close();
  await server.close();
}
console.log("Checked latest-protocol split-CRS preprocess -> prove -> verify in Chromium");
