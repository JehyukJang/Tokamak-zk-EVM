// Independent small-field correspondence tests for U8a/U8b, U18 and U29.
// These are specification oracles, not production arithmetic or E2E tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/univariate-selection.json", import.meta.url), "utf8"));
const vector = fixture.selection;
const modulus = BigInt(vector.fieldModulus);
const mod = (x) => ((x % modulus) + modulus) % modulus;
function pow(x, n) {
  let result = 1n;
  for (let exponent = BigInt(n); exponent > 0n; exponent >>= 1n) {
    if (exponent & 1n) result = mod(result * x);
    x = mod(x * x);
  }
  return result;
}
function inverse(x) {
  assert.notEqual(mod(x), 0n, "zero denominator");
  return pow(mod(x), modulus - 2n);
}
function multiply(a, b) {
  const result = Array(a.length + b.length - 1).fill(0n);
  a.forEach((x, i) => b.forEach((y, j) => { result[i + j] = mod(result[i + j] + x * y); }));
  return result;
}
const fromRoots = (roots) => roots.reduce((p, z) => multiply(p, [mod(-z), 1n]), [1n]);
const evaluate = (p, x) => p.reduceRight((sum, coefficient) => mod(sum * x + coefficient), 0n);
function addScaled(target, p, scale) {
  p.forEach((coefficient, index) => { target[index] = mod((target[index] ?? 0n) + coefficient * scale); });
  return target;
}
function interpolate(xs, ys) {
  const result = Array(xs.length).fill(0n);
  xs.forEach((x, i) => {
    const numerator = fromRoots(xs.filter((_, j) => i !== j));
    addScaled(result, numerator, mod(ys[i] * inverse(evaluate(numerator, x))));
  });
  return result;
}
function ceilPowerOfTwo(value) {
  let capacity = 1;
  while (capacity < value) capacity *= 2;
  return capacity;
}
function normalizeSelector(selector, compiled, t, s) {
  assert.equal(selector.length, s, "selector capacity mismatch");
  return selector.map((id) => {
    assert.ok(Number.isSafeInteger(id) && (id === -1 || (id >= 0 && id < compiled)), "invalid external selector ID");
    return id === -1 ? t - 1 : id;
  });
}

test("the final ID is reserved even at exact-power-of-two catalog sizes", () => {
  for (const { compiled, t, emptyId } of fixture.reservationCases) {
    assert.equal(ceilPowerOfTwo(compiled + 1), t);
    assert.equal(t - 1, emptyId);
    assert.ok(emptyId >= compiled);
    assert.deepEqual(normalizeSelector([-1], compiled, t, 1), [emptyId]);
    for (let id = compiled; id < t; id++) {
      assert.throws(() => normalizeSelector([id], compiled, t, 1), /invalid external/);
    }
  }
});

test("minimal P satisfies every U18 lower bound without multiplying NA by t", () => {
  for (const { input, expected } of fixture.capacityCases) {
    const { n, m, mI, s, compiled, ell } = input;
    const t = ceilPowerOfTwo(compiled + 1);
    const NA = n * s, NC = mI * s, NS = s * t;
    const d = Math.max(NA + 1, NC + 1), h = d + 1;
    const bounds = [2 * d + 1, NS + 1, h + s * (t - 1), ell - 1];
    const P = Math.max(...bounds), K = P - d, S = K + h;
    assert.deepEqual({ t, mD: m * compiled, NA, NC, NS, d, P, K, h, S }, expected);
    assert.ok(bounds.every((bound) => P >= bound));
    assert.ok(bounds.some((bound) => P - 1 < bound));
    assert.equal(S, P + 1);
    assert.ok(K > d);
    // This verifies U18, not the separate, still-unfixed c0 admission bound.
  }
});

test("external selector accepts neither reserved IDs nor the obsolete unsigned sentinel", () => {
  for (const selector of vector.invalidSelectors) {
    assert.throws(() => normalizeSelector(selector, vector.compiled, vector.t, vector.s));
  }
});

const N = vector.s * vector.t;
const omega = pow(BigInt(vector.fieldGenerator), (modulus - 1n) / BigInt(N));
const roots = Array.from({ length: N }, (_, index) => pow(omega, index));
const tau = BigInt(vector.tau);

test("selection coordinates are distinct and tau lies outside the domain", () => {
  assert.equal(pow(omega, N), 1n);
  assert.notEqual(pow(omega, N / 2), 1n);
  assert.equal(new Set(roots).size, N);
  assert.ok(!roots.includes(tau));
});

for (const selector of vector.selectors) {
  test(`implicit empty placements preserve U8b and U29: ${selector}`, () => {
    const kappa = normalizeSelector(selector, vector.compiled, vector.t, vector.s);
    const selected = kappa.map((k, i) => roots[i + vector.s * k]);
    const unselected = roots.filter((z) => !selected.includes(z));
    const Zv = fromRoots(selected), Zu = fromRoots(unselected);
    const Zs = Array(N + 1).fill(0n);
    Zs[0] = mod(-1n); Zs[N] = 1n;
    assert.deepEqual(multiply(Zu, Zv), Zs);
    assert.equal(Zv.length - 1, vector.s);
    assert.equal(Zu.length - 1, vector.s * (vector.t - 1));

    const weights = vector.weights.map(BigInt);
    const explicitRows = selector.map((id, i) => weights.map((_, j) => id === -1 ? 0n : BigInt(vector.actualWitnessRows[i][j])));
    const implicitValue = (i, j) => selector[i] === -1 ? 0n : BigInt(vector.actualWitnessRows[i][j]);
    const C0 = Array(N).fill(0n), weightedQ = Array(vector.s).fill(0n);
    for (let j = 0; j < weights.length; j++) {
      const values = selected.map((z, i) => {
        assert.equal(implicitValue(i, j), explicitRows[i][j]);
        return mod(implicitValue(i, j) * inverse(evaluate(Zu, z)));
      });
      addScaled(weightedQ, interpolate(selected, values), weights[j]);
      for (let i = 0; i < vector.s; i++) {
        const basisValues = roots.map((z) => z === selected[i] ? 1n : 0n);
        addScaled(C0, interpolate(roots, basisValues), mod(weights[j] * explicitRows[i][j]));
      }
    }
    assert.deepEqual(multiply(Zu, weightedQ), C0);
    const mask = 13n;
    const QS = addScaled([...weightedQ], Zv, mask);
    assert.deepEqual(multiply(Zu, QS), addScaled([...C0], Zs, mask));

    // Compare scalar labels of commitments; this does not test a curve codec.
    const factor = mod(pow(tau, vector.selectionShift) * inverse(BigInt(vector.delta)));
    let dense = 0n, omitted = 0n, placeholders = 0n;
    for (let i = 0; i < vector.s; i++) {
      for (let k = 0; k < vector.t; k++) {
        const z = roots[i + vector.s * k];
        const lagrange = mod((pow(tau, N) - 1n) * z * inverse(BigInt(N) * (tau - z)));
        for (let j = 0; j < weights.length; j++) {
          const point = mod(factor * weights[j] * lagrange);
          assert.notEqual(point, 0n, "zero arithmetic does not erase weighted binding");
          const coefficient = k === kappa[i] ? explicitRows[i][j] : 0n;
          dense = mod(dense + coefficient * point);
          if (k < vector.compiled) omitted = mod(omitted + coefficient * point);
          placeholders = mod(placeholders + coefficient * (k < vector.compiled ? point : 0n));
        }
      }
    }
    assert.equal(dense, omitted);
    assert.equal(dense, placeholders);
    assert.equal(dense, mod(factor * evaluate(C0, tau)));
  });
}
