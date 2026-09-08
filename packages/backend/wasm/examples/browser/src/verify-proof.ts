import {
  install as installVerifier,
  verify,
  type VerifierInstallationInfo,
} from "@tokamak-zk-evm/snark-browser-compat/verifier";

import { loadBinary } from "./load-binary.js";

export interface VerifierExampleInput {
  readonly proof: Uint8Array;
  readonly instance: string | URL;
  readonly selector: string | URL;
  readonly permutation: string | URL;
  readonly preprocessCrs: string | URL;
  readonly verifierPreprocess: Uint8Array;
  readonly verifierCrs: string | URL;
}

export function installVerifierRuntime(): Promise<VerifierInstallationInfo> {
  return installVerifier();
}

export async function verifyProof(input: VerifierExampleInput): Promise<boolean> {
  const [instance, selector, permutation, preprocessCrs, verifierCrs] = await Promise.all([
    loadBinary(input.instance),
    loadBinary(input.selector),
    loadBinary(input.permutation),
    loadBinary(input.preprocessCrs),
    loadBinary(input.verifierCrs),
  ]);
  return verify({
    proof: input.proof,
    instance,
    selector,
    permutation,
    preprocessCrs,
    verifierPreprocess: input.verifierPreprocess,
    verifierCrs,
  });
}
