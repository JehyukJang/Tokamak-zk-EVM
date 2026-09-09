import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import {
  buildConnectionCopyFactors,
  buildConnectionPermutationPolynomial,
  buildConnectionWireLift,
  buildArithmeticWireLift,
  buildWitnessMaps,
  type UnivariateSparseMatrix,
  type UnivariateSubcircuit,
} from "../../../src/univariate/relation.js";
import { arithmeticIndex, connectionIndex, deriveUnivariateDomainShape } from "../../../src/univariate/domain.js";

interface RelationFixture {
  readonly setup: {
    readonly l_free: number;
    readonly l: number;
    readonly l_user_out: number;
    readonly l_user: number;
    readonly l_D: number;
    readonly m_D: number;
    readonly n: number;
    readonly s_D: number;
    readonly s_max: number;
  };
  readonly selector: readonly (number | null)[];
  readonly subcircuits: readonly {
    readonly id: number;
    readonly flattenMap: readonly number[];
    readonly aActiveWires: readonly number[];
    readonly bActiveWires: readonly number[];
    readonly cActiveWires: readonly number[];
    readonly aRows: readonly (readonly (readonly [number, number])[])[];
    readonly bRows: readonly (readonly (readonly [number, number])[])[];
    readonly cRows: readonly (readonly (readonly [number, number])[])[];
  }[];
  readonly witnessesBySlot: readonly ({ readonly subcircuitId: number; readonly values: readonly number[] } | null)[];
  readonly permutation: readonly { readonly row: number; readonly col: number; readonly X: number; readonly Y: number }[];
  readonly expected: {
    readonly uA: readonly number[];
    readonly vA: readonly number[];
    readonly wA: readonly number[];
    readonly bC: number;
    readonly u6LocalWire: number;
    readonly connectionLocalWire: number;
  };
}

const fixture = JSON.parse(
  await readFile(new URL("../../../../common/contracts/fixtures/univariate-relation.v1.json", import.meta.url), "utf8"),
) as RelationFixture;
const runtime = await createCurveRuntime();
const field = runtime.Fr;
const setup = fixture.setup;
const domain = deriveUnivariateDomainShape(field, setup);

function u32(values: readonly number[]): Uint8Array {
  return new Uint8Array(Uint32Array.from(values).buffer);
}

function matrix(
  activeWires: readonly number[],
  rows: readonly (readonly (readonly [number, number])[])[],
): UnivariateSparseMatrix {
  const rowOffsets = [0];
  const columns: number[] = [];
  const coefficients: ReturnType<typeof field.fromBigInt>[] = [];
  for (const row of rows) {
    for (const [compactIndex, coefficient] of row) {
      columns.push(compactIndex);
      coefficients.push(field.fromBigInt(BigInt(coefficient)));
    }
    rowOffsets.push(columns.length);
  }
  return {
    activeWires,
    rowOffsets: u32(rowOffsets),
    columns: u32(columns),
    coefficients: field.concat(coefficients),
    rowCount: rows.length,
  };
}

const subcircuits: readonly UnivariateSubcircuit[] = fixture.subcircuits.map((subcircuit) => ({
  id: subcircuit.id,
  flattenMap: subcircuit.flattenMap,
  A: matrix(subcircuit.aActiveWires, subcircuit.aRows),
  B: matrix(subcircuit.bActiveWires, subcircuit.bRows),
  C: matrix(subcircuit.cActiveWires, subcircuit.cRows),
}));
const witnessesBySlot = fixture.witnessesBySlot.map((witness) => witness === null
  ? null
  : {
      subcircuitId: witness.subcircuitId,
      values: field.concat(witness.values.map((value) => field.fromBigInt(BigInt(value)))),
    });
const maps = await buildWitnessMaps(
  field,
  domain,
  setup,
  fixture.selector,
  witnessesBySlot,
  subcircuits,
);

assert.ok(field.eq(
  field.readBufferElement(maps.uA.evaluations, arithmeticIndex(domain, setup, 0, 0, 0)),
  field.fromBigInt(BigInt(fixture.expected.uA[0]!)),
));
assert.ok(field.eq(
  field.readBufferElement(maps.uA.evaluations, arithmeticIndex(domain, setup, 0, 0, 1)),
  field.fromBigInt(BigInt(fixture.expected.uA[1]!)),
));

const uLift = await buildArithmeticWireLift(
  field,
  domain,
  setup,
  0,
  subcircuits[0]!,
  fixture.expected.u6LocalWire,
  "A",
);
assert.ok(field.eq(
  field.readBufferElement(uLift.evaluations, arithmeticIndex(domain, setup, 0, 0, 0)),
  field.zero,
));
assert.ok(field.eq(
  field.readBufferElement(uLift.evaluations, arithmeticIndex(domain, setup, 0, 0, 1)),
  field.one,
));
const bLift = await buildConnectionWireLift(
  field,
  domain,
  setup,
  0,
  subcircuits[0]!,
  fixture.expected.connectionLocalWire,
);
assert.ok(field.eq(
  field.readBufferElement(bLift.evaluations, connectionIndex(setup, 0, 0)),
  field.one,
));
assert.ok(field.eq(
  field.readBufferElement(maps.vA.evaluations, arithmeticIndex(domain, setup, 0, 0, 0)),
  field.fromBigInt(BigInt(fixture.expected.vA[0]!)),
));
assert.ok(field.eq(
  field.readBufferElement(maps.bC.evaluations, connectionIndex(setup, 0, 0)),
  field.fromBigInt(BigInt(fixture.expected.bC)),
));

const sC = await buildConnectionPermutationPolynomial(field, domain, setup, fixture.selector, fixture.permutation);
assert.ok(field.eq(
  field.readBufferElement(sC.evaluations, connectionIndex(setup, 0, 0)),
  field.pow(domain.connectionRoot, connectionIndex(setup, 1, 1)),
));
assert.ok(field.eq(
  field.readBufferElement(sC.evaluations, connectionIndex(setup, 1, 1)),
  field.one,
));

const [fC, gC] = await buildConnectionCopyFactors(
  field,
  maps.bC,
  sC,
  field.fromBigInt(7n),
  field.fromBigInt(11n),
);
assert.equal(field.bufferElementCount(fC), domain.connectionSize);
assert.equal(field.bufferElementCount(gC), domain.connectionSize);

await assert.rejects(
  buildConnectionPermutationPolynomial(field, domain, setup, fixture.selector, [
    { row: 0, col: 0, X: 0, Y: 1 },
  ]),
  /more than one source/,
);

await runtime.terminate();
console.log("Checked univariate witness maps, permutation interpolation, and copy factors");
