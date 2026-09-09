import type { SetupParams } from "../artifacts/setup/setup-params.js";
import type { CurveRuntime } from "../runtime/curve/curve.js";
import type { FieldElement } from "../runtime/field/field-types.js";
import type { G1Point } from "../runtime/group/group.js";
import { PublicWireLayout } from "../prover/protocol/public-wire-layout.js";
import type { ProverPlacementVariables, ProverSubcircuitInfo } from "../prover/protocol/witness.js";
import { placementCount, placementSubcircuitId, placementVariableAt, placementVariableCount } from "../prover/protocol/witness.js";
import { commitDenseUnivariatePolynomial } from "./commitments.js";
import type { UnivariateProverCrsRuntime, TaggedQueryKey } from "./crs.js";
import { deriveUnivariateDomainShape } from "./domain.js";
import { DenseUnivariatePolynomial } from "./polynomial.js";
import { type UnivariateProof } from "./proof.js";
import {
  buildConnectionPermutationPolynomial,
  buildWitnessMaps,
  type DenseDomainPolynomial,
  type UnivariateSlotWitness,
  type UnivariateSubcircuit,
} from "./relation.js";
import { placementSelectorPolynomial, type StridedPolynomial } from "./selectors.js";
import { encodeEvaluationMessageBlock, encodeG1MessageBlock, UnivariateTranscript } from "./transcript.js";
import type { UnivariateCrsChunkSection } from "./chunked-crs.js";

export interface UnivariateReferenceProverInput {
  readonly setup: SetupParams;
  readonly selector: readonly (number | null)[];
  readonly permutation: readonly { readonly row: number; readonly col: number; readonly X: number; readonly Y: number }[];
  readonly placements: ProverPlacementVariables;
  readonly subcircuitInfos: readonly ProverSubcircuitInfo[];
  readonly subcircuits: readonly UnivariateSubcircuit[];
  readonly publicInputs: readonly FieldElement[];
  readonly crs: UnivariateProverCrsRuntime;
  readonly chunkPoints: number;
}

/** Correctness-first F1--F5 prover over the current univariate artifacts. */
export async function proveUnivariateReference(
  runtime: CurveRuntime,
  input: UnivariateReferenceProverInput,
): Promise<UnivariateProof> {
  const { setup, crs } = input;
  const field = runtime.Fr;
  const domain = deriveUnivariateDomainShape(field, setup);
  assertCrsCapacity(crs, domain.arithmeticSize, domain.connectionSize);
  const selector = await placementSelectorPolynomial(field, domain, setup, input.selector);
  const sC = await buildConnectionPermutationPolynomial(field, domain, setup, input.permutation);
  const slots = selectWitnessSlots(field, input.selector, input.placements, input.subcircuits, setup);
  const maps = await buildWitnessMaps(field, domain, setup, input.selector, slots, input.subcircuits);
  validatePublicStatementLayout(input.publicInputs, setup, input.subcircuitInfos, input.placements);

  const masks = await Promise.all(Array.from({ length: 4 }, () => randomPolynomial(runtime, 2)));
  const uHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.uA.coefficients), masks[0]!, domain.arithmeticSize);
  const vHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.vA.coefficients), masks[1]!, domain.arithmeticSize);
  const wHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.wA.coefficients), masks[2]!, domain.arithmeticSize);
  const bHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.bC.coefficients), masks[3]!, domain.connectionSize);
  const denseSelector = expandSelector(field, selector, domain.arithmeticSize);
  const qA = (await denseSelector.multiply(await uHat.multiply(vHat))).sub(await denseSelector.multiply(wHat)).divideVanishingExact(domain.arithmeticSize);

  const cU = await commit(runtime, crs.s0, 0, uHat, input.chunkPoints);
  const cV = await commit(runtime, crs.sxi, 0, vHat, input.chunkPoints);
  const cW = await commit(runtime, crs.spsi, 0, wHat, input.chunkPoints);
  const cB = await commit(runtime, crs.spsi, bigintToSafeNumber(crs.k, "K"), bHat, input.chunkPoints);
  const bindingRandomizer = await runtime.randomScalar();
  const [oIf, oInt] = await buildPrivateBindings(runtime, input, slots, masks, bindingRandomizer);

  const transcript = new UnivariateTranscript(field, input.publicInputs);
  transcript.appendMessageBlock(1, encodeG1MessageBlock("F2.a1", runtime.G1, [cU, cV, cW, cB, oIf, oInt]));
  const upsilon = transcript.challenge(1, 0);
  const cD = runtime.G1.add(cW, runtime.G1.mulScalar(cB, upsilon));
  transcript.appendMessageBlock(2, encodeG1MessageBlock("F2.a2", runtime.G1, [cD]));
  const [beta, gammaC] = transcript.challengePair(2);

  const copy = await buildCopyRelation(runtime, domain.connectionRoot, domain.connectionSize, maps.bC, sC, bHat, beta, gammaC);
  const cR = await commit(runtime, crs.s0, 0, copy.rHat, input.chunkPoints);
  transcript.appendMessageBlock(3, encodeG1MessageBlock("F2.a3", runtime.G1, [cR]));
  const theta = transcript.challenge(3, 0);
  const qHat = await combineQuotients(field, domain.arithmeticSize, domain.connectionSize, domain.intersectionSize, qA, copy.qC0, copy.qC1, theta);
  const cQ = await commit(runtime, crs.s0, 0, qHat, input.chunkPoints);
  transcript.appendMessageBlock(4, encodeG1MessageBlock("F2.a4", runtime.G1, [cQ]));
  const zeta = transcript.zeta(domain.arithmeticSize, domain.connectionSize);

  const sAPoly = denseSelector;
  const sCPoly = DenseUnivariatePolynomial.fromCoefficients(field, sC.coefficients);
  const evaluations = [
    sAPoly.evaluate(zeta), sCPoly.evaluate(zeta), uHat.evaluate(zeta), vHat.evaluate(zeta),
    wHat.evaluate(zeta), bHat.evaluate(zeta), qHat.evaluate(zeta), copy.rHat.evaluate(zeta),
    copy.rHat.evaluate(field.mul(domain.connectionRoot, zeta)),
  ] as const;
  transcript.appendMessageBlock(5, encodeEvaluationMessageBlock(field, evaluations));
  const varpi = transcript.challenge(5, 0);
  const openingTerms = [uHat, vHat, wHat, bHat, copy.rHat, qHat, sAPoly, sCPoly]
    .map(polynomial => polynomial.ruffini(zeta).quotient);
  const sources: readonly [UnivariateCrsChunkSection, number][] = [
    [crs.s0, 0], [crs.sxi, 0], [crs.spsi, 0], [crs.spsi, bigintToSafeNumber(crs.k, "K")],
    [crs.s0, 0], [crs.s0, 0], [crs.s0, 0], [crs.s0, 0],
  ];
  let piZeta = runtime.G1.zero;
  let factor = field.one;
  for (let index = 0; index < openingTerms.length; index += 1) {
    const [powers, offset] = sources[index]!;
    piZeta = runtime.G1.add(piZeta, runtime.G1.mulScalar(
      await commit(runtime, powers, offset, openingTerms[index]!, input.chunkPoints),
      factor,
    ));
    factor = field.mul(factor, varpi);
  }
  const piPlusPolynomial = copy.rHat
    .sub(constant(field, evaluations[8]))
    .ruffini(field.mul(domain.connectionRoot, zeta)).quotient;
  const piPlus = await commit(runtime, crs.s0, 0, piPlusPolynomial, input.chunkPoints);
  transcript.appendMessageBlock(6, encodeG1MessageBlock("F2.a6", runtime.G1, [piZeta, piPlus]));
  transcript.nonzeroChallenge(6, 0);

  return { g1: [cU, cV, cW, cB, oIf, oInt, cD, cR, cQ, piZeta, piPlus], evaluations };
}

function assertCrsCapacity(crs: UnivariateProverCrsRuntime, arithmetic: number, connection: number): void {
  const [m0, mXi, mPsi] = crs.declaredCapacity.map(value => bigintToSafeNumber(value, "CRS capacity"));
  if (m0 + 1 < arithmetic || mXi + 1 < arithmetic || mPsi + 1 < connection + Number(crs.k)) {
    throw new Error("Univariate prover CRS capacity is insufficient for the admitted setup.");
  }
}

function selectWitnessSlots(
  field: CurveRuntime["Fr"],
  selector: readonly (number | null)[],
  placements: ProverPlacementVariables,
  subcircuits: readonly UnivariateSubcircuit[],
  setup: SetupParams,
): readonly (UnivariateSlotWitness | null)[] {
  if (selector.length !== setup.s_max) throw new Error("Selector length does not match setup capacity.");
  const slots: (UnivariateSlotWitness | null)[] = [];
  let cursor = 0;
  for (const selected of selector) {
    if (selected === null) {
      slots.push(null);
      continue;
    }
    if (cursor >= placementCount(placements) || placementSubcircuitId(placements, cursor) !== selected) {
      throw new Error("Selector and compact placement list do not describe the same active slots.");
    }
    const subcircuit = subcircuits[selected];
    const count = placementVariableCount(placements, cursor);
    if (subcircuit === undefined || subcircuit.flattenMap.length !== count) {
      throw new Error("Placement witness width does not match the selected subcircuit.");
    }
    const values = field.createZeroBuffer(count);
    for (let index = 0; index < count; index += 1) {
      field.writeBufferElement(values, index, placementVariableAt(placements, cursor, index));
    }
    slots.push({ subcircuitId: selected, values });
    cursor += 1;
  }
  if (cursor !== placementCount(placements)) throw new Error("Placement list has entries without selector slots.");
  return slots;
}

function blind(
  base: DenseUnivariatePolynomial,
  randomizer: DenseUnivariatePolynomial,
  domainSize: number,
): DenseUnivariatePolynomial {
  return base.add(randomizer.multiplyVanishing(domainSize));
}

async function randomPolynomial(runtime: CurveRuntime, length: number): Promise<DenseUnivariatePolynomial> {
  return DenseUnivariatePolynomial.fromCoefficients(
    runtime.Fr,
    runtime.Fr.concat(await Promise.all(Array.from({ length }, () => runtime.randomScalar()))),
  );
}

function expandSelector(field: CurveRuntime["Fr"], selector: StridedPolynomial, arithmeticSize: number): DenseUnivariatePolynomial {
  const highest = (selector.coefficients.length - 1) * selector.stride;
  if (highest >= arithmeticSize) throw new Error("Selector degree exceeds the arithmetic domain.");
  const coefficients = field.createZeroBuffer(highest + 1);
  for (const [index, coefficient] of selector.coefficients.entries()) {
    field.writeBufferElement(coefficients, index * selector.stride, coefficient);
  }
  return DenseUnivariatePolynomial.fromCoefficients(field, coefficients);
}

async function buildCopyRelation(
  runtime: CurveRuntime,
  root: FieldElement,
  domainSize: number,
  b: DenseDomainPolynomial,
  sC: DenseDomainPolynomial,
  bHat: DenseUnivariatePolynomial,
  beta: FieldElement,
  gammaC: FieldElement,
): Promise<{ readonly rHat: DenseUnivariatePolynomial; readonly qC0: DenseUnivariatePolynomial; readonly qC1: DenseUnivariatePolynomial }> {
  const field = runtime.Fr;
  const rEvals = field.createZeroBuffer(domainSize);
  field.writeBufferElement(rEvals, 0, field.one);
  let point = field.one;
  for (let index = 0; index < domainSize; index += 1) {
    const bValue = field.readBufferElement(b.evaluations, index);
    const f = field.add(field.add(bValue, field.mul(beta, field.readBufferElement(sC.evaluations, index))), gammaC);
    const g = field.add(field.add(bValue, field.mul(beta, point)), gammaC);
    if (field.isZero(g)) throw new Error(`Copy recursion denominator vanishes at index ${index}.`);
    if (index + 1 < domainSize) {
      field.writeBufferElement(rEvals, index + 1, field.div(field.mul(field.readBufferElement(rEvals, index), f), g));
    } else if (!field.eq(field.mul(field.readBufferElement(rEvals, index), f), g)) {
      throw new Error("Copy recursion does not close around the connection domain.");
    }
    point = field.mul(point, root);
  }
  const rBase = DenseUnivariatePolynomial.fromCoefficients(field, await field.ifftBuffer(rEvals));
  const rHat = blind(rBase, await randomPolynomial(runtime, 2), domainSize);
  const sCPoly = DenseUnivariatePolynomial.fromCoefficients(field, sC.coefficients);
  const fHat = bHat.add(sCPoly.scale(beta)).add(constant(field, gammaC));
  const gHat = bHat.add(linear(field, gammaC, beta));
  const l0 = DenseUnivariatePolynomial.fromCoefficients(field, field.concat(Array.from({ length: domainSize }, () => field.inv(field.fromBigInt(BigInt(domainSize))))));
  const qC0 = (await rHat.sub(constant(field, field.one)).multiply(l0)).divideVanishingExact(domainSize);
  const qC1 = (await rHat.scaleArgument(root).multiply(gHat)).sub(await rHat.multiply(fHat)).divideVanishingExact(domainSize);
  return { rHat, qC0, qC1 };
}

async function combineQuotients(
  field: CurveRuntime["Fr"],
  arithmeticSize: number,
  connectionSize: number,
  intersectionSize: number,
  qA: DenseUnivariatePolynomial,
  qC0: DenseUnivariatePolynomial,
  qC1: DenseUnivariatePolynomial,
  theta: FieldElement,
): Promise<DenseUnivariatePolynomial> {
  const mA = complementaryFactor(field, connectionSize, intersectionSize);
  const mC = complementaryFactor(field, arithmeticSize, intersectionSize);
  return (await qA.multiply(mA))
    .add((await qC0.multiply(mC)).scale(theta))
    .add((await qC1.multiply(mC)).scale(field.mul(theta, theta)));
}

function complementaryFactor(field: CurveRuntime["Fr"], large: number, small: number): DenseUnivariatePolynomial {
  if (small <= 0 || large % small !== 0) throw new Error("Univariate domains do not have an exact complement.");
  const coefficients = field.createZeroBuffer(large);
  for (let index = 0; index < large; index += small) field.writeBufferElement(coefficients, index, field.one);
  return DenseUnivariatePolynomial.fromCoefficients(field, coefficients);
}

async function buildPrivateBindings(
  runtime: CurveRuntime,
  input: UnivariateReferenceProverInput,
  slots: readonly (UnivariateSlotWitness | null)[],
  masks: readonly DenseUnivariatePolynomial[],
  randomizer: FieldElement,
): Promise<readonly [G1Point, G1Point]> {
  const interfaceTerms: { key: TaggedQueryKey; value: FieldElement }[] = [];
  const internalTerms: { key: TaggedQueryKey; value: FieldElement }[] = [];
  for (const [placementIndex, slot] of slots.entries()) {
    if (slot === null) continue;
    const info = input.subcircuitInfos[slot.subcircuitId]!;
    for (let localWireIndex = 0; localWireIndex < info.flattenMap.length; localWireIndex += 1) {
      const global = info.flattenMap[localWireIndex]!;
      const term = { key: { placementIndex, subcircuitId: slot.subcircuitId, localWireIndex }, value: runtime.Fr.readBufferElement(slot.values, localWireIndex) };
      if (global >= input.setup.l && global < input.setup.l_D) interfaceTerms.push(term);
      else if (global >= input.setup.l_D) internalTerms.push(term);
    }
  }
  const oIf = runtime.G1.add(await combineTagged(runtime, input.crs.interfaceQueries, interfaceTerms), runtime.G1.mulAffineScalar(input.crs.deltaG1, randomizer));
  let oInt = runtime.G1.sub(await combineTagged(runtime, input.crs.internalQueries, internalTerms), runtime.G1.mulAffineScalar(input.crs.etaG1, randomizer));
  for (const [index, mask] of masks.entries()) {
    const section = input.crs.masks[index]!;
    for (let coefficient = 0; coefficient <= mask.degree; coefficient += 1) {
      oInt = runtime.G1.add(oInt, runtime.G1.mulAffineScalar(await section.readElement(coefficient), runtime.Fr.readBufferElement(mask.coefficients, coefficient)));
    }
  }
  return [oIf, oInt];
}

async function combineTagged(
  runtime: CurveRuntime,
  queries: UnivariateProverCrsRuntime["interfaceQueries"],
  terms: readonly { readonly key: TaggedQueryKey; readonly value: FieldElement }[],
): Promise<G1Point> {
  const lookup = new Map<string, number>();
  for (let index = 0; index < queries.points.elementCount; index += 1) lookup.set(taggedKey(await queries.keyAt(index)), index);
  const seen = new Set<string>();
  const bases: G1Point[] = [];
  const scalars: FieldElement[] = [];
  for (const term of terms) {
    const key = taggedKey(term.key);
    if (seen.has(key)) throw new Error(`Duplicate witness binding coordinate ${key}.`);
    seen.add(key);
    const index = lookup.get(key);
    if (index === undefined) throw new Error(`Missing CRS binding query ${key}.`);
    bases.push(await queries.points.readElement(index));
    scalars.push(term.value);
  }
  return bases.length === 0 ? runtime.G1.zero : runtime.G1.msmAffine(bases, scalars);
}

function validatePublicStatementLayout(
  publicInputs: readonly FieldElement[],
  setup: SetupParams,
  infos: readonly ProverSubcircuitInfo[],
  placements: ProverPlacementVariables,
): void {
  if (publicInputs.length !== setup.l) throw new Error(`Public statement length is ${publicInputs.length}, expected ${setup.l}.`);
  const layout = PublicWireLayout.derive(setup, infos);
  layout.validateRuntimeBufferPlacements(placements);
}

async function commit(
  runtime: CurveRuntime,
  powers: UnivariateCrsChunkSection,
  offset: number,
  polynomial: DenseUnivariatePolynomial,
  chunkPoints: number,
): Promise<G1Point> {
  if (offset < 0 || offset + polynomial.degree + 1 > powers.elementCount) throw new Error("CRS sequence is too short for a commitment.");
  return commitDenseUnivariatePolynomial(runtime, powers, polynomial.coefficients, chunkPoints, offset);
}

function constant(field: CurveRuntime["Fr"], value: FieldElement): DenseUnivariatePolynomial {
  return DenseUnivariatePolynomial.fromCoefficients(field, field.concat([value]));
}

function linear(field: CurveRuntime["Fr"], constantTerm: FieldElement, linearTerm: FieldElement): DenseUnivariatePolynomial {
  return DenseUnivariatePolynomial.fromCoefficients(field, field.concat([constantTerm, linearTerm]));
}

function taggedKey(key: TaggedQueryKey): string {
  return `${key.placementIndex}:${key.subcircuitId}:${key.localWireIndex}`;
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the supported integer range.`);
  return Number(value);
}
