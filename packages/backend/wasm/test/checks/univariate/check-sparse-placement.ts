import assert from "node:assert/strict";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import type { SparseRowDotInput } from "../../../src/runtime/field/field-types.js";

const runtime = await createCurveRuntime();
try {
  const f = runtime.Fr, u32 = (xs: number[]) => new Uint8Array(Uint32Array.from(xs).buffer);
  const matrix = (rows: number, seed: number): SparseRowDotInput => {
    const offsets = [0], columns: number[] = [], coefficients = [];
    for (let row = 0; row < rows; row++) {
      for (let j = 0; j < row % 4; j++) { columns.push((row * 7 + j) % 64); coefficients.push(f.fromBigInt(BigInt(seed + j))); }
      offsets.push(columns.length);
    }
    return { rowOffsets: u32(offsets), columns: u32(columns), coefficients: f.concat(coefficients), variables: f.concat(Array.from({ length: 64 }, (_, i) => f.fromBigInt(BigInt(i + 1)))), rowCount: rows };
  };
  const control = async (inputs: readonly SparseRowDotInput[]) => {
    const outputs = [];
    for (const x of inputs) outputs.push(await f.sparseRowDotBuffer(x.rowOffsets, x.columns, x.coefficients, x.variables, x.rowCount));
    return outputs;
  };
  assert.deepEqual(await f.sparseRowDotBatchBuffer([]), []);
  for (const rows of [0, 1, 17, 1024]) {
    const inputs = [matrix(rows, 3), matrix(Math.ceil(rows / 2), 7), matrix(rows, 11)];
    const expected = await control(inputs); assert.deepEqual(await f.sparseRowDotBatchBuffer(inputs), expected);
    for (let m = 0; m < inputs.length; m++) {
      const x = inputs[m]!, offsets = new Uint32Array(x.rowOffsets.buffer), columns = new Uint32Array(x.columns.buffer);
      for (let row = 0; row < x.rowCount; row++) {
        let sum = f.zero;
        for (let j = offsets[row]!; j < offsets[row + 1]!; j++) sum = f.add(sum, f.mul(f.readBufferElement(x.coefficients, j), f.readBufferElement(x.variables, columns[j]!)));
        assert.deepEqual(f.readBufferElement(expected[m]!, row), sum);
      }
    }
    if (rows === 1024) {
      const samples = [];
      for (let i = 0; i < 5; i++) for (const batched of i % 2 ? [true, false] : [false, true]) {
        const start = performance.now(); let result;
        for (let placement = 0; placement < 207; placement++) result = await (batched ? f.sparseRowDotBatchBuffer(inputs) : control(inputs));
        samples.push({ candidate: batched, ms: performance.now() - start }); assert.deepEqual(result, expected);
      }
      console.log(JSON.stringify({ rows: inputs.map(x => x.rowCount), placements: 207, samples }));
    }
    await assert.rejects(() => f.sparseRowDotBatchBuffer([{ ...inputs[0]!, rowOffsets: new Uint8Array(0) }]));
    await assert.rejects(() => f.sparseRowDotBatchBuffer([{ ...inputs[0]!, columns: new Uint8Array(1) }]));
    await assert.rejects(() => f.sparseRowDotBatchBuffer([{ ...inputs[0]!, coefficients: new Uint8Array(31) }]));
  }
} finally { await runtime.terminate(); }
console.log("Checked placement-batched sparse rows, scalar oracle, empty/unequal rows, zeros and malformed input.");
