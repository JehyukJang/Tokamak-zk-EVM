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

export type ExpArithmeticMappingConfig = Pick<
  FrontendConfig,
  'nSubExpBatch'
>;

export const createExpArithmeticMapping = (
  config: ExpArithmeticMappingConfig,
): ArithmeticSubcircuitMapping => {
  assertPositiveInteger(config.nSubExpBatch, 'nSubExpBatch');

  const numExponentBits = 256;
  const numBatches = Math.ceil(numExponentBits / config.nSubExpBatch);
  const requiresPadding = numBatches * config.nSubExpBatch > numExponentBits;
  const constants: ConstantDefinition[] = [
    { value: 1n, sourceBitSize: 256 },
    ...(requiresPadding
      ? [{ value: 0n, sourceBitSize: 1 }]
      : []),
  ];
  const steps: CompositionStep[] = [{
    subcircuit: 'DecToBit',
    usage: 'DecToBit',
    selector: null,
    inputs: [{ kind: 'operand', index: 1 }],
    outputs: Array.from(
      { length: numExponentBits },
      (_, index): OutputReference => ({ kind: 'step-output', index }),
    ),
  }];

  for (let batchIndex = 0; batchIndex < numBatches; batchIndex++) {
    const isFirstBatch = batchIndex === 0;
    const isFinalBatch = batchIndex === numBatches - 1;
    const stateInputs: InputReference[] = isFirstBatch
      ? [
          { kind: 'constant', index: 0 },
          { kind: 'operand', index: 0 },
        ]
      : [
          { kind: 'step-output', index: numExponentBits + 2 * (batchIndex - 1) },
          { kind: 'step-output', index: numExponentBits + 2 * (batchIndex - 1) + 1 },
        ];
    const bitInputs = Array.from(
      { length: config.nSubExpBatch },
      (_, bitIndex): InputReference => {
        const exponentBitIndex = batchIndex * config.nSubExpBatch + bitIndex;
        return exponentBitIndex < numExponentBits
          ? { kind: 'step-output', index: exponentBitIndex }
          : { kind: 'constant', index: 1 };
      },
    );
    const outputs: OutputReference[] = isFinalBatch
      ? [
          { kind: 'result', index: 0 },
          { kind: 'discard' },
        ]
      : [
          { kind: 'step-output', index: numExponentBits + 2 * batchIndex },
          { kind: 'step-output', index: numExponentBits + 2 * batchIndex + 1 },
        ];

    steps.push({
      subcircuit: 'SubExpBatch',
      usage: 'SubExpBatch',
      selector: null,
      inputs: [...stateInputs, ...bitInputs],
      outputs,
    });
  }

  return Object.freeze({
    operation: 'EXP',
    composition: freezeComposition({
      placementStrategy: 'generic',
      constants,
      numSteps: steps.length,
      numOperands: 2,
      numResults: 1,
      steps,
    }),
  });
};
