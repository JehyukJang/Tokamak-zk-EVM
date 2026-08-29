import type { CurveRuntime } from '../../runtime/curve/curve.js';
import type { ProverBinding } from '../commitments/binding-commitments.js';
import type { ChallengeEvaluations } from './challenge-evaluations.js';
import type { CopyQuotientComputation } from './copy-quotient.js';
import type { InitialRelationComputation } from './initial-relation.js';
import type { OpeningCommitmentsComputation } from './opening-commitments.js';
import type { RecursionComputation } from './recursion-commitment.js';

export interface ProverVerifierProofOutputInput {
  readonly runtime: CurveRuntime;
  readonly binding: ProverBinding;
  readonly initialRelation: InitialRelationComputation;
  readonly recursion: RecursionComputation;
  readonly copyQuotient: CopyQuotientComputation;
  readonly evaluations: ChallengeEvaluations;
  readonly openings: OpeningCommitmentsComputation;
}
