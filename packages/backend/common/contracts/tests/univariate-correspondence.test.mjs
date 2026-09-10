// Independent small-field tests for selection, capacity and public binding.
// These are specification oracles, not production arithmetic or E2E tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/univariate-selection.json", import.meta.url), "utf8"));
test("global role coordinates do not assume circuit-major wire numbering", () => {
  const lFree = 2, l = 3, lD = 7, m = 4;
  const maps = [[3, 0, 7], [4, 2], [5, 1, 8]];
  const globals = Array(12).fill(null);
  for (const [k, map] of maps.entries()) {
    assert.ok(map.length <= m);
    for (const [j, g] of map.entries()) {
      assert.equal(globals[g], null);
      globals[g] = [k, j];
    }
  }
  assert.deepEqual(globals[6], null); // Interface padding, not a compiled wire.
  const publicQueries = maps.flatMap((map, k) => map.flatMap((g, j) =>
    g < l ? [{ i: k, k, j, g, role: g < lFree ? "free" : "fixed" }] : []));
  publicQueries.sort((a, b) => a.g - b.g);
  assert.deepEqual(publicQueries.map(({ k, role }) => [k, role]), [[0, "free"], [2, "free"], [1, "fixed"]]);
  assert.ok(publicQueries.every(({ i, k }) => i === k));
  for (const [k, map] of maps.entries()) {
    for (const [j, g] of map.entries()) assert.deepEqual(globals[g], [k, j]);
  }
  // A global interface coordinate need not equal the local wire index.
  assert.equal(maps[2][0] - l, 2);
  assert.notEqual(maps[2][0] - l, 0);
  assert.ok(maps[0][2] >= lD);
});
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
    const { n, m, mI, s, compiled, lFree } = input;
    const t = ceilPowerOfTwo(compiled + 1);
    const NA = n * s, NC = mI * s, NS = s * t;
    const d = Math.max(NA + 1, NC + 1), h = d + 1;
    const bounds = [2 * d + 1, NS + 1, h + s * (t - 1), lFree - 1];
    const P = Math.max(...bounds), K = P - d, S = K + h;
    assert.deepEqual({ t, mD: m * compiled, NA, NC, NS, d, P, K, h, S }, expected);
    assert.ok(bounds.every((bound) => P >= bound));
    assert.ok(bounds.some((bound) => P - 1 < bound));
    assert.equal(S, P + 1);
    assert.ok(K > d);
    // Capacity follows U18 demand; no fixed c0 multiplier gates admission.
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

const publicFixture = JSON.parse(readFileSync(new URL("../fixtures/univariate-public-binding.json", import.meta.url), "utf8"));
assert.equal(publicFixture.fieldModulus, vector.fieldModulus);
const publicRoot = pow(BigInt(vector.fieldGenerator), (modulus - 1n) / BigInt(publicFixture.freeValues.length));
const publicRoots = publicFixture.freeValues.map((_, i) => pow(publicRoot, i));
const freeValues = publicFixture.freeValues.map(BigInt);
const freePolynomial = interpolate(publicRoots, freeValues);

function evaluateFreePublic(values, x) {
  const rootIndex = publicRoots.indexOf(x);
  if (rootIndex !== -1) return values[rootIndex];
  const sum = publicRoots.reduce((sum, root, i) => mod(sum + values[i] * root * inverse(x - root)), 0n);
  return mod((pow(x, values.length) - 1n) * inverse(BigInt(values.length)) * sum);
}

test("free public interpolation uses its padded unit-root domain, not total l", () => {
  assert.equal(new Set(publicRoots).size, freeValues.length);
  assert.equal(publicFixture.totalPublicLength, freeValues.length + publicFixture.fixedValues.length);
  assert.equal(freePolynomial.length, freeValues.length);
  for (let x = 0n; x < modulus; x++) {
    assert.equal(evaluateFreePublic(freeValues, x), evaluate(freePolynomial, x));
  }
  for (const index of publicFixture.paddingIndices) {
    assert.equal(freeValues[index], 0n);
    assert.ok(!publicFixture.wires.some(wire => wire.global === index));
  }
});

function publicBinding(fixedValues = publicFixture.fixedValues.map(BigInt)) {
  const { s, t, n, mI, K, h, S } = publicFixture;
  const xi = BigInt(publicFixture.xi), psi = BigInt(publicFixture.psi), delta = BigInt(vector.delta);
  const tauK = pow(tau, K), tauS = pow(tau, S);
  const selected = publicFixture.selector.map((k, i) => roots[i + s * (k === -1 ? t - 1 : k)]);
  const Zv = fromRoots(selected), Zu = fromRoots(roots.filter(z => !selected.includes(z)));
  const sums = [0n, 0n, 0n, 0n];
  const witnessRows = Array.from({ length: s }, () => [0n, 0n]);
  let cO = 0n, cFix = 0n, fixedMContamination = 0n;
  const freeQueryIndices = [], fixedQueryIndices = [];
  for (const wire of publicFixture.wires) {
    const isFree = wire.global < freeValues.length;
    const isFixed = !isFree && wire.global < publicFixture.totalPublicLength;
    const value = isFree ? freeValues[wire.global]
      : isFixed ? fixedValues[wire.global - freeValues.length] : BigInt(wire.value);
    if (isFree || isFixed) assert.equal(wire.i, wire.k, "only public buffers require i=k");
    assert.equal(publicFixture.selector[wire.i], wire.k);
    witnessRows[wire.i][wire.j] = value;
    const [u, v, w, b] = wire.images.map(BigInt);
    wire.images.forEach((image, index) => { sums[index] = mod(sums[index] + value * BigInt(image)); });
    const z = roots[wire.i + s * wire.k];
    const lagrange = mod((pow(tau, s * t) - 1n) * z * inverse(BigInt(s * t) * (tau - z)));
    const q = mod(xi * (u + tauK * v) + psi * (w + tauK * b) + tauS * BigInt(vector.weights[wire.j]) * lagrange);
    if (isFixed) {
      fixedQueryIndices.push(wire.global);
      cFix = mod(cFix + value * q);
      fixedMContamination = mod(fixedMContamination + value);
    } else {
      const M = isFree ? evaluate(interpolate(publicRoots, freeValues.map((_, i) => i === wire.global ? 1n : 0n)), tau) : 0n;
      cO = mod(cO + value * (q + M) * inverse(delta));
      if (isFree) freeQueryIndices.push(wire.global);
    }
  }
  const ZA = mod(pow(tau, n * s) - 1n), ZC = mod(pow(tau, mI * s) - 1n);
  const maskValues = publicFixture.imageMasks.map(([a, b]) => mod(BigInt(a) + BigInt(b) * tau));
  const imageAdditions = maskValues.map((mask, i) => mod(mask * (i === 3 ? ZC : ZA)));
  const images = sums.map((sum, i) => mod(sum + imageAdditions[i]));
  const imageMask = mod(xi * (imageAdditions[0] + tauK * imageAdditions[1]) + psi * (imageAdditions[2] + tauK * imageAdditions[3]));
  const bS = BigInt(publicFixture.selectionMask);
  cO = mod(cO + inverse(delta) * (imageMask + bS * tauS * (pow(tau, s * t) - 1n)));
  let dQ = mod(bS * evaluate(Zv, tau));
  for (let j = 0; j < witnessRows[0].length; j++) {
    const qj = interpolate(selected, selected.map((z, i) => mod(witnessRows[i][j] * inverse(evaluate(Zu, z)))));
    dQ = mod(dQ + BigInt(vector.weights[j]) * evaluate(qj, tau));
  }
  const cL = mod(evaluate(freePolynomial, tau) + xi * images[0] + psi * images[2]);
  const cH = mod(xi * images[1] + psi * images[3]);
  const dQK = mod(tauK * dQ), eKappa = mod(pow(tau, h) * evaluate(Zu, tau));
  assert.equal(S, K + h);
  return { cL, cH, cO, cFix, dQ, dQK, eKappa, tauK, delta, freeQueryIndices, fixedQueryIndices, fixedMContamination };
}

const bindingResidual = (b) => mod(b.cL + b.tauK * b.cH + b.dQK * b.eKappa - b.delta * b.cO - b.cFix);

test("free and fixed public query forms satisfy the masked binding identity", () => {
  const b = publicBinding();
  assert.deepEqual(b.freeQueryIndices, [0, 1]);
  assert.deepEqual(b.fixedQueryIndices, [4, 5]);
  assert.equal(bindingResidual(b), 0n);
  assert.notEqual(b.cFix, 0n);
  assert.notEqual(bindingResidual({ ...b, cFix: mod(b.cFix * inverse(b.delta)) }), 0n, "fixed queries must be unscaled");
  assert.notEqual(bindingResidual({ ...b, cFix: mod(b.cFix + b.fixedMContamination) }), 0n, "fixed queries have no public interpolation term");
});

test("changing the fixed witness requires the matching accepted commitment", () => {
  const original = publicBinding();
  const changedValues = publicFixture.fixedValues.map(BigInt);
  changedValues[0] += 1n;
  const changed = publicBinding(changedValues);
  assert.equal(bindingResidual(changed), 0n);
  assert.notEqual(bindingResidual({ ...changed, cFix: original.cFix }), 0n);
  assert.equal(bindingResidual(publicBinding([0n, 0n])), 0n);
});

test("fixed binding joins the existing five pairing operands with the correct sign", () => {
  const b = publicBinding(), mu = 7n, upsilon = 3n, chi = 9n;
  const omegaC = pow(BigInt(vector.fieldGenerator), (modulus - 1n) / BigInt(publicFixture.mI * publicFixture.s));
  const cE = mod(b.cL + upsilon * b.cH), cD = mod(b.tauK * cE);
  const piChi = 23n, piPlus = 29n;
  // Only test the batching identity: these opening labels are not an E2E proof.
  const aChi = mod((tau - chi) * piChi), aPlus = mod((tau - omegaC * chi) * piPlus);
  const operands = [
    [mod(b.cL - b.cFix - mu * cD + pow(mu, 2) * (aChi + chi * piChi) + pow(mu, 3) * (aPlus + omegaC * chi * piPlus) - pow(mu, 4) * b.dQK), 1n],
    [mod(b.cH + mu * cE + pow(mu, 4) * b.dQ), b.tauK],
    [b.dQK, b.eKappa],
    [mod(-b.cO), b.delta],
    [mod(-pow(mu, 2) * piChi - pow(mu, 3) * piPlus), tau],
  ];
  const residual = operands.reduce((sum, [g1, g2]) => mod(sum + g1 * g2), 0n);
  assert.equal(operands.length, 5);
  assert.equal(residual, 0n);
  assert.notEqual(mod(residual + b.cFix), 0n, "omitting the fixed subtraction fails");
  assert.notEqual(mod(residual + 2n * b.cFix), 0n, "adding instead of subtracting fails");
});

const crsContract = JSON.parse(readFileSync(new URL("../univariate-crs-chunk-contract.json", import.meta.url), "utf8"));
const artifactContract = JSON.parse(readFileSync(new URL("../browser-artifact-contract.v1.json", import.meta.url), "utf8"));

test("domain vectors separate arithmetic coordinates from library selection", () => {
  const domain = JSON.parse(readFileSync(new URL("../univariate-domain-contract.v1.json", import.meta.url), "utf8"));
  const vectors = JSON.parse(readFileSync(new URL("../fixtures/univariate-domain-shape.v1.json", import.meta.url), "utf8"));
  assert.equal(domain.arithmeticDomain.index, "i + s_max * r");
  assert.equal(domain.selectionDomain.index, "i + s_max * k");
  for (const {setup: p, expected: e} of vectors.cases) {
    assert.equal(p.t, ceilPowerOfTwo(p.s_D + 1));
    const NA = p.n * p.s_max, NC = (p.l_D - p.l) * p.s_max, NS = p.t * p.s_max;
    const d = Math.max(NA, NC) + 1, h = d + 1;
    assert.equal(NA, e.N_A); assert.equal(NC, e.N_C); assert.equal(NS, e.N_S);
    assert.equal(Math.max(2*d + 1, NS + 1, h + p.s_max*(p.t - 1), p.l_free - 1), e.P);
    assert.equal((p.s_max - 1) + p.s_max*(p.n - 1), e.arithmeticIndex);
    assert.equal((p.s_max - 1) + p.s_max*(p.t - 1), e.selectionIndex);
    assert.equal(p.m_D, p.m * p.s_D);
  }
});

test("four CRS payloads own each section once and preprocess is self-contained", () => {
  const labels = crsContract.sections.map(section => section.label);
  const stored = Object.values(crsContract.payloads).flat();
  assert.equal(Object.keys(crsContract.payloads).length, 4);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(new Set(stored).size, stored.length);
  assert.deepEqual([...stored].sort(), [...labels].sort());
  assert.deepEqual(crsContract.roles.preprocess, crsContract.payloads["preprocess_keys.rkyv"]);
  assert.ok(!crsContract.roles.prover.includes("crs.fixed-public-queries"));
  assert.ok(!crsContract.roles.verifier.includes("crs.fixed-public-queries"));
  for (const role of Object.values(crsContract.roles)) {
    for (const label of role) assert.ok(labels.includes(label));
  }
});

test("preprocess power windows encode S_C and shifted Z_u without unused powers", () => {
  const NC = publicFixture.mI * publicFixture.s;
  const omegaC = pow(BigInt(vector.fieldGenerator), (modulus - 1n) / BigInt(NC));
  const domainC = Array.from({ length: NC }, (_, i) => pow(omegaC, i));
  const permutation = [...domainC];
  [permutation[0], permutation[1]] = [permutation[1], permutation[0]];
  const sc = interpolate(domainC, permutation);
  assert.notEqual(sc[NC - 1], 0n, "the last allowed S_C coefficient is needed");
  const scBases = Array.from({ length: NC }, (_, a) => pow(tau, a));
  const scCommitment = sc.reduce((sum, coefficient, a) => mod(sum + coefficient * scBases[a]), 0n);
  assert.equal(scCommitment, evaluate(sc, tau));
  assert.equal(crsContract.order["crs.preprocess-sc"], "tau^a, a=0..N_C-1");

  for (const selector of vector.selectors) {
    const selected = normalizeSelector(selector, vector.compiled, vector.t, vector.s).map((k, i) => roots[i + vector.s * k]);
    const zu = fromRoots(roots.filter(root => !selected.includes(root)));
    const bases = zu.map((_, a) => pow(tau, publicFixture.h + a));
    const commitment = zu.reduce((sum, coefficient, a) => mod(sum + coefficient * bases[a]), 0n);
    assert.notEqual(zu[0], 0n);
    assert.equal(zu.at(-1), 1n);
    assert.equal(bases.length, vector.s * (vector.t - 1) + 1);
    assert.equal(commitment, mod(pow(tau, publicFixture.h) * evaluate(zu, tau)));
  }
  assert.equal(crsContract.order["crs.preprocess-selection"], "tau^(h+a), a=0..s_max*(t-1)");
});

test("preprocess output and proof carry only the current protocol elements", () => {
  const [preprocess, proof] = artifactContract.artifacts;
  assert.deepEqual(preprocess.sections.map(section => section.points.map(point => point.name)), [["S_C", "C_fix"], ["E_kappa"]]);
  assert.deepEqual(proof.sections.map(section => section.elementCount), [10, 7]);
  for (const artifact of artifactContract.artifacts) {
    for (const section of artifact.sections) {
      assert.equal(section.elementCount, section.points.length);
      assert.deepEqual(section.points.map(point => point.index), section.points.map((_, i) => i));
    }
  }
  assert.deepEqual(proof.sections[0].points.map(point => point.name), ["C_L", "C_H", "C_O", "D_Q", "D_QK", "C_D", "C_R", "C_Q", "Pi_chi", "Pi_plus"]);
  assert.deepEqual(proof.sections[1].points.map(point => point.name), ["s_C", "u", "v", "w", "b", "r", "r_plus"]);
});
