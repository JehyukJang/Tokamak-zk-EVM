import type { SetupParams } from "./setup-params.js";

const NUMERIC_SETUP_FIELDS: readonly (keyof SetupParams)[] = [
  "l_free",
  "l",
  "l_user_out",
  "l_user",
  "l_D",
  "m_D",
  "n",
  "s_D",
  "s_max",
];

/** Validates the setup relationships required by every browser protocol path. */
export function validateSetupParams(setup: SetupParams): void {
  for (const field of NUMERIC_SETUP_FIELDS) {
    if (!Number.isSafeInteger(setup[field]) || setup[field] < 0) {
      throw new Error(`Invalid setup parameter '${field}'.`);
    }
  }

  if (setup.l_user_out > setup.l_user || setup.l_user > setup.l_free) {
    throw new Error("Setup user-public boundaries are invalid.");
  }
  if (setup.l_free > setup.l || setup.l_D <= setup.l || setup.l_D > setup.m_D) {
    throw new Error("Setup public and interface boundaries are invalid.");
  }
  if (setup.n <= 0 || setup.s_max <= 0) {
    throw new Error("Setup n and s_max must be positive.");
  }
  if (!isPowerOfTwo(setup.l_D - setup.l) || !isPowerOfTwo(setup.n) || !isPowerOfTwo(setup.s_max)) {
    throw new Error("Setup m_i, n, and s_max domains must be powers of two.");
  }
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return false;
  }

  let remaining = value;
  while (remaining % 2 === 0) {
    remaining /= 2;
  }
  return remaining === 1;
}
