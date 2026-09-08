import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCurveRuntime } from "../../../src/runtime/curve/curve.js";
import {
  arithmeticComplementAt,
  arithmeticIndex,
  arithmeticVanishingAt,
  connectionComplementAt,
  connectionIndex,
  connectionVanishingAt,
  deriveUnivariateDomainShape,
  intersectionVanishingAt,
  unionVanishingAt,
} from "../../../src/univariate/domain.js";
import {
  arithmeticCosetSelector,
  connectionCosetSelector,
  evaluateStridedPolynomial,
  placementSelectorPolynomial,
} from "../../../src/univariate/selectors.js";

interface DomainFixture {
  readonly setup: {
    readonly l: number;
    readonly l_D: number;
    readonly n: number;
    readonly s_D: number;
    readonly s_max: number;
  };
  readonly expected: {
    readonly t: number;
    readonly N_A: number;
    readonly N_C: number;
    readonly N_G: number;
    readonly N_union: number;
    readonly D: number;
    readonly arithmeticIndex: number;
    readonly connectionIndex: number;
  };
}

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../common/contracts/fixtures/univariate-domain-shape.v1.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as { readonly cases: readonly DomainFixture[] };
const runtime = await createCurveRuntime();
const field = runtime.Fr;

for (const testCase of fixture.cases) {
  const domain = deriveUnivariateDomainShape(field, {
    l_free: 0,
    l: testCase.setup.l,
    l_user_out: 0,
    l_user: 0,
    l_D: testCase.setup.l_D,
    m_D: testCase.setup.l_D,
    n: testCase.setup.n,
    s_D: testCase.setup.s_D,
    s_max: testCase.setup.s_max,
  });
  assert.equal(domain.subcircuitCapacity, testCase.expected.t);
  assert.equal(domain.arithmeticSize, testCase.expected.N_A);
  assert.equal(domain.connectionSize, testCase.expected.N_C);
  assert.equal(domain.intersectionSize, testCase.expected.N_G);
  assert.equal(domain.unionSize, testCase.expected.N_union);
  assert.equal(2 * domain.arithmeticSize - testCase.setup.n + 2, testCase.expected.D);
  assert.ok(field.eq(arithmeticVanishingAt(field, domain, domain.arithmeticRoot), field.zero));
  assert.ok(field.eq(connectionVanishingAt(field, domain, domain.connectionRoot), field.zero));
  const setup = {
    l_free: 0,
    l: testCase.setup.l,
    l_user_out: 0,
    l_user: 0,
    l_D: testCase.setup.l_D,
    m_D: testCase.setup.l_D,
    n: testCase.setup.n,
    s_D: testCase.setup.s_D,
    s_max: testCase.setup.s_max,
  };
  assert.equal(
    arithmeticIndex(
      domain,
      setup,
      setup.s_max - 1,
      domain.subcircuitCapacity - 1,
      setup.n - 1,
    ),
    testCase.expected.arithmeticIndex,
  );
  assert.equal(
    connectionIndex(setup, setup.s_max - 1, setup.l_D - setup.l - 1),
    testCase.expected.connectionIndex,
  );
}

const small = deriveUnivariateDomainShape(field, {
  l_free: 0,
  l: 2,
  l_user_out: 0,
  l_user: 0,
  l_D: 4,
  m_D: 4,
  n: 2,
  s_D: 3,
  s_max: 2,
});
const point = field.fromBigInt(3n);
const arithmetic = arithmeticVanishingAt(field, small, point);
const connection = connectionVanishingAt(field, small, point);
const intersection = intersectionVanishingAt(field, small, point);
const arithmeticComplement = arithmeticComplementAt(field, small, point);
const connectionComplement = connectionComplementAt(field, small, point);
assert.ok(field.eq(intersection, connection));
assert.ok(field.eq(field.mul(connection, arithmeticComplement), connection));
assert.ok(field.eq(field.mul(connection, connectionComplement), arithmetic));
assert.ok(field.eq(unionVanishingAt(field, small, point), field.sub(field.pow(point, 16), field.one)));

const arithmeticSelector = await arithmeticCosetSelector(field, small, {
  l_free: 0,
  l: 2,
  l_user_out: 0,
  l_user: 0,
  l_D: 4,
  m_D: 4,
  n: 2,
  s_D: 3,
  s_max: 2,
}, 1, 2);
const selectorSetup = {
  l_free: 0,
  l: 2,
  l_user_out: 0,
  l_user: 0,
  l_D: 4,
  m_D: 4,
  n: 2,
  s_D: 3,
  s_max: 2,
} as const;
for (let placement = 0; placement < selectorSetup.s_max; placement += 1) {
  for (let subcircuit = 0; subcircuit < small.subcircuitCapacity; subcircuit += 1) {
    for (let row = 0; row < selectorSetup.n; row += 1) {
      const value = evaluateStridedPolynomial(
        field,
        arithmeticSelector,
        field.pow(
          small.arithmeticRoot,
          arithmeticIndex(small, selectorSetup, placement, subcircuit, row),
        ),
      );
      assert.ok(field.eq(value, placement === 1 && subcircuit === 2 ? field.one : field.zero));
    }
  }
}

const placementSelector = await placementSelectorPolynomial(field, small, selectorSetup, [0, null]);
assert.ok(field.eq(
  evaluateStridedPolynomial(field, placementSelector, field.one),
  field.one,
));
await assert.rejects(
  placementSelectorPolynomial(field, small, selectorSetup, [3, null]),
  /subcircuit index/,
);

const connectionSelector = await connectionCosetSelector(field, selectorSetup, 1);
assert.ok(field.eq(
  evaluateStridedPolynomial(field, connectionSelector, field.one),
  field.zero,
));
assert.ok(field.eq(
  evaluateStridedPolynomial(field, connectionSelector, field.pow(small.connectionRoot, 1)),
  field.one,
));

await runtime.terminate();
console.log("Checked univariate domain contract and field relations");
