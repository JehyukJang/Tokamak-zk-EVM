import type { SetupParams } from "../artifacts/setup/setup-params.js";
import type { CurveRuntime } from "../runtime/curve/curve.js";
import type { FieldElement } from "../runtime/field/field-types.js";
import type { G1Point } from "../runtime/group/group.js";
import { PublicWireLayout } from "../prover/protocol/public-wire-layout.js";
import type { ProverPlacementVariables, ProverSubcircuitInfo } from "../prover/protocol/witness.js";
import { placementCount, placementSubcircuitId, placementVariableAt, placementVariableCount } from "../prover/protocol/witness.js";
import { commitDenseUnivariatePolynomial } from "./commitments.js";
import type { UnivariateProverCrsRuntime } from "./crs.js";
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
import { SelectedRoots } from "./selected-roots.js";
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
export async function proveUnivariateReference(runtime: CurveRuntime, input: UnivariateReferenceProverInput): Promise<UnivariateProof> {
  const { setup, crs } = input;
  const field = runtime.Fr;
  const domain = deriveUnivariateDomainShape(field, setup);
  const d = Math.max(domain.arithmeticSize, domain.connectionSize) + 1;
  const p = Math.max(2 * d + 1, setup.s_max * setup.t + 1, d + 1 + setup.s_max * (setup.t - 1), setup.l_free - 1);
  const k = p - d;
  if(crs.s0.elementCount !== 2 * p + 1 || crs.sxi.elementCount !== p + 1 || crs.spsi.elementCount !== p + 1)
    throw new Error("CRS sequence capacity does not match the library.");
  const sC = await buildConnectionPermutationPolynomial(field, domain, setup, input.selector, input.permutation);
  const slots = selectWitnessSlots(field, input.selector, input.placements, input.subcircuits, setup);
  const maps = await buildWitnessMaps(field, domain, setup, input.selector, slots, input.subcircuits);
  const layout = PublicWireLayout.derive(setup, input.subcircuitInfos);
  validatePublicStatement(runtime, input, slots, layout);
  const masks = await Promise.all(Array.from({ length: 4 }, () => randomPolynomial(runtime, 2)));
  const maskR = await randomPolynomial(runtime, 4);
  const selectionMask = await runtime.randomScalar();
  const uHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.uA.coefficients), masks[0]!, domain.arithmeticSize);
  const vHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.vA.coefficients), masks[1]!, domain.arithmeticSize);
  const wHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.wA.coefficients), masks[2]!, domain.arithmeticSize);
  const bHat = blind(DenseUnivariatePolynomial.fromCoefficients(field, maps.bC.coefficients), masks[3]!, domain.connectionSize);
  const qA = (await uHat.multiply(vHat)).sub(wHat).divideVanishingExact(domain.arithmeticSize);
  const a = setup.l_free === 0 ? DenseUnivariatePolynomial.zero(field) :
    DenseUnivariatePolynomial.fromCoefficients(field, await field.ifftBuffer(field.concat(input.publicInputs.slice(0, setup.l_free))));
  const c = (section: UnivariateCrsChunkSection, poly: DenseUnivariatePolynomial, offset = 0) => commit(runtime, section, offset, poly, input.chunkPoints);
  const add = (...points: G1Point[]) => points.reduce((a, b) => runtime.G1.add(a, b), runtime.G1.zero);
  const cL = add(await c(crs.s0, a), await c(crs.sxi, uHat), await c(crs.spsi, wHat));
  const cH = add(await c(crs.sxi, vHat), await c(crs.spsi, bHat));
  const cO = await buildBinding(runtime, input, slots, layout, masks, selectionMask);
  const roots = await SelectedRoots.create(field, setup, input.selector);
  const witness = field.createZeroBuffer(setup.m * setup.s_max);
  for(let j = 0; j < setup.m; j++)
    for(let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if(slot && j < field.bufferElementCount(slot.values))
        field.writeBufferElement(witness, j * setup.s_max + i, field.readBufferElement(slot.values, j));
    }
  const qSelection = await roots.quotients(witness);
  if(crs.weighted.elementCount !== setup.m * setup.s_max || crs.weightedShifted.elementCount !== setup.m * setup.s_max)
    throw new Error("Weighted query cardinality mismatch.");
  const dQ = add(await commitDenseUnivariatePolynomial(runtime, crs.weighted, qSelection, input.chunkPoints), runtime.G1.mulScalar(await c(crs.s0, roots.polynomial), selectionMask));
  const dQK = add(await commitDenseUnivariatePolynomial(runtime, crs.weightedShifted, qSelection, input.chunkPoints), runtime.G1.mulScalar(await c(crs.s0, roots.polynomial, k), selectionMask));
  const transcript = new UnivariateTranscript(field, input.publicInputs.slice(0, setup.l_free));
  transcript.setMessage(encodeG1MessageBlock("F2.a1", runtime.G1, [cL, cH, cO, dQ, dQK]));
  const upsilon = transcript.challenge(1, 0);
  const cD = add(await c(crs.s0, a, k), await c(crs.sxi, uHat.add(vHat.scale(upsilon)), k), await c(crs.spsi, wHat.add(bHat.scale(upsilon)), k));
  transcript.setMessage(encodeG1MessageBlock("F2.a2", runtime.G1, [cD]));
  const [beta, gammaC] = transcript.challengePair(2);
  const copy = await buildCopyRelation(runtime, domain.connectionRoot, domain.connectionSize, maps.bC, sC, bHat, beta, gammaC, maskR);
  const cR = await c(crs.s0, copy.rHat);
  transcript.setMessage(encodeG1MessageBlock("F2.a3", runtime.G1, [cR]));
  const theta = transcript.challenge(3, 0);
  const qHat = combineQuotients(field, qA, copy.qC0, copy.qC1, theta);
  const cQ = await c(crs.s0, qHat);
  transcript.setMessage(encodeG1MessageBlock("F2.a4", runtime.G1, [cQ]));
  const chi = transcript.zeta(domain.arithmeticSize, domain.connectionSize);
  const scPoly = DenseUnivariatePolynomial.fromCoefficients(field, sC.coefficients);
  const evaluations = [scPoly.evaluate(chi), uHat.evaluate(chi), vHat.evaluate(chi), wHat.evaluate(chi), bHat.evaluate(chi),
  copy.rHat.evaluate(chi), copy.rHat.evaluate(field.mul(domain.connectionRoot, chi))] as const;
  transcript.setMessage(encodeEvaluationMessageBlock(field, evaluations));
  const varpi = transcript.challenge(5, 0);
  const ordinary = a.add(copy.rHat.scale(field.pow(varpi, 2))).add(qHat.scale(field.pow(varpi, 3))).add(scPoly.scale(field.pow(varpi, 4)));
  const piChi = add(await c(crs.s0, ordinary.ruffini(chi).quotient), await c(crs.sxi, uHat.add(vHat.scale(varpi)).ruffini(chi).quotient), await c(crs.spsi, wHat.add(bHat.scale(varpi)).ruffini(chi).quotient));
  const piPlus = await c(crs.s0, copy.rHat.ruffini(field.mul(domain.connectionRoot, chi)).quotient);
  transcript.setMessage(encodeG1MessageBlock("F2.a6", runtime.G1, [piChi, piPlus]));
  transcript.nonzeroChallenge(6, 0);
  return { g1: [cL, cH, cO, dQ, dQK, cD, cR, cQ, piChi, piPlus], evaluations };
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
async function buildCopyRelation(runtime: CurveRuntime, root: FieldElement, domainSize: number, b: DenseDomainPolynomial, sC: DenseDomainPolynomial, bHat: DenseUnivariatePolynomial, beta: FieldElement, gammaC: FieldElement, maskR: DenseUnivariatePolynomial): Promise<{
  readonly rHat: DenseUnivariatePolynomial;
  readonly qC0: DenseUnivariatePolynomial;
  readonly qC1: DenseUnivariatePolynomial;
}> {
  const field = runtime.Fr;
  const rEvals = field.createZeroBuffer(domainSize);
  field.writeBufferElement(rEvals, 0, field.one);
  let point = field.one;
  for(let index = 0; index < domainSize; index += 1) {
    const bValue = field.readBufferElement(b.evaluations, index);
    const f = field.add(field.add(bValue, field.mul(beta, field.readBufferElement(sC.evaluations, index))), gammaC);
    const g = field.add(field.add(bValue, field.mul(beta, point)), gammaC);
    if(field.isZero(g))
      throw new Error(`Copy recursion denominator vanishes at index ${index}.`);
    if(index + 1 < domainSize) {
      field.writeBufferElement(rEvals, index + 1, field.div(field.mul(field.readBufferElement(rEvals, index), f), g));
    }
    else if(!field.eq(field.mul(field.readBufferElement(rEvals, index), f), g)) {
      throw new Error("Copy recursion does not close around the connection domain.");
    }
    point = field.mul(point, root);
  }
  const rBase = DenseUnivariatePolynomial.fromCoefficients(field, await field.ifftBuffer(rEvals));
  const rHat = blind(rBase, maskR, domainSize);
  const sCPoly = DenseUnivariatePolynomial.fromCoefficients(field, sC.coefficients);
  const fHat = bHat.add(sCPoly.scale(beta)).add(constant(field, gammaC));
  const gHat = bHat.add(linear(field, gammaC, beta));
  const qC0 = copyBoundaryQuotient(field, rHat, domainSize);
  const qC1 = (await rHat.scaleArgument(root).multiply(gHat)).sub(await rHat.multiply(fHat)).divideVanishingExact(domainSize);
  return { rHat, qC0, qC1 };
}

/** L_0=(X^N-1)/(N*(X-1)); cancel only after checking R_hat(1)=1. */
export function copyBoundaryQuotient(field: CurveRuntime["Fr"], rHat: DenseUnivariatePolynomial, domainSize: number): DenseUnivariatePolynomial {
  const boundary = rHat.ruffini(field.one);
  if (!field.eq(boundary.value, field.one)) throw new Error("Copy boundary R_hat(1) must equal one.");
  return boundary.quotient.scale(field.inv(field.fromBigInt(BigInt(domainSize))));
}

function combineQuotients(
  field: CurveRuntime["Fr"],
  qA: DenseUnivariatePolynomial,
  qC0: DenseUnivariatePolynomial,
  qC1: DenseUnivariatePolynomial,
  theta: FieldElement,
): DenseUnivariatePolynomial {
  return qA.add(qC0.scale(theta)).add(qC1.scale(field.mul(theta, theta)));
}
async function buildBinding(runtime: CurveRuntime, input: UnivariateReferenceProverInput, slots: readonly (UnivariateSlotWitness | null)[], layout: PublicWireLayout, masks: readonly DenseUnivariatePolynomial[], selectionMask: FieldElement): Promise<G1Point> {
  const f = runtime.Fr, { setup, crs } = input;
  const free = input.publicInputs.slice(0, setup.l_free).filter((_, g) => layout.sourceForPublicWire(g) !== undefined);
  if(crs.freePublic.elementCount !== free.length)
    throw new Error("Free-public query cardinality mismatch.");
  let result = free.length === 0 ? runtime.G1.zero : await commitDenseUnivariatePolynomial(runtime, crs.freePublic, f.concat(free), input.chunkPoints);
  const wireLists = input.subcircuitInfos.map(info => info.flattenMap.flatMap((g, j) => g >= setup.l ? [j] : []));
  const perPlacement = wireLists.reduce((n, list) => n + list.length, 0);
  if(crs.nonpublic.elementCount !== perPlacement * setup.s_max)
    throw new Error("Nonpublic query cardinality mismatch.");
  for(let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if(!slot)
      continue;
    const prefix = wireLists.slice(0, slot.subcircuitId).reduce((n, list) => n + list.length, 0);
    const wires = wireLists[slot.subcircuitId]!;
    if(wires.length)
      result = runtime.G1.add(result, await commitDenseUnivariatePolynomial(runtime, crs.nonpublic, f.concat(wires.map(j => f.readBufferElement(slot.values, j))), input.chunkPoints, i * perPlacement + prefix));
  }
  for(let i = 0; i < 4; i++)
    result = runtime.G1.add(result, await commitDenseUnivariatePolynomial(runtime, crs.masks[i]!, masks[i]!.coefficients, input.chunkPoints));
  return runtime.G1.add(result, runtime.G1.mulScalar(crs.maskSelection, selectionMask));
}
function validatePublicStatement(runtime: CurveRuntime, input: UnivariateReferenceProverInput, slots: readonly (UnivariateSlotWitness | null)[], layout: PublicWireLayout): void {
  if(input.publicInputs.length !== input.setup.l)
    throw new Error("Public statement length mismatch.");
  const publicIds = new Set(layout.segments().map(s => s.subcircuitId));
  for(const [i, slot] of slots.entries())
    if(slot && publicIds.has(slot.subcircuitId) && i !== slot.subcircuitId)
      throw new Error("Public buffer appears outside its fixed placement.");
  for(let g = 0; g < input.setup.l; g++) {
    const source = layout.sourceForPublicWire(g);
    let expected = runtime.Fr.zero;
    if(source) {
      // Public wires alone specialize placement index == subcircuit ID.
      const slot = slots[source.subcircuitId];
      if(!slot || slot.subcircuitId !== source.subcircuitId)
        throw new Error("Missing fixed public-buffer placement.");
      expected = runtime.Fr.readBufferElement(slot.values, source.localWireIndex);
    }
    if(!runtime.Fr.eq(expected, input.publicInputs[g]!))
      throw new Error("Public input differs from witness or structural zero padding.");
  }
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
