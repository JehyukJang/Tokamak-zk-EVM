import type { SetupParams } from '../../artifacts/setup/setup-params.js';
import type { UnivariatePermutationEntry } from '../../univariate/relation.js';
import type { UnivariatePreprocessCrsRuntime } from '../../univariate/crs.js';

export interface PreprocessRuntimeInput {
  readonly setup: SetupParams;
  readonly selector: readonly (number | null)[];
  readonly permutation: readonly UnivariatePermutationEntry[];
  readonly crs: UnivariatePreprocessCrsRuntime;
}

export interface PreprocessComputation {
  readonly sKappa: Uint8Array;
  readonly sC: Uint8Array;
}
