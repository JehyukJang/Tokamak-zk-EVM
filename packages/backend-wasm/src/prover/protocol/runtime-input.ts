import type { FieldElement } from '../../runtime/field/field-runtime.js';
import type { ProverPermutationEntry, ProverWitnessInput } from './witness.js';

export interface ProverCrsG1Section {
  readonly data: Uint8Array;
  readonly count: number;
  readonly elementByteLength: number;
}

export interface ProverCrsRuntime {
  readonly G: Uint8Array;
  readonly H: Uint8Array;
  readonly lagrangeKL: Uint8Array;
  readonly sigma1: {
    readonly x: Uint8Array;
    readonly y: Uint8Array;
    readonly delta: Uint8Array;
    readonly eta: Uint8Array;
    readonly xyPowers: ProverCrsG1Section;
    readonly gammaInvOInst: ProverCrsG1Section;
    readonly etaInvLiOInterAlpha4Kj: ProverCrsG1Section;
    readonly deltaInvLiOPrv: ProverCrsG1Section;
    readonly deltaInvAlphakXhTx: ProverCrsG1Section;
    readonly deltaInvAlpha4XjTx: ProverCrsG1Section;
    readonly deltaInvAlphakYiTy: ProverCrsG1Section;
  };
  readonly sigma2: Record<'alpha' | 'alpha2' | 'alpha3' | 'alpha4' | 'gamma' | 'delta' | 'eta' | 'x' | 'y', Uint8Array>;
}

export interface ProverRuntimeInput {
  readonly witness: ProverWitnessInput;
  readonly permutation: readonly ProverPermutationEntry[];
  readonly publicInstance: readonly FieldElement[];
  readonly crs: ProverCrsRuntime;
}

export function proverCrsG1PointAt(section: ProverCrsG1Section, index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0 || index >= section.count)
    throw new Error(`Prover CRS G1 point index ${index} is out of range.`);
  return section.data.subarray(index * section.elementByteLength, (index + 1) * section.elementByteLength);
}

export function proverCrsG1PointRange(section: ProverCrsG1Section, start: number, count: number): Uint8Array {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(count) ||
    start < 0 ||
    count < 0 ||
    start + count > section.count
  )
    throw new Error(`Prover CRS G1 point range [${start}, ${start + count}) is out of range.`);
  return section.data.subarray(start * section.elementByteLength, (start + count) * section.elementByteLength);
}
