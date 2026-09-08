import type { CurveRuntime } from '../../runtime/curve/curve.js';
import type { PreprocessComputation, PreprocessRuntimeInput } from './runtime-input.js';
import { commitDenseUnivariatePolynomial, commitStridedUnivariatePolynomial } from '../../univariate/commitments.js';
import { deriveUnivariateDomainShape } from '../../univariate/domain.js';
import { buildConnectionPermutationPolynomial } from '../../univariate/relation.js';
import { placementSelectorPolynomial } from '../../univariate/selectors.js';

export interface PreprocessSnarkOptions {
  readonly denseMsmChunkPoints?: number;
}

const DEFAULT_DENSE_MSM_CHUNK_POINTS = 1 << 18;

export async function preprocessSnark(
  runtime: CurveRuntime,
  input: PreprocessRuntimeInput,
  options: PreprocessSnarkOptions = {},
): Promise<PreprocessComputation> {
  const chunkPoints = options.denseMsmChunkPoints ?? DEFAULT_DENSE_MSM_CHUNK_POINTS;
  const domain = deriveUnivariateDomainShape(runtime.Fr, input.setup);
  const [selector, permutation] = await Promise.all([
    placementSelectorPolynomial(runtime.Fr, domain, input.setup, input.selector),
    buildConnectionPermutationPolynomial(runtime.Fr, domain, input.setup, input.permutation),
  ]);
  const [sKappa, sC] = await Promise.all([
    commitStridedUnivariatePolynomial(runtime, input.crs.s0, selector, chunkPoints),
    commitDenseUnivariatePolynomial(runtime, input.crs.s0, permutation.coefficients, chunkPoints),
  ]);

  return { sKappa, sC };
}
