import {
  convertInstance,
  convertPermutation,
  convertSelector,
  convertUnivariateCrs,
  convertWitness,
} from "@tokamak-zk-evm/snark-browser-compat/converter";

export interface ArtifactSources {
  readonly witness: unknown;
  readonly selector: unknown;
  readonly permutation: unknown;
  readonly instance: unknown;
  readonly univariateCrs: unknown;
}

export async function prepareArtifacts(sources: ArtifactSources): Promise<{
  readonly witness: Uint8Array;
  readonly selector: Uint8Array;
  readonly permutation: Uint8Array;
  readonly instance: Uint8Array;
  readonly proverCrs: Uint8Array;
  readonly preprocessCrs: Uint8Array;
  readonly verifierCrs: Uint8Array;
}> {
  const [witness, selector, permutation, instance, crs] =
    await Promise.all([
      convertWitness(sources.witness),
      convertSelector(sources.selector),
      convertPermutation(sources.permutation),
      convertInstance(sources.instance),
      convertUnivariateCrs(sources.univariateCrs),
    ]);

  return {
    witness,
    selector,
    permutation,
    instance,
    ...crs,
  };
}
