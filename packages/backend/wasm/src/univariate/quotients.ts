import type { FieldElement, FieldRuntime } from "../runtime/field/field-types.js";
import { DenseUnivariatePolynomial as P } from "./polynomial.js";

/** Expand only the short masks; the main arithmetic product stays unmasked. */
export async function arithmeticQuotient(
  field: FieldRuntime, domainSize: number, u: P, v: P, w: P,
  maskU: P, maskV: P, maskW: P,
): Promise<P> {
  const base = await (await P.linearCombination(field, [[await u.multiply(v), field.one], [w, field.neg(field.one)]])).divideVanishingExactBatched(domainSize);
  return P.linearCombination(field, [
    [base, field.one], [await u.multiply(maskV), field.one], [await v.multiply(maskU), field.one],
    [(await maskU.multiply(maskV)).multiplyVanishing(domainSize), field.one], [maskW, field.neg(field.one)],
  ]);
}

/** Z(omega*X)=Z(X); preserve every cross term of the masked copy product. */
export async function copyProductQuotient(
  field: FieldRuntime, domainSize: number, root: FieldElement,
  r: P, f: P, g: P, maskR: P, maskB: P,
): Promise<P> {
  const shifted = P.fromCoefficients(field, await field.batchApplyKeyBuffer(r.coefficients, field.one, root));
  const shiftedMask = maskR.scaleArgument(root);
  const base = await (await P.linearCombination(field, [
    [await shifted.multiply(g), field.one], [await r.multiply(f), field.neg(field.one)],
  ])).divideVanishingExactBatched(domainSize);
  const deltaR = await P.linearCombination(field, [[shifted, field.one], [r, field.neg(field.one)]]);
  return P.linearCombination(field, [
    [base, field.one], [await deltaR.multiply(maskB), field.one],
    [await shiftedMask.multiply(g), field.one], [await maskR.multiply(f), field.neg(field.one)],
    [(await shiftedMask.sub(maskR).multiply(maskB)).multiplyVanishing(domainSize), field.one],
  ]);
}
