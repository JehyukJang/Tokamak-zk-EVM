import type { FieldElement, FieldRuntime } from "../../runtime/field/field-runtime.js";
import type { SetupParams } from "../../artifacts/setup/setup-params.js";
import { validateSetupParams } from "../../artifacts/setup/validate-setup-params.js";
import type { VerifierChallenges } from "./challenges.js";

export interface VerifierDomainContext {
  readonly mI: number;
  readonly omegaMI: FieldElement;
  readonly omegaSMax: FieldElement;
  readonly tNEval: FieldElement;
  readonly tMIEval: FieldElement;
  readonly tSMaxEval: FieldElement;
}

export type VerifierSetupParams = SetupParams;

export function buildDomainContext(
  field: FieldRuntime,
  setup: VerifierSetupParams,
  challenges: VerifierChallenges,
): VerifierDomainContext {
  validateSetupParams(setup);
  const mI = setup.l_D - setup.l;

  return {
    mI,
    omegaMI: field.rootOfUnity(mI),
    omegaSMax: field.rootOfUnity(setup.s_max),
    tNEval: field.sub(field.pow(challenges.chi, setup.n), field.one),
    tMIEval: field.sub(field.pow(challenges.chi, mI), field.one),
    tSMaxEval: field.sub(field.pow(challenges.zeta, setup.s_max), field.one),
  };
}
