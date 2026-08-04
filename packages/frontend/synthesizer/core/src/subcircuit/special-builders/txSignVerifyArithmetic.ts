import { FUNCTION_INPUT_LENGTH } from 'tokamak-l2js';

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

export type TransactionSignatureVerifyArithmeticMappingConfig = Pick<
  FrontendConfig,
  'nJubjubExpBatch' | 'nPoseidonBatch'
>;

const NUM_SCALAR_BITS = 256;
const NUM_TRANSACTION_MESSAGE_WORDS = 3 + FUNCTION_INPUT_LENGTH;
type IntermediateReference = Readonly<{ kind: 'step-output'; index: number }>;

const createPoseidonChainSteps = (
  nPoseidonBatch: number,
  initialInputs: readonly InputReference[],
  paddingInput: InputReference | undefined,
  intermediateOffset: number,
): Readonly<{
  steps: readonly CompositionStep[];
  output: InputReference;
  nextIntermediateIndex: number;
}> => {
  if (initialInputs.length < 2) {
    throw new Error('Poseidon chain requires at least two inputs');
  }

  const inputLimit = nPoseidonBatch + 1;
  const steps: CompositionStep[] = [];
  let chainInputs = [...initialInputs];
  let nextIntermediateIndex = intermediateOffset;

  while (chainInputs.length > 1) {
    const inputs = chainInputs.slice(0, inputLimit);
    const numPaddingInputs = inputLimit - inputs.length;
    if (numPaddingInputs > 0 && paddingInput === undefined) {
      throw new Error('Poseidon chain requires a final-step padding input');
    }
    const outputIndex = nextIntermediateIndex++;
    steps.push({
      subcircuit: 'Poseidon',
      usage: 'Poseidon',
      selector: 1n << BigInt(inputs.length - 2),
      inputs: [
        { kind: 'selector' },
        ...inputs,
        ...Array.from(
          { length: numPaddingInputs },
          (): InputReference => paddingInput!,
        ),
      ],
      outputs: [{ kind: 'step-output', index: outputIndex }],
    });
    chainInputs = [
      { kind: 'step-output', index: outputIndex },
      ...chainInputs.slice(inputLimit),
    ];
  }

  return {
    steps,
    output: chainInputs[0]!,
    nextIntermediateIndex,
  };
};

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

export const createTransactionSignatureVerifyArithmeticMapping = (
  config: TransactionSignatureVerifyArithmeticMappingConfig,
): ArithmeticSubcircuitMapping => {
  assertPositiveInteger(config.nJubjubExpBatch, 'nJubjubExpBatch');
  assertPositiveInteger(config.nPoseidonBatch, 'nPoseidonBatch');

  const randomizerOffset = 0;
  const publicKeyOffset = randomizerOffset + 2;
  const messageOffset = publicKeyOffset + 2;
  const signatureIndex = messageOffset + NUM_TRANSACTION_MESSAGE_WORDS;
  const basePointOffset = signatureIndex + 1;
  const pointAtInfinityOffset = basePointOffset + 2;
  const addressMaskIndex = pointAtInfinityOffset + 2;
  const numOperands = addressMaskIndex + 1;

  const constants: ConstantDefinition[] = [];
  const poseidonPaddingInput: InputReference | undefined = config.nPoseidonBatch > 1
    ? { kind: 'constant', index: constants.push({ value: 0n, sourceBitSize: 255 }) - 1 }
    : undefined;
  const numJubjubBatches = Math.ceil(NUM_SCALAR_BITS / config.nJubjubExpBatch);
  const jubjubPaddingInput: InputReference | undefined =
    numJubjubBatches * config.nJubjubExpBatch > NUM_SCALAR_BITS
      ? { kind: 'constant', index: constants.push({ value: 0n, sourceBitSize: 1 }) - 1 }
      : undefined;

  const steps: CompositionStep[] = [];
  let nextIntermediateIndex = 0;
  const challengePoseidon = createPoseidonChainSteps(
    config.nPoseidonBatch,
    Array.from(
      { length: 4 + NUM_TRANSACTION_MESSAGE_WORDS },
      (_, index): InputReference => ({ kind: 'operand', index }),
    ),
    poseidonPaddingInput,
    nextIntermediateIndex,
  );
  steps.push(...challengePoseidon.steps);
  nextIntermediateIndex = challengePoseidon.nextIntermediateIndex;

  const signatureBitInputs: IntermediateReference[] = Array.from(
    { length: NUM_SCALAR_BITS },
    (_, index): IntermediateReference => ({
      kind: 'step-output',
      index: nextIntermediateIndex + index,
    }),
  );
  steps.push({
    subcircuit: 'DecToBit',
    usage: 'DecToBit',
    selector: null,
    inputs: [{ kind: 'operand', index: signatureIndex }],
    outputs: signatureBitInputs,
  });
  nextIntermediateIndex += NUM_SCALAR_BITS;

  const challengeBitInputs: IntermediateReference[] = Array.from(
    { length: NUM_SCALAR_BITS },
    (_, index): IntermediateReference => ({
      kind: 'step-output',
      index: nextIntermediateIndex + index,
    }),
  );
  steps.push({
    subcircuit: 'DecToBit',
    usage: 'DecToBit',
    selector: null,
    inputs: [challengePoseidon.output],
    outputs: challengeBitInputs,
  });
  nextIntermediateIndex += NUM_SCALAR_BITS;

  const numJubjubIntermediateOutputs = 4 * (numJubjubBatches - 1) + 2;
  const sG: readonly [IntermediateReference, IntermediateReference] = [
    { kind: 'step-output', index: nextIntermediateIndex + numJubjubIntermediateOutputs - 2 },
    { kind: 'step-output', index: nextIntermediateIndex + numJubjubIntermediateOutputs - 1 },
  ];
  steps.push(...createJubjubExpBatchSteps(
    config.nJubjubExpBatch,
    [
      { kind: 'operand', index: pointAtInfinityOffset },
      { kind: 'operand', index: pointAtInfinityOffset + 1 },
      { kind: 'operand', index: basePointOffset },
      { kind: 'operand', index: basePointOffset + 1 },
    ],
    signatureBitInputs,
    jubjubPaddingInput,
    nextIntermediateIndex,
    [
      { kind: 'step-output', index: sG[0].index },
      { kind: 'step-output', index: sG[1].index },
    ],
  ));
  nextIntermediateIndex += numJubjubIntermediateOutputs;

  const eA: readonly [IntermediateReference, IntermediateReference] = [
    { kind: 'step-output', index: nextIntermediateIndex + numJubjubIntermediateOutputs - 2 },
    { kind: 'step-output', index: nextIntermediateIndex + numJubjubIntermediateOutputs - 1 },
  ];
  steps.push(...createJubjubExpBatchSteps(
    config.nJubjubExpBatch,
    [
      { kind: 'operand', index: pointAtInfinityOffset },
      { kind: 'operand', index: pointAtInfinityOffset + 1 },
      { kind: 'operand', index: publicKeyOffset },
      { kind: 'operand', index: publicKeyOffset + 1 },
    ],
    challengeBitInputs,
    jubjubPaddingInput,
    nextIntermediateIndex,
    [
      { kind: 'step-output', index: eA[0].index },
      { kind: 'step-output', index: eA[1].index },
    ],
  ));
  nextIntermediateIndex += numJubjubIntermediateOutputs;

  steps.push({
    subcircuit: 'EdDsaVerify',
    usage: 'EdDsaVerify',
    selector: null,
    inputs: [
      ...sG,
      { kind: 'operand', index: randomizerOffset },
      { kind: 'operand', index: randomizerOffset + 1 },
      ...eA,
    ],
    outputs: [],
  });

  const publicKeyPoseidon = createPoseidonChainSteps(
    config.nPoseidonBatch,
    [
      { kind: 'operand', index: publicKeyOffset },
      { kind: 'operand', index: publicKeyOffset + 1 },
    ],
    poseidonPaddingInput,
    nextIntermediateIndex,
  );
  steps.push(...publicKeyPoseidon.steps);

  steps.push({
    subcircuit: 'AND',
    usage: 'AND',
    selector: 1n << 22n,
    inputs: [
      { kind: 'selector' },
      publicKeyPoseidon.output,
      { kind: 'operand', index: addressMaskIndex },
    ],
    outputs: [{ kind: 'result', index: 0 }],
  });

  return Object.freeze({
    operation: 'TransactionSignatureVerify',
    composition: freezeComposition({
      placementStrategy: 'generic',
      constants,
      numSteps: steps.length,
      numOperands,
      numResults: 1,
      steps,
    }),
  });
};
