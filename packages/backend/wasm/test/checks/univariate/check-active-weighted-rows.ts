import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { retainedWeightedWires } from "../../../src/prover/protocol/subcircuit-library-validation.js";
import type { SetupParams } from "../../../src/artifacts/setup/setup-params.js";
import type { ProverSubcircuitInfo } from "../../../src/prover/protocol/witness.js";

const directory = dirname(fileURLToPath(import.meta.url));
const libraryDirectory = resolve(directory, "../../../../../frontend/qap-compiler/subcircuits/library");
const synthesizerDirectory = resolve(directory, "../../../../../frontend/synthesizer/outputs");
const [setup, infos, selector] = await Promise.all([
  readJson<SetupParams>(resolve(libraryDirectory, "setupParams.json")),
  readJson<readonly ProverSubcircuitInfo[]>(resolve(libraryDirectory, "subcircuitInfo.json")),
  readJson<readonly (number | null)[]>(resolve(synthesizerDirectory, "selector.json")),
]);

const fullRows = retainedWeightedWires(setup, infos);
const currentRows = activeWeightedRows(setup, infos, selector);
assert.deepEqual(currentRows, fullRows, "The current application selector reaches every retained weighted row.");

const smallestBufferSelector = Array.from({ length: setup.s }, () => null);
smallestBufferSelector[0] = 0;
const reducedRows = activeWeightedRows(setup, infos, smallestBufferSelector);
assert(reducedRows.length < fullRows.length, "The synthetic reduced selector must expose execution-local padding.");
assertSubset(reducedRows, fullRows);

const rowsPerCommitment = (rows: readonly number[]) => rows.length * setup.s;
console.log(JSON.stringify({
  current: {
    retainedRows: fullRows.length,
    activeRows: currentRows.length,
    omittedRows: fullRows.length - currentRows.length,
    weightedMsmInputsPerCommitment: rowsPerCommitment(currentRows),
  },
  syntheticReducedSelector: {
    retainedRows: fullRows.length,
    activeRows: reducedRows.length,
    omittedRows: fullRows.length - reducedRows.length,
    weightedMsmInputsPerCommitment: rowsPerCommitment(reducedRows),
  },
}));

function activeWeightedRows(
  setupParams: SetupParams,
  subcircuits: readonly ProverSubcircuitInfo[],
  selected: readonly (number | null)[],
): readonly number[] {
  assert.equal(selected.length, setupParams.s, "Selector capacity must match setup capacity.");
  const byId = new Map(subcircuits.map(info => [info.id, info]));
  let wiringEnd = 0;
  let internalEnd = setupParams.m_b;
  for (const id of selected) {
    if (id === null || id === -1) continue;
    const info = byId.get(id);
    assert(info !== undefined, `Selector references unknown subcircuit ${id}.`);
    const [wiringStart, wiringLength] = info.Wiring_idx;
    const [internalStart, internalLength] = info.Internal_idx;
    assert.equal(wiringStart, 0, "Normalized wiring ranges must start at local wire zero.");
    assert.equal(internalStart, setupParams.m_b, "Normalized internal ranges must start at m_b.");
    wiringEnd = Math.max(wiringEnd, wiringStart + wiringLength);
    internalEnd = Math.max(internalEnd, internalStart + internalLength);
  }
  return [
    ...range(0, wiringEnd),
    ...range(setupParams.m_b, internalEnd),
  ];
}

function range(start: number, end: number): readonly number[] {
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

function assertSubset(values: readonly number[], superset: readonly number[]): void {
  const available = new Set(superset);
  for (const value of values) assert(available.has(value), `Active row ${value} is not retained by the CRS.`);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
