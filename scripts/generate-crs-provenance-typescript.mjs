import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "versioning", "crs-provenance.ts");
const targets = [
  path.join(root, "packages", "cli", "src", "generated", "crs-provenance.generated.ts"),
  path.join(root, "packages", "backend-wasm", "src", "generated", "crs-provenance.generated.ts"),
];
const check = process.argv.includes("--check");
const contents = await fs.readFile(source, "utf8");
for (const target of targets) {
  if (check) {
    if ((await fs.readFile(target, "utf8").catch(() => "")) === contents) continue;
    throw new Error(`Generated CRS provenance contract is stale: ${target}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}
