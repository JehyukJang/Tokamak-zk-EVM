import type { SetupParams } from "../artifacts/setup/setup-params.js";
import type { CurveRuntime } from "../runtime/curve/curve.js";
import type { FieldElement } from "../runtime/field/field-types.js";
import type { G1Point } from "../runtime/group/group.js";
import { PublicWireLayout } from "../prover/protocol/public-wire-layout.js";
import type { ProverSubcircuitInfo } from "../prover/protocol/witness.js";
import type { UnivariateVerifierCrsRuntime } from "./crs.js";
import { arithmeticComplementAt, connectionComplementAt, deriveUnivariateDomainShape, unionVanishingAt } from "./domain.js";
import type { UnivariateProof } from "./proof.js";
import { encodeEvaluationMessageBlock, encodeG1MessageBlock, UnivariateTranscript } from "./transcript.js";

export interface UnivariateReferenceVerifierInput {
  readonly setup: SetupParams;
  readonly subcircuitInfos: readonly ProverSubcircuitInfo[];
  readonly selector: readonly (number | null)[];
  readonly publicInputs: readonly FieldElement[];
  readonly crs: UnivariateVerifierCrsRuntime;
  readonly preprocess: readonly [G1Point, G1Point];
  readonly proof: UnivariateProof;
}

/** Direct U32/U35 verifier after immutable configuration admission. */
export async function verifyUnivariateReference(
  runtime: CurveRuntime,
  input: UnivariateReferenceVerifierInput,
): Promise<boolean> {
  const field = runtime.Fr;
  const domain = deriveUnivariateDomainShape(field, input.setup);
  if (!hasSufficientCapacity(input.crs, domain.arithmeticSize, domain.connectionSize)) return false;
  if (input.publicInputs.length !== input.setup.l) return false;
  const layout = PublicWireLayout.derive(input.setup, input.subcircuitInfos);
  for (const segment of layout.segments()) {
    if (input.selector[segment.placementPhase] !== segment.subcircuitId) {
      return false;
    }
  }
  const publicBinding = await buildPublicBinding(runtime, input.publicInputs, layout, input.crs);
  const [cU, cV, cW, cB, oIf, oInt, cD, cR, cQ, piZeta, piPlus] = input.proof.g1;
  const [sA, sC, u, v, w, b, qZeta, r, rPlus] = input.proof.evaluations;
  const transcript = new UnivariateTranscript(field, input.publicInputs);
  transcript.appendMessageBlock(1, encodeG1MessageBlock("F2.a1", runtime.G1, [cU, cV, cW, cB, oIf, oInt]));
  const upsilon = transcript.challenge(1, 0);
  if (!runtime.G1.eq(cD, runtime.G1.add(cW, runtime.G1.mulScalar(cB, upsilon)))) return false;
  transcript.appendMessageBlock(2, encodeG1MessageBlock("F2.a2", runtime.G1, [cD]));
  const [beta, gammaC] = transcript.challengePair(2);
  transcript.appendMessageBlock(3, encodeG1MessageBlock("F2.a3", runtime.G1, [cR]));
  const theta = transcript.challenge(3, 0);
  transcript.appendMessageBlock(4, encodeG1MessageBlock("F2.a4", runtime.G1, [cQ]));
  const zeta = transcript.zeta(domain.arithmeticSize, domain.connectionSize);
  transcript.appendMessageBlock(5, encodeEvaluationMessageBlock(field, input.proof.evaluations));
  const varpi = transcript.challenge(5, 0);
  transcript.appendMessageBlock(6, encodeG1MessageBlock("F2.a6", runtime.G1, [piZeta, piPlus]));
  const mu = transcript.nonzeroChallenge(6, 0);

  const quotient = field.add(
    field.add(
      field.mul(arithmeticComplementAt(field, domain, zeta), field.mul(sA, field.sub(field.mul(u, v), w))),
      field.mul(
        field.mul(theta, connectionComplementAt(field, domain, zeta)),
        field.mul(field.sub(r, field.one), lagrangeZero(field, zeta, domain.connectionSize)),
      ),
    ),
    field.mul(
      field.mul(field.mul(theta, theta), connectionComplementAt(field, domain, zeta)),
      field.sub(
        field.mul(rPlus, field.add(field.add(b, field.mul(beta, zeta)), gammaC)),
        field.mul(r, field.add(field.add(b, field.mul(beta, sC)), gammaC)),
      ),
    ),
  );
  if (!field.eq(quotient, field.mul(qZeta, unionVanishingAt(field, domain, zeta)))) return false;

  const aZeta = addPoints(runtime, [
    runtime.G1.sub(cU, runtime.G1.mulAffineScalar(input.crs.oneG1, u)),
    runtime.G1.mulScalar(runtime.G1.sub(cV, runtime.G1.mulAffineScalar(input.crs.xiG1, v)), varpi),
    runtime.G1.mulScalar(runtime.G1.sub(cW, runtime.G1.mulAffineScalar(input.crs.psiG1, w)), field.pow(varpi, 2)),
    runtime.G1.mulScalar(runtime.G1.sub(cB, runtime.G1.mulAffineScalar(input.crs.psiG1, b)), field.pow(varpi, 3)),
    runtime.G1.mulScalar(runtime.G1.sub(cR, runtime.G1.mulAffineScalar(input.crs.oneG1, r)), field.pow(varpi, 4)),
    runtime.G1.mulScalar(runtime.G1.sub(cQ, runtime.G1.mulAffineScalar(input.crs.oneG1, qZeta)), field.pow(varpi, 5)),
    runtime.G1.mulScalar(runtime.G1.sub(input.preprocess[0], runtime.G1.mulAffineScalar(input.crs.oneG1, sA)), field.pow(varpi, 6)),
    runtime.G1.mulScalar(runtime.G1.sub(input.preprocess[1], runtime.G1.mulAffineScalar(input.crs.oneG1, sC)), field.pow(varpi, 7)),
  ]);
  const aPlus = runtime.G1.sub(cR, runtime.G1.mulAffineScalar(input.crs.oneG1, rPlus));
  const lhsFirst = addPoints(runtime, [
    cU,
    cV,
    cW,
    runtime.G1.neg(runtime.G1.mulScalar(cD, mu)),
    runtime.G1.mulScalar(runtime.G1.add(aZeta, runtime.G1.mulScalar(piZeta, zeta)), field.pow(mu, 2)),
    runtime.G1.mulScalar(runtime.G1.add(aPlus, runtime.G1.mulScalar(piPlus, field.mul(domain.connectionRoot, zeta))), field.pow(mu, 3)),
  ]);
  const lhsSecond = runtime.G1.add(cB, runtime.G1.mulScalar(runtime.G1.add(cW, runtime.G1.mulScalar(cB, upsilon)), mu));
  const rhsOpenings = runtime.G1.add(runtime.G1.mulScalar(piZeta, field.pow(mu, 2)), runtime.G1.mulScalar(piPlus, field.pow(mu, 3)));
  return runtime.pairing.productsEqual(
    [{ g1: lhsFirst, g2: input.crs.oneG2 }, { g1: lhsSecond, g2: input.crs.tauKG2 }],
    [
      { g1: publicBinding, g2: input.crs.gammaG2 },
      { g1: oIf, g2: input.crs.etaG2 },
      { g1: oInt, g2: input.crs.deltaG2 },
      { g1: rhsOpenings, g2: input.crs.tauG2 },
    ],
  );
}

async function buildPublicBinding(
  runtime: CurveRuntime,
  publicInputs: readonly FieldElement[],
  layout: PublicWireLayout,
  crs: UnivariateVerifierCrsRuntime,
): Promise<G1Point> {
  const queries = new Map<string, G1Point>();
  for (let index = 0; index < crs.publicQueries.points.elementCount; index += 1) {
    const key = await crs.publicQueries.keyAt(index);
    const encoded = `${key.bufferSubcircuitId}:${key.localPublicWireIndex}`;
    if (queries.has(encoded)) throw new Error(`Verifier CRS duplicates public query ${encoded}.`);
    queries.set(encoded, await crs.publicQueries.points.readElement(index));
  }
  const bases: G1Point[] = [];
  const scalars: FieldElement[] = [];
  for (const [globalIndex, value] of publicInputs.entries()) {
    const key = layout.publicQueryKeyForPublicWire(globalIndex);
    if (key === undefined) continue;
    const point = queries.get(`${key.bufferSubcircuitId}:${key.localPublicWireIndex}`);
    if (point === undefined) throw new Error("Verifier CRS is missing a required public binding query.");
    bases.push(point);
    scalars.push(value);
  }
  return bases.length === 0 ? runtime.G1.zero : runtime.G1.msmAffine(bases, scalars);
}

function hasSufficientCapacity(crs: UnivariateVerifierCrsRuntime, arithmetic: number, connection: number): boolean {
  const [m0, mXi, mPsi] = crs.declaredCapacity;
  return m0 + 1n >= BigInt(arithmetic) && mXi + 1n >= BigInt(arithmetic) && mPsi + 1n >= BigInt(connection) + crs.k;
}

function lagrangeZero(field: CurveRuntime["Fr"], point: FieldElement, domainSize: number): FieldElement {
  const inverse = field.inv(field.fromBigInt(BigInt(domainSize)));
  let sum = field.zero;
  let power = field.one;
  for (let index = 0; index < domainSize; index += 1) {
    sum = field.add(sum, power);
    power = field.mul(power, point);
  }
  return field.mul(sum, inverse);
}

function addPoints(runtime: CurveRuntime, points: readonly G1Point[]): G1Point {
  return points.reduce((sum, point) => runtime.G1.add(sum, point), runtime.G1.zero);
}
