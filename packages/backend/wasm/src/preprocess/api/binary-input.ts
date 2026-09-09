import { requireBinaryArtifactSection } from '../../artifacts/binary/binary-artifact-file.js';
import { type BinaryArtifactFileView } from '../../artifacts/binary/binary-format.js';
import { admitRuntimeBinaryArtifact } from '../../artifacts/binary/runtime-admission.js';
import {
  PROVER_PERMUTATION_V1_SPEC,
  PROVER_SELECTOR_V1_SPEC,
} from '../../generated/browser-artifact-contracts.generated.js';
import { assertBinaryArtifactCompatibility } from '../../artifacts/binary/compatibility.js';
import { GENERATED_SETUP_PARAMS } from '../../generated/active/setup.generated.js';
import { parseUnivariatePreprocessCrs, type UnivariateCrsChunkInput } from '../../univariate/crs.js';
import type { UnivariatePermutationEntry } from '../../univariate/relation.js';
import type { PreprocessRuntimeInput } from '../protocol/runtime-input.js';
export type { PreprocessRuntimeInput } from '../protocol/runtime-input.js';

const PERMUTATION_ENTRY_BYTES = 16;
const [permutationSectionSpec] = PROVER_PERMUTATION_V1_SPEC.sections;
const [selectorSectionSpec] = PROVER_SELECTOR_V1_SPEC.sections;

export interface PreprocessBinaryInput {
  readonly selector: Uint8Array;
  readonly permutation: Uint8Array;
  readonly preprocessCrs: UnivariateCrsChunkInput;
}

export async function loadPreprocessInputFromBinaryInput(input: PreprocessBinaryInput): Promise<PreprocessRuntimeInput> {
  const [selector, permutation] = await Promise.all([
    admitRuntimeBinaryArtifact(input.selector, PROVER_SELECTOR_V1_SPEC.kind, PROVER_SELECTOR_V1_SPEC),
    admitRuntimeBinaryArtifact(input.permutation, PROVER_PERMUTATION_V1_SPEC.kind, PROVER_PERMUTATION_V1_SPEC),
  ]);
  const setup = GENERATED_SETUP_PARAMS;
  for (const artifact of [selector, permutation]) {
    assertBinaryArtifactCompatibility(artifact);
  }

  return {
    setup,
    selector: parseSelector(selector, setup.s_max),
    permutation: parsePermutation(permutation, setup.l_D - setup.l, setup.s_max),
    crs: await parseUnivariatePreprocessCrs(input.preprocessCrs),
  };
}

function parseSelector(file: BinaryArtifactFileView, sMax: number): readonly (number | null)[] {
  const section = requireBinaryArtifactSection(file, selectorSectionSpec);
  if (section.elementCount !== sMax || section.elementByteLength !== 4 || section.data.byteLength !== sMax * 4) {
    throw new Error(`selector.entries must contain exactly ${sMax} u32 entries.`);
  }
  const view = new DataView(section.data.buffer, section.data.byteOffset, section.data.byteLength);
  return Array.from({ length: sMax }, (_, index) => {
    const value = view.getUint32(index * 4, true);
    return value === 0xffffffff ? null : value;
  });
}

function parsePermutation(file: BinaryArtifactFileView, mI: number, sMax: number): readonly UnivariatePermutationEntry[] {
  const section = requireBinaryArtifactSection(file, permutationSectionSpec);
  if (section.data.byteLength % PERMUTATION_ENTRY_BYTES !== 0) {
    throw new Error('permutation.entries byte length must be divisible by 16.');
  }

  const view = new DataView(section.data.buffer, section.data.byteOffset, section.data.byteLength);
  const entries: UnivariatePermutationEntry[] = [];
  for (let offset = 0; offset < section.data.byteLength; offset += PERMUTATION_ENTRY_BYTES) {
    const entry = {
      row: view.getUint32(offset, true),
      col: view.getUint32(offset + 4, true),
      X: view.getUint32(offset + 8, true),
      Y: view.getUint32(offset + 12, true),
    };
    assertIndex(entry.row, mI, 'row');
    assertIndex(entry.X, mI, 'X');
    assertIndex(entry.col, sMax, 'col');
    assertIndex(entry.Y, sMax, 'Y');
    entries.push(entry);
  }
  return entries;
}

function assertIndex(value: number, upperBound: number, name: string): void {
  if (value >= upperBound) {
    throw new Error(`Permutation ${name} index ${value} is outside [0, ${upperBound}).`);
  }
}
