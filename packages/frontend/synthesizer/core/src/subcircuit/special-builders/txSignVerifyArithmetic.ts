import type { FrontendConfig } from '../libraryTypes.ts';
import {
  assertPositiveInteger,
  freezeComposition,
  type ArithmeticSubcircuitMapping,
  type CompositionStep,
  type ConstantDefinition,
  type InputReference,
  type OutputReference,
} from '../arithmeticSubcircuitComposition.ts';

export type JubjubExpArithmeticMappingConfig = Pick<
  FrontendConfig,
  'nJubjubExpBatch'
>;

const createJubjubExpBatchSteps = (
  nJubjubExpBatch: number,
  initialStateInputs: readonly InputReference[],
  scalarBitInputs: readonly InputReference[],
  paddingInput: InputReference | undefined,
  intermediateOffset: number,
  finalPointOutputs: readonly [OutputReference, OutputReference],
): CompositionStep[] => {
  const numBatches = Math.ceil(scalarBitInputs.length / nJubjubExpBatch);
  const steps: CompositionStep[] = [];

  for (let batchIndex = 0; batchIndex < numBatches; batchIndex++) {
    const isFirstBatch = batchIndex === 0;
    const isFinalBatch = batchIndex === numBatches - 1;
    const stateInputs: readonly InputReference[] = isFirstBatch
      ? initialStateInputs
      : Array.from(
          { length: 4 },
          (_, index): InputReference => ({
            kind: 'step-output',
            index: intermediateOffset + 4 * (batchIndex - 1) + index,
          }),
        );
    const bitInputs = Array.from(
      { length: nJubjubExpBatch },
      (_, bitIndex): InputReference => {
        const scalarBitIndex = batchIndex * nJubjubExpBatch + bitIndex;
        const scalarBitInput = scalarBitInputs[scalarBitIndex] ?? paddingInput;
        if (scalarBitInput === undefined) {
          throw new Error('Jubjub exponentiation requires a final-batch padding input');
        }
        return scalarBitInput;
      },
    );
    const outputs: readonly OutputReference[] = isFinalBatch
      ? [
          ...finalPointOutputs,
          { kind: 'discard' },
          { kind: 'discard' },
        ]
      : Array.from(
          { length: 4 },
          (_, index): OutputReference => ({
            kind: 'step-output',
            index: intermediateOffset + 4 * batchIndex + index,
          }),
        );

    steps.push({
      subcircuit: 'JubjubExpBatch',
      usage: 'JubjubExpBatch',
      selector: null,
      inputs: [...stateInputs, ...bitInputs],
      outputs,
    });
  }

  return steps;
};

export const createJubjubExpArithmeticMapping = (
  config: JubjubExpArithmeticMappingConfig,
): ArithmeticSubcircuitMapping => {
  assertPositiveInteger(config.nJubjubExpBatch, 'nJubjubExpBatch');

  const numScalarBits = 256;
  const numBatches = Math.ceil(numScalarBits / config.nJubjubExpBatch);
  const numPaddedScalarBits = numBatches * config.nJubjubExpBatch;
  const constants: ConstantDefinition[] = numPaddedScalarBits > numScalarBits
    ? [{ value: 0n, sourceBitSize: 1 }]
    : [];
  const steps = createJubjubExpBatchSteps(
    config.nJubjubExpBatch,
    Array.from(
      { length: 4 },
      (_, index): InputReference => ({ kind: 'operand', index }),
    ),
    Array.from(
      { length: numScalarBits },
      (_, index): InputReference => ({ kind: 'operand', index: 4 + index }),
    ),
    constants.length === 0 ? undefined : { kind: 'constant', index: 0 },
    0,
    [
      { kind: 'result', index: 0 },
      { kind: 'result', index: 1 },
    ],
  );

  return Object.freeze({
    operation: 'JubjubExp',
    composition: freezeComposition({
      placementStrategy: 'generic',
      constants,
      numSteps: steps.length,
      numOperands: 4 + numScalarBits,
      numResults: 2,
      steps,
    }),
  });
};
