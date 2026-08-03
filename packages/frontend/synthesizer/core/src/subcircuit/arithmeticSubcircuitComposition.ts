import {
  ARITHMETIC_OPERATOR_LIST,
  type ArithmeticOperator,
  type SubcircuitNames,
} from './configuredTypes.ts';
import type { FrontendConfig } from './libraryTypes.ts';

export type SelectorDefinition = bigint | null | 'dynamic';

export type InputReference =
  | Readonly<{ kind: 'selector' }>
  | Readonly<{ kind: 'operand'; index: number }>
  | Readonly<{ kind: 'step-output'; index: number }>
  | Readonly<{ kind: 'constant'; index: number }>;

export type OutputReference =
  | Readonly<{ kind: 'step-output'; index: number }>
  | Readonly<{ kind: 'result'; index: number }>
  | Readonly<{ kind: 'discard' }>;

export type CompositionStep = Readonly<{
  subcircuit: SubcircuitNames;
  usage: ArithmeticOperator | SubcircuitNames;
  selector: SelectorDefinition;
  inputs: readonly InputReference[];
  outputs: readonly OutputReference[];
}>;

export type ConstantDefinition = Readonly<{
  value: bigint;
  sourceBitSize: number;
}>;

export type ArithmeticOperationComposition = Readonly<{
  constants: readonly ConstantDefinition[];
  numSteps: number | 'dynamic';
  numOperands: number;
  numResults: number;
  steps: readonly CompositionStep[];
}>;

export type ArithmeticSubcircuitMapping = Readonly<{
  operation: ArithmeticOperator;
  composition: ArithmeticOperationComposition;
}>;

const assertIndex = (index: number, description: string): void => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `ArithmeticSubcircuitComposition: ${description} must be a non-negative integer`,
    );
  }
};

const freezeReference = <Reference extends InputReference | OutputReference>(
  reference: Reference,
): Reference => Object.freeze({ ...reference }) as Reference;

const freezeComposition = (
  composition: ArithmeticOperationComposition,
): ArithmeticOperationComposition => Object.freeze({
  constants: Object.freeze(composition.constants.map((constant) => Object.freeze({
    value: constant.value,
    sourceBitSize: constant.sourceBitSize,
  }))),
  numSteps: composition.numSteps,
  numOperands: composition.numOperands,
  numResults: composition.numResults,
  steps: Object.freeze(composition.steps.map((step) => Object.freeze({
    subcircuit: step.subcircuit,
    usage: step.usage,
    selector: step.selector,
    inputs: Object.freeze(step.inputs.map(freezeReference)),
    outputs: Object.freeze(step.outputs.map(freezeReference)),
  }))),
});

export class ArithmeticSubcircuitComposition {
  private readonly compositions: ReadonlyMap<
    ArithmeticOperator,
    ArithmeticOperationComposition
  >;

  constructor(mappings: readonly ArithmeticSubcircuitMapping[]) {
    const compositions = new Map<
      ArithmeticOperator,
      ArithmeticOperationComposition
    >();

    for (const { operation, composition: sourceComposition } of mappings) {
      if (compositions.has(operation)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: operation ${operation} has multiple mappings`,
        );
      }

      const composition = freezeComposition(sourceComposition);
      this._validateComposition(operation, composition);
      compositions.set(operation, composition);
    }

    for (const operation of ARITHMETIC_OPERATOR_LIST) {
      if (!compositions.has(operation)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: operation ${operation} has no mapping`,
        );
      }
    }

    this.compositions = compositions;
    Object.freeze(this);
  }

  public get(operation: ArithmeticOperator): ArithmeticOperationComposition {
    const composition = this.compositions.get(operation);
    if (composition === undefined) {
      throw new Error(
        `ArithmeticSubcircuitComposition: operation ${operation} has no mapping`,
      );
    }
    return composition;
  }

  private _validateComposition(
    operation: ArithmeticOperator,
    composition: ArithmeticOperationComposition,
  ): void {
    if (composition.numSteps !== 'dynamic') {
      assertIndex(composition.numSteps, `${operation} numSteps`);
      if (composition.numSteps !== composition.steps.length) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} numSteps must match its step count`,
        );
      }
    }
    assertIndex(composition.numOperands, `${operation} numOperands`);
    assertIndex(composition.numResults, `${operation} numResults`);
    if (composition.steps.length === 0) {
      throw new Error(
        `ArithmeticSubcircuitComposition: operation ${operation} requires at least one step`,
      );
    }

    const intermediates = new Set<number>();
    const consumedIntermediates = new Set<number>();
    const consumedConstants = new Set<number>();
    const results = new Set<number>();

    for (const [constantIndex, constant] of composition.constants.entries()) {
      if (!Number.isInteger(constant.sourceBitSize) || constant.sourceBitSize < 1) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} constant ${constantIndex} sourceBitSize must be a positive integer`,
        );
      }
    }

    for (const [stepIndex, step] of composition.steps.entries()) {
      const expectedUsage = step.subcircuit.startsWith('ALU')
        ? operation
        : step.subcircuit;
      if (step.usage !== expectedUsage) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} step ${stepIndex} usage must be ${expectedUsage}`,
        );
      }

      const selectorInputs = step.inputs.filter(({ kind }) => kind === 'selector').length;
      if (selectorInputs !== (step.selector === null ? 0 : 1)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} step ${stepIndex} selector input does not match its selector definition`,
        );
      }

      for (const input of step.inputs) {
        if (input.kind === 'operand') {
          assertIndex(input.index, `${operation} step ${stepIndex} operand index`);
          if (input.index >= composition.numOperands) {
            throw new Error(
              `ArithmeticSubcircuitComposition: ${operation} step ${stepIndex} operand index is out of range`,
            );
          }
        } else if (input.kind === 'step-output') {
          assertIndex(input.index, `${operation} step ${stepIndex} intermediate input index`);
          if (!intermediates.has(input.index)) {
            throw new Error(
              `ArithmeticSubcircuitComposition: ${operation} step ${stepIndex} references an intermediate before it is produced`,
            );
          }
          consumedIntermediates.add(input.index);
        } else if (input.kind === 'constant') {
          assertIndex(input.index, `${operation} step ${stepIndex} constant index`);
          if (input.index >= composition.constants.length) {
            throw new Error(
              `ArithmeticSubcircuitComposition: ${operation} step ${stepIndex} constant index is out of range`,
            );
          }
          consumedConstants.add(input.index);
        }
      }

      for (const output of step.outputs) {
        if (output.kind === 'step-output') {
          assertIndex(output.index, `${operation} step ${stepIndex} intermediate output index`);
          if (intermediates.has(output.index)) {
            throw new Error(
              `ArithmeticSubcircuitComposition: ${operation} intermediate ${output.index} has multiple producers`,
            );
          }
          intermediates.add(output.index);
        } else if (output.kind === 'result') {
          assertIndex(output.index, `${operation} step ${stepIndex} result index`);
          if (output.index >= composition.numResults) {
            throw new Error(
              `ArithmeticSubcircuitComposition: ${operation} step ${stepIndex} result index is out of range`,
            );
          }
          if (results.has(output.index)) {
            throw new Error(
              `ArithmeticSubcircuitComposition: ${operation} result ${output.index} has multiple producers`,
            );
          }
          results.add(output.index);
        }
      }
    }

    for (const [constantIndex] of composition.constants.entries()) {
      if (!consumedConstants.has(constantIndex)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} constant ${constantIndex} is never used`,
        );
      }
    }

    for (let index = 0; index < intermediates.size; index++) {
      if (!intermediates.has(index)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} intermediate indices must be contiguous`,
        );
      }
      if (!consumedIntermediates.has(index)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} intermediate ${index} is never consumed`,
        );
      }
    }

    for (let index = 0; index < composition.numResults; index++) {
      if (!results.has(index)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: ${operation} result ${index} is not produced`,
        );
      }
    }
  }
}

const createSingleStepMapping = (
  operation: ArithmeticOperator,
  subcircuit: SubcircuitNames,
  selector: SelectorDefinition,
  numOperands: number,
  numResults: number,
  constants: readonly ConstantDefinition[] = [],
): ArithmeticSubcircuitMapping => Object.freeze({
  operation,
  composition: freezeComposition({
    constants,
    numSteps: 1,
    numOperands,
    numResults,
    steps: [{
      subcircuit,
      usage: subcircuit.startsWith('ALU') ? operation : subcircuit,
      selector,
      inputs: [
        ...(selector === null
          ? []
          : [{ kind: 'selector' } as const]),
        ...Array.from(
          { length: numOperands },
          (_, index): InputReference => ({ kind: 'operand', index }),
        ),
        ...constants.map(
          (_, index): InputReference => ({ kind: 'constant', index }),
        ),
      ],
      outputs: Array.from(
        { length: numResults },
        (_, index): OutputReference => ({ kind: 'result', index }),
      ),
    }],
  }),
});

const ZERO_WORD_CONSTANT: ConstantDefinition = Object.freeze({
  value: 0n,
  sourceBitSize: 256,
});

export const FIXED_SINGLE_STEP_ARITHMETIC_MAPPINGS: readonly ArithmeticSubcircuitMapping[] =
  Object.freeze([
    createSingleStepMapping('ADD', 'ALU1', 1n << 1n, 2, 1),
    createSingleStepMapping('MUL', 'ALU1', 1n << 2n, 2, 1),
    createSingleStepMapping('SUB', 'ALU1', 1n << 3n, 2, 1),
    createSingleStepMapping('LT', 'ALU2', 1n << 16n, 2, 1),
    createSingleStepMapping('GT', 'ALU2', 1n << 17n, 2, 1),
    createSingleStepMapping('SLT', 'ALU3', 1n << 18n, 2, 1),
    createSingleStepMapping('SGT', 'ALU3', 1n << 19n, 2, 1),
    createSingleStepMapping('EQ', 'ALU1', 1n << 20n, 2, 1),
    createSingleStepMapping('ISZERO', 'ALU1', 1n << 21n, 1, 1, [ZERO_WORD_CONSTANT]),
    createSingleStepMapping('AND', 'AND', 1n << 22n, 2, 1),
    createSingleStepMapping('OR', 'OR', 1n << 23n, 2, 1),
    createSingleStepMapping('XOR', 'XOR', 1n << 24n, 2, 1),
    createSingleStepMapping('NOT', 'ALU1', 1n << 25n, 1, 1, [ZERO_WORD_CONSTANT]),
    createSingleStepMapping('BYTE', 'BYTE', 1n << 26n, 2, 1),
    createSingleStepMapping('SHL', 'SHL', 1n << 27n, 2, 1),
    createSingleStepMapping('SHR', 'ALU6', 1n << 28n, 2, 1),
    createSingleStepMapping('SAR', 'ALU6', 1n << 29n, 2, 1),
    createSingleStepMapping('SIGNEXTEND', 'SIGNEXTEND', 1n << 11n, 2, 1),
  ]);

export type SelectorFreeArithmeticMappingConfig = Pick<
  FrontendConfig,
  'nAccumulation' | 'nEqualBatch' | 'nJubjubExpBatch' | 'nSubExpBatch'
>;

const assertPositiveInteger = (value: number, description: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `ArithmeticSubcircuitComposition: ${description} must be a positive integer`,
    );
  }
};

export const createSelectorFreeArithmeticMappings = (
  config: SelectorFreeArithmeticMappingConfig,
): readonly ArithmeticSubcircuitMapping[] => {
  assertPositiveInteger(config.nAccumulation, 'nAccumulation');
  assertPositiveInteger(config.nEqualBatch, 'nEqualBatch');
  assertPositiveInteger(config.nJubjubExpBatch, 'nJubjubExpBatch');
  assertPositiveInteger(config.nSubExpBatch, 'nSubExpBatch');

  return Object.freeze([
    createSingleStepMapping('DecToBit', 'DecToBit', null, 1, 256),
    createSingleStepMapping(
      'SubExpBatch',
      'SubExpBatch',
      null,
      2 + config.nSubExpBatch,
      2,
    ),
    createSingleStepMapping(
      'Accumulator',
      'Accumulator',
      null,
      config.nAccumulation,
      1,
    ),
    createSingleStepMapping(
      'JubjubExpBatch',
      'JubjubExpBatch',
      null,
      4 + config.nJubjubExpBatch,
      4,
    ),
    createSingleStepMapping('EdDsaVerify', 'EdDsaVerify', null, 6, 0),
    createSingleStepMapping(
      'EqualBatch',
      'EqualBatch',
      null,
      2 * config.nEqualBatch,
      0,
    ),
  ]);
};

const createModularArithmeticMapping = (
  operation: 'ADDMOD' | 'MULMOD',
  selector: bigint,
): ArithmeticSubcircuitMapping => Object.freeze({
  operation,
  composition: freezeComposition({
    constants: [],
    numSteps: 2,
    numOperands: 3,
    numResults: 1,
    steps: [
      {
        subcircuit: 'CheckBus256',
        usage: 'CheckBus256',
        selector: null,
        inputs: [{ kind: 'operand', index: 0 }],
        outputs: [],
      },
      {
        subcircuit: operation,
        usage: operation,
        selector,
        inputs: [
          { kind: 'selector' },
          { kind: 'operand', index: 0 },
          { kind: 'operand', index: 1 },
          { kind: 'operand', index: 2 },
        ],
        outputs: [{ kind: 'result', index: 0 }],
      },
    ],
  }),
});

export const MODULAR_ARITHMETIC_MAPPINGS: readonly ArithmeticSubcircuitMapping[] =
  Object.freeze([
    createModularArithmeticMapping('ADDMOD', 1n << 8n),
    createModularArithmeticMapping('MULMOD', 1n << 9n),
  ]);

export type PoseidonArithmeticMappingConfig = Pick<
  FrontendConfig,
  'nPoseidonBatch'
>;

export const createPoseidonArithmeticMapping = (
  config: PoseidonArithmeticMappingConfig,
): ArithmeticSubcircuitMapping => {
  assertPositiveInteger(config.nPoseidonBatch, 'nPoseidonBatch');

  return Object.freeze({
    operation: 'Poseidon',
    composition: freezeComposition({
      constants: [],
      numSteps: 'dynamic',
      numOperands: config.nPoseidonBatch + 1,
      numResults: 1,
      steps: [{
        subcircuit: 'Poseidon',
        usage: 'Poseidon',
        selector: 'dynamic',
        inputs: [
          { kind: 'selector' },
          ...Array.from(
            { length: config.nPoseidonBatch + 1 },
            (_, index): InputReference => ({ kind: 'operand', index }),
          ),
        ],
        outputs: [{ kind: 'result', index: 0 }],
      }],
    }),
  });
};

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
      constants,
      numSteps: steps.length,
      numOperands: 2,
      numResults: 1,
      steps,
    }),
  });
};
