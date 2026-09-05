import type { SetupParams } from "../artifacts/setup/setup-params.js";
import { validateSetupParams } from "../artifacts/setup/validate-setup-params.js";
import { UNIVARIATE_DOMAIN_CONTRACT } from "../generated/univariate-domain-contract.generated.js";
import type { FieldElement, FieldRuntime } from "../runtime/field/field-types.js";

export interface UnivariateDomainShape {
  readonly schema: typeof UNIVARIATE_DOMAIN_CONTRACT.protocolSchema;
  readonly subcircuitCapacity: number;
  readonly arithmeticSize: number;
  readonly connectionSize: number;
  readonly intersectionSize: number;
  readonly unionSize: number;
  readonly arithmeticRoot: FieldElement;
  readonly connectionRoot: FieldElement;
}

/**
 * Derives the U1/U4 domains from the published library dimensions.
 *
 * `t` deliberately exceeds the real catalog size. Its unused ID suffix gives
 * the arithmetic domain a radix-two size without changing the selector or
 * library input formats.
 */
export function deriveUnivariateDomainShape(
  field: FieldRuntime,
  setup: SetupParams,
): UnivariateDomainShape {
  validateSetupParams(setup);
  const subcircuitCapacity = strictPowerOfTwoAbove(setup.s_D);
  const arithmeticSize = checkedProduct("N_A", setup.n, setup.s_max, subcircuitCapacity);
  const connectionSize = checkedProduct("N_C", setup.l_D - setup.l, setup.s_max);
  const intersectionSize = greatestCommonDivisor(arithmeticSize, connectionSize);

  return {
    schema: UNIVARIATE_DOMAIN_CONTRACT.protocolSchema,
    subcircuitCapacity,
    arithmeticSize,
    connectionSize,
    intersectionSize,
    unionSize: leastCommonMultiple(arithmeticSize, connectionSize),
    arithmeticRoot: field.rootOfUnity(arithmeticSize),
    connectionRoot: field.rootOfUnity(connectionSize),
  };
}

/** U1's canonical flat arithmetic-domain index. */
export function arithmeticIndex(
  domain: UnivariateDomainShape,
  setup: SetupParams,
  placementIndex: number,
  subcircuitId: number,
  constraintRow: number,
): number {
  assertIndex(placementIndex, setup.s_max, "placement");
  assertIndex(subcircuitId, domain.subcircuitCapacity, "subcircuit");
  assertIndex(constraintRow, setup.n, "constraint row");
  return checkedSum(
    "U1 index",
    checkedNonnegativeProduct("U1 row offset", setup.s_max, domain.subcircuitCapacity, constraintRow),
    checkedNonnegativeProduct("U1 subcircuit offset", setup.s_max, subcircuitId),
    placementIndex,
  );
}

/** U4's canonical flat connection-domain index. */
export function connectionIndex(
  setup: SetupParams,
  placementIndex: number,
  interfaceWireIndex: number,
): number {
  assertIndex(placementIndex, setup.s_max, "placement");
  assertIndex(interfaceWireIndex, setup.l_D - setup.l, "interface wire");
  return checkedSum(
    "U4 index",
    checkedNonnegativeProduct("U4 wire offset", setup.s_max, interfaceWireIndex),
    placementIndex,
  );
}

export function arithmeticVanishingAt(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  point: FieldElement,
): FieldElement {
  return field.sub(field.pow(point, domain.arithmeticSize), field.one);
}

export function connectionVanishingAt(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  point: FieldElement,
): FieldElement {
  return field.sub(field.pow(point, domain.connectionSize), field.one);
}

export function intersectionVanishingAt(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  point: FieldElement,
): FieldElement {
  return field.sub(field.pow(point, domain.intersectionSize), field.one);
}

export function unionVanishingAt(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  point: FieldElement,
): FieldElement {
  return field.mul(
    arithmeticVanishingAt(field, domain, point),
    arithmeticComplementAt(field, domain, point),
  );
}

/** `M_A = Z_C / Z_G`, evaluated as an exact geometric polynomial. */
export function arithmeticComplementAt(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  point: FieldElement,
): FieldElement {
  return vanishingQuotientAt(field, point, domain.connectionSize, domain.intersectionSize);
}

/** `M_C = Z_A / Z_G`, evaluated as an exact geometric polynomial. */
export function connectionComplementAt(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  point: FieldElement,
): FieldElement {
  return vanishingQuotientAt(field, point, domain.arithmeticSize, domain.intersectionSize);
}

function strictPowerOfTwoAbove(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("s_D must be a positive safe integer.");
  }

  let capacity = 1;
  while (capacity <= value) {
    if (capacity > Number.MAX_SAFE_INTEGER / 2) {
      throw new Error("t exceeds the supported safe-integer range.");
    }
    capacity *= 2;
  }
  return capacity;
}

function checkedProduct(name: string, ...values: readonly number[]): number {
  const result = values.reduce((product, value) => product * value, 1);
  if (!Number.isSafeInteger(result) || result <= 1) {
    throw new Error(`${name} must be a safe integer greater than one.`);
  }
  return result;
}

function assertIndex(value: number, limit: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= limit) {
    throw new Error(`${label} index is outside its admitted range.`);
  }
}

function checkedNonnegativeProduct(name: string, ...values: readonly number[]): number {
  const result = values.reduce((product, value) => product * value, 1);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return result;
}

function checkedSum(name: string, ...values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return result;
}

function leastCommonMultiple(left: number, right: number): number {
  const gcd = greatestCommonDivisor(left, right);
  const result = (left / gcd) * right;
  if (!Number.isSafeInteger(result)) {
    throw new Error("Z_union domain size exceeds the supported safe-integer range.");
  }
  return result;
}

function vanishingQuotientAt(
  field: FieldRuntime,
  point: FieldElement,
  dividendSize: number,
  divisorSize: number,
): FieldElement {
  if (dividendSize % divisorSize !== 0) {
    throw new Error("Vanishing-polynomial quotient requires an integral domain-size ratio.");
  }

  const stride = field.pow(point, divisorSize);
  let term = field.one;
  let sum = field.zero;
  for (let index = 0; index < dividendSize / divisorSize; index += 1) {
    sum = field.add(sum, term);
    term = field.mul(term, stride);
  }
  return sum;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}
