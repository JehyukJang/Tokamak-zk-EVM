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
  if (!field.eq(root, field.rootOfUnity(domainSize))) throw new Error("Copy quotient requires the connection domain's canonical root.");
  const shifted = P.fromCoefficients(field, await field.batchApplyKeyBuffer(r.coefficients, field.one, root));
  const shiftedMask = maskR.scaleArgument(root);
  const base = await (await copyProductDifference(field, domainSize, r, f, g)).divideVanishingExactBatched(domainSize);
  const deltaR = await P.linearCombination(field, [[shifted, field.one], [r, field.neg(field.one)]]);
  return P.linearCombination(field, [
    [base, field.one], [await deltaR.multiply(maskB), field.one],
    [await shiftedMask.multiply(g), field.one], [await maskR.multiply(f), field.neg(field.one)],
    [(await shiftedMask.sub(maskR).multiply(maskB)).multiplyVanishing(domainSize), field.one],
  ]);
}

/** On a 2N-point FFT domain, R(omega_N*X) is R's spectrum rotated by two. */
export async function copyProductDifference(field: FieldRuntime, domainSize: number, r: P, f: P, g: P): Promise<P> {
  const size = 2 * domainSize;
  // These bounds prevent cyclic convolution from aliasing the coefficients.
  if (r.degree >= domainSize || f.degree > domainSize || g.degree > domainSize) throw new Error("Copy product exceeds its interpolation domain.");
  if (!field.eq(field.pow(field.rootOfUnity(size), 2), field.rootOfUnity(domainSize))) throw new Error("Incompatible FFT roots for copy spectrum rotation.");
  const transform = async (p: P) => {
    const padded = field.createZeroBuffer(size);
    padded.set(p.coefficients);
    return field.fftBuffer(padded);
  };
  // Each FFT already uses the runtime's workers; do not launch competing FFT pools.
  const spectrumR = await transform(r), spectrumF = await transform(f), spectrumG = await transform(g);
  const rotated = field.createZeroBuffer(size), offset = (2 % size) * field.byteLength;
  rotated.set(spectrumR.subarray(offset));
  rotated.set(spectrumR.subarray(0, offset), spectrumR.byteLength - offset);
  const difference = await field.batchSubBuffer(await field.batchMulBuffer(rotated, spectrumG), await field.batchMulBuffer(spectrumR, spectrumF));
  return P.fromCoefficients(field, await field.ifftBuffer(difference));
}
