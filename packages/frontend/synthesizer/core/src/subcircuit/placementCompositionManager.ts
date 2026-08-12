import {
  OPERATOR_LIST,
  type CompositionSubcircuit,
  type Operator,
} from './configuredTypes.ts';
import { assertPositiveInteger, freezeComposition } from './utils.ts';
import {
  isDataPtType,
  type DataPtType,
  UINT256_DATA_PT_TYPE,
} from '../synthesizer/types/dataStructure.ts';
import { createAddMulModCompositionMappings } from './special-builders/addMulModComposition.ts';
import { createDivisionCompositionMappings } from './special-builders/divModComposition.ts';
import { createExpCompositionMapping } from './special-builders/expComposition.ts';
import { createMemoryLoadCompositionMapping } from './special-builders/memoryLoadComposition.ts';
import { createPoseidonCompositionMapping } from './special-builders/poseidonComposition.ts';
import { createTransactionSignatureVerifyCompositionMapping } from './special-builders/txSignVerifyComposition.ts';

export type SelectorDefinition = bigint | null | 'dynamic';

export type PlacementStrategy = 'generic' | 'poseidon' | 'memory-load';

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
  subcircuit: CompositionSubcircuit;
  usage: Operator | CompositionSubcircuit;
  selector: SelectorDefinition;
  inputs: readonly InputReference[];
  outputs: readonly OutputReference[];
}>;

export type ConstantDefinition = Readonly<{
  value: bigint;
  dataPtType: DataPtType;
}>;

export type PlacementComposition = Readonly<{
  placementStrategy: PlacementStrategy;
  constants: readonly ConstantDefinition[];
  numSteps: number | 'dynamic';
  numOperands: number | 'dynamic';
  numResults: number;
  steps: readonly CompositionStep[];
}>;

export type PlacementCompositionMapping = Readonly<{
  operation: Operator;
  composition: PlacementComposition;
}>;

const assertIndex = (index: number, description: string): void => {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `PlacementCompositionManager: ${description} must be a non-negative integer`,
    );
  }
};

export class PlacementCompositionManager {
  private readonly compositions: ReadonlyMap<
    Operator,
    PlacementComposition
  >;

  constructor(mappings: readonly PlacementCompositionMapping[]) {
    const compositions = new Map<Operator, PlacementComposition>();

    for (const { operation, composition: sourceComposition } of mappings) {
      if (compositions.has(operation)) {
        throw new Error(
          `PlacementCompositionManager: operation ${operation} has multiple mappings`,
        );
      }

      const composition = freezeComposition(sourceComposition);
      this._validateComposition(operation, composition);
      compositions.set(operation, composition);
    }

    for (const operation of OPERATOR_LIST) {
      if (!compositions.has(operation)) {
        throw new Error(
          `PlacementCompositionManager: operation ${operation} has no mapping`,
        );
      }
    }

    this.compositions = compositions;
    Object.freeze(this);
  }

  public get(operation: Operator): PlacementComposition {
    const composition = this.compositions.get(operation);
    if (composition === undefined) {
      throw new Error(
        `PlacementCompositionManager: operation ${operation} has no mapping`,
      );
    }
    return composition;
  }

  private _validateComposition(
    operation: Operator,
    composition: PlacementComposition,
  ): void {
    if (!(OPERATOR_LIST as readonly string[]).includes(operation)) {
      throw new Error(
        `PlacementCompositionManager: operation ${operation} is not configured`,
      );
    }

    this._validatePlacementComposition(operation, composition);
  }

  private _validatePlacementComposition(
    operation: Operator,
    composition: PlacementComposition,
  ): void {
    const hasDynamicSelector = composition.steps.some(
      ({ selector }) => selector === 'dynamic',
    );
    const isGeneric = composition.placementStrategy === 'generic';
    const expectedSpecialOperator = composition.placementStrategy === 'poseidon'
      ? 'Poseidon'
      : composition.placementStrategy === 'memory-load'
        ? 'MemoryLoad'
        : undefined;
    if (isGeneric && (composition.numSteps === 'dynamic' || hasDynamicSelector)) {
      throw new Error(
        `PlacementCompositionManager: ${operation} cannot use generic placement with dynamic numSteps or selectors`,
      );
    }
    if (!isGeneric && expectedSpecialOperator !== operation) {
      throw new Error(
        `PlacementCompositionManager: ${operation} has an invalid ${composition.placementStrategy} placement strategy`,
      );
    }
    if (isGeneric && composition.numOperands === 'dynamic') {
      throw new Error(
        `PlacementCompositionManager: ${operation} generic placement requires a fixed operand count`,
      );
    }
    if (!isGeneric && composition.numOperands !== 'dynamic') {
      throw new Error(
        `PlacementCompositionManager: ${operation} special placement requires a dynamic operand count`,
      );
    }
    if (composition.numSteps !== 'dynamic') {
      assertIndex(composition.numSteps, `${operation} numSteps`);
      if (composition.numSteps !== composition.steps.length) {
        throw new Error(
          `PlacementCompositionManager: ${operation} numSteps must match its step count`,
        );
      }
    }
    assertIndex(composition.numResults, `${operation} numResults`);
    if (composition.steps.length === 0) {
      throw new Error(
        `PlacementCompositionManager: operation ${operation} requires at least one step`,
      );
    }

    const intermediates = new Set<number>();
    const consumedIntermediates = new Set<number>();
    const consumedConstants = new Set<number>();
    const results = new Set<number>();
    let highestOperandIndex = -1;

    for (const [constantIndex, constant] of composition.constants.entries()) {
      if (!isDataPtType(constant.dataPtType)) {
        throw new Error(
          `PlacementCompositionManager: ${operation} constant ${constantIndex} has an invalid canonical DataPt type`,
        );
      }
    }

    for (const [stepIndex, step] of composition.steps.entries()) {
      const expectedUsage = step.subcircuit.startsWith('ALU')
        ? operation
        : step.subcircuit;
      if (step.usage !== expectedUsage) {
        throw new Error(
          `PlacementCompositionManager: ${operation} step ${stepIndex} usage must be ${expectedUsage}`,
        );
      }

      const selectorInputs = step.inputs.filter(({ kind }) => kind === 'selector').length;
      if (selectorInputs !== (step.selector === null ? 0 : 1)) {
        throw new Error(
          `PlacementCompositionManager: ${operation} step ${stepIndex} selector input does not match its selector definition`,
        );
      }

      for (const input of step.inputs) {
        if (input.kind === 'operand') {
          assertIndex(input.index, `${operation} step ${stepIndex} operand index`);
          highestOperandIndex = Math.max(highestOperandIndex, input.index);
        } else if (input.kind === 'step-output') {
          assertIndex(input.index, `${operation} step ${stepIndex} intermediate input index`);
          if (!intermediates.has(input.index)) {
            throw new Error(
              `PlacementCompositionManager: ${operation} step ${stepIndex} references an intermediate before it is produced`,
            );
          }
          consumedIntermediates.add(input.index);
        } else if (input.kind === 'constant') {
          assertIndex(input.index, `${operation} step ${stepIndex} constant index`);
          if (input.index >= composition.constants.length) {
            throw new Error(
              `PlacementCompositionManager: ${operation} step ${stepIndex} constant index is out of range`,
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
              `PlacementCompositionManager: ${operation} intermediate ${output.index} has multiple producers`,
            );
          }
          intermediates.add(output.index);
        } else if (output.kind === 'result') {
          assertIndex(output.index, `${operation} step ${stepIndex} result index`);
          if (output.index >= composition.numResults) {
            throw new Error(
              `PlacementCompositionManager: ${operation} step ${stepIndex} result index is out of range`,
            );
          }
          if (results.has(output.index)) {
            throw new Error(
              `PlacementCompositionManager: ${operation} result ${output.index} has multiple producers`,
            );
          }
          results.add(output.index);
        }
      }
    }

    if (isGeneric && composition.numOperands !== highestOperandIndex + 1) {
      throw new Error(
        `PlacementCompositionManager: ${operation} generic operand count must match its operand references`,
      );
    }

    for (const [constantIndex] of composition.constants.entries()) {
      if (!consumedConstants.has(constantIndex)) {
        throw new Error(
          `PlacementCompositionManager: ${operation} constant ${constantIndex} is never used`,
        );
      }
    }

    for (let index = 0; index < intermediates.size; index++) {
      if (!intermediates.has(index)) {
        throw new Error(
          `PlacementCompositionManager: ${operation} intermediate indices must be contiguous`,
        );
      }
      if (!consumedIntermediates.has(index)) {
        throw new Error(
          `PlacementCompositionManager: ${operation} intermediate ${index} is never consumed`,
        );
      }
    }

    for (let index = 0; index < composition.numResults; index++) {
      if (!results.has(index)) {
        throw new Error(
          `PlacementCompositionManager: ${operation} result ${index} is not produced`,
        );
      }
    }
  }

}

const createSingleStepMapping = (
  operation: Operator,
  subcircuit: CompositionSubcircuit,
  selector: SelectorDefinition,
  numOperands: number,
  numResults: number,
  constants: readonly ConstantDefinition[] = [],
): PlacementCompositionMapping => Object.freeze({
  operation,
  composition: freezeComposition({
    placementStrategy: 'generic',
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
  dataPtType: UINT256_DATA_PT_TYPE,
} satisfies ConstantDefinition);

export const FIXED_SINGLE_STEP_ARITHMETIC_MAPPINGS: readonly PlacementCompositionMapping[] =
  Object.freeze([
    createSingleStepMapping('ADD', 'ALU1', 1n << 1n, 2, 1),
    createSingleStepMapping('MUL', 'ALU1', 1n << 2n, 2, 1),
    createSingleStepMapping('SUB', 'ALU1', 1n << 3n, 2, 1),
    createSingleStepMapping('LT', 'ALU2', 1n << 16n, 2, 1),
    createSingleStepMapping('GT', 'ALU2', 1n << 17n, 2, 1),
    createSingleStepMapping('SLT', 'ALU3', 1n << 18n, 2, 1),
    createSingleStepMapping('SGT', 'ALU3', 1n << 19n, 2, 1),
    createSingleStepMapping('EQ', 'ALU1', 1n << 20n, 2, 1),
    createSingleStepMapping('ISZERO', 'ALU2', 1n << 21n, 1, 1, [ZERO_WORD_CONSTANT]),
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

export type SelectorFreeCompositionMappingConfig = Pick<
  PlacementCompositionManagerConfig,
  'nEqualBatch'
>;

export const createSelectorFreeCompositionMappings = (
  config: SelectorFreeCompositionMappingConfig,
): readonly PlacementCompositionMapping[] => {
  assertPositiveInteger(config.nEqualBatch, 'nEqualBatch');

  return Object.freeze([
    createSingleStepMapping(
      'StorageAccess',
      'EqualBatch',
      null,
      2 * config.nEqualBatch,
      0,
    ),
  ]);
};

export type PlacementCompositionManagerConfig = Readonly<{
  nEqualBatch: number;
  nPoseidonBatch: number;
}>;

export const createPlacementCompositionManager = (
  config: PlacementCompositionManagerConfig,
): PlacementCompositionManager => new PlacementCompositionManager([
  ...FIXED_SINGLE_STEP_ARITHMETIC_MAPPINGS,
  ...createDivisionCompositionMappings(),
  ...createAddMulModCompositionMappings(),
  ...createSelectorFreeCompositionMappings(config),
  createExpCompositionMapping(),
  createMemoryLoadCompositionMapping(),
  createPoseidonCompositionMapping(config),
  createTransactionSignatureVerifyCompositionMapping(),
]);
