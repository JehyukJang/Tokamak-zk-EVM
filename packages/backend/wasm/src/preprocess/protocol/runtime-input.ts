import type { SetupParams } from '../../artifacts/setup/setup-params.js';
import type { PermutationEntry } from '../../runtime/polynomial/permutation-polynomials.js';

export interface PreprocessRuntimeInput {
  readonly setup: SetupParams;
  readonly permutation: readonly PermutationEntry[];
  readonly functionInstance: Uint8Array;
  readonly crs: { readonly xyPowers: Uint8Array; readonly gammaInvOInst: Uint8Array };
}

export interface PreprocessComputation {
  readonly s0: Uint8Array;
  readonly s1: Uint8Array;
  readonly oPubFix: Uint8Array;
}
