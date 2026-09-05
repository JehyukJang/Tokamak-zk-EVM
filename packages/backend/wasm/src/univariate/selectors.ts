import type { SetupParams } from "../artifacts/setup/setup-params.js";
import type { FieldElement, FieldRuntime } from "../runtime/field/field-types.js";
import type { UnivariateDomainShape } from "./domain.js";

/** A polynomial whose nonzero coefficients occur only every `stride` powers. */
export interface StridedPolynomial {
  readonly stride: number;
  readonly coefficients: readonly FieldElement[];
}

export function evaluateStridedPolynomial(
  field: FieldRuntime,
  polynomial: StridedPolynomial,
  point: FieldElement,
): FieldElement {
  const base = field.pow(point, polynomial.stride);
  return polynomial.coefficients.reduceRight(
    (accumulator, coefficient) => field.add(field.mul(accumulator, base), coefficient),
    field.zero,
  );
}

/** Builds the U2 arithmetic-coset selector without materializing `N_A` values. */
export async function arithmeticCosetSelector(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  placementIndex: number,
  subcircuitId: number,
): Promise<StridedPolynomial> {
  assertIndex(placementIndex, setup.s_max, "placement");
  assertIndex(subcircuitId, domain.subcircuitCapacity, "subcircuit");
  const evaluations = Array.from(
    { length: arithmeticLabelCount(domain, setup) },
    () => field.zero,
  );
  evaluations[placementIndex + setup.s_max * subcircuitId] = field.one;
  return {
    stride: setup.n,
    coefficients: await field.ifft(evaluations),
  };
}

/**
 * Builds U9a directly from the capacity-length placement selector. IDs in the
 * `t - s_D` arithmetic padding range are deliberately rejected.
 */
export async function placementSelectorPolynomial(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  selector: readonly (number | null)[],
): Promise<StridedPolynomial> {
  if (selector.length !== setup.s_max) {
    throw new Error(`Selector capacity is ${selector.length}, expected ${setup.s_max}.`);
  }
  const evaluations = Array.from(
    { length: arithmeticLabelCount(domain, setup) },
    () => field.zero,
  );
  for (const [placementIndex, subcircuitId] of selector.entries()) {
    if (subcircuitId === null) {
      continue;
    }
    assertIndex(subcircuitId, setup.s_D, "subcircuit");
    evaluations[placementIndex + setup.s_max * subcircuitId] = field.one;
  }
  return {
    stride: setup.n,
    coefficients: await field.ifft(evaluations),
  };
}

/** Builds the U5 connection-coset selector without materializing `N_C` values. */
export async function connectionCosetSelector(
  field: FieldRuntime,
  setup: SetupParams,
  placementIndex: number,
): Promise<StridedPolynomial> {
  assertIndex(placementIndex, setup.s_max, "placement");
  const evaluations = Array.from({ length: setup.s_max }, () => field.zero);
  evaluations[placementIndex] = field.one;
  return {
    stride: setup.l_D - setup.l,
    coefficients: await field.ifft(evaluations),
  };
}

function arithmeticLabelCount(domain: UnivariateDomainShape, setup: SetupParams): number {
  const count = setup.s_max * domain.subcircuitCapacity;
  if (!Number.isSafeInteger(count) || !isPowerOfTwo(count)) {
    throw new Error("Arithmetic selector-label domain must be a power of two.");
  }
  return count;
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return false;
  }
  let current = 1;
  while (current < value) {
    current *= 2;
  }
  return current === value;
}

function assertIndex(value: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= limit) {
    throw new Error(`${label} index is outside its admitted range.`);
  }
}
