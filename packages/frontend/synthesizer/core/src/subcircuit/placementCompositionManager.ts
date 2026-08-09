import {
  ARITHMETIC_OPERATORS,
  OPERATOR_LIST,
  SYS_FLOW_OPERATORS,
  type ArithmeticSubcircuit,
  type ArithmeticOperator,
  type Operator,
  type SysFlowOperator,
} from './configuredTypes.ts';
import { assertPositiveInteger, freezeComposition } from './utils.ts';
import type {
  DataAliasInfos,
  DataPt,
  DataPtType,
  MemoryPts,
} from '../synthesizer/types/dataStructure.ts';
import { createAddMulModArithmeticMappings } from './special-builders/addMulModArithmetic.ts';
import { createDivisionArithmeticMappings } from './special-builders/divModArithmetic.ts';
import { createExpArithmeticMapping } from './special-builders/expArithmetic.ts';
import { createPoseidonArithmeticMapping } from './special-builders/poseidonArithmetic.ts';
import {
  createTransactionSignatureVerifyArithmeticMapping,
} from './special-builders/txSignVerifyArithmetic.ts';

export type SelectorDefinition = bigint | null | 'dynamic';

export type PlacementStrategy = 'generic' | 'poseidon';

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
  subcircuit: ArithmeticSubcircuit;
  usage: ArithmeticOperator | ArithmeticSubcircuit;
  selector: SelectorDefinition;
  inputs: readonly InputReference[];
  outputs: readonly OutputReference[];
}>;

export type ConstantDefinition = Readonly<{
  value: bigint;
  dataPtType: DataPtType;
}>;

export type ArithmeticPlacementComposition = Readonly<{
  category: 'arithmetic';
  placementStrategy: PlacementStrategy;
  constants: readonly ConstantDefinition[];
  numSteps: number | 'dynamic';
  numOperands: number;
  numResults: number;
  steps: readonly CompositionStep[];
}>;

export type MemoryToStackLoadPlacementRequest = Readonly<{
  operator: 'MEMORY_TO_STACK_LOAD';
  dataAliasInfos: DataAliasInfos;
  viewByteLength: number;
}>;

export type MemoryToStackLoadPlacementResult = DataPt;

export type MemoryToMemoryLoadPlacementRequest = Readonly<{
  operator: 'MEMORY_TO_MEMORY_LOAD';
  sourceMemoryPts: MemoryPts;
  sourceOffset: bigint;
  destinationOffset: bigint;
  length: bigint;
}>;

export type MemoryToMemoryLoadPlacementResult = MemoryPts;

export type SysFlowPlacementRequest =
  | MemoryToStackLoadPlacementRequest
  | MemoryToMemoryLoadPlacementRequest;

export type SysFlowPlacementResult =
  | MemoryToStackLoadPlacementResult
  | MemoryToMemoryLoadPlacementResult;

export type SysFlowPlacementComposition =
  | Readonly<{
    category: 'sys-flow';
    operator: 'MEMORY_TO_STACK_LOAD';
    topology: 'serial-memory-load-step';
  }>
  | Readonly<{
    category: 'sys-flow';
    operator: 'MEMORY_TO_MEMORY_LOAD';
    topology: 'chunk-first-memory-load-step';
  }>;

export type PlacementComposition =
  | ArithmeticPlacementComposition
  | SysFlowPlacementComposition;

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

const isArithmeticOperator = (operator: string): operator is ArithmeticOperator =>
  (ARITHMETIC_OPERATORS as readonly string[]).includes(operator);

const isSysFlowOperator = (operator: string): operator is SysFlowOperator =>
  (SYS_FLOW_OPERATORS as readonly string[]).includes(operator);

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

  public get(operation: ArithmeticOperator): ArithmeticPlacementComposition;
  public get(operation: SysFlowOperator): SysFlowPlacementComposition;
  public get(operation: Operator): PlacementComposition;
  public get(operation: Operator): PlacementComposition {
    const composition = this.compositions.get(operation);
    if (composition === undefined) {
      throw new Error(
        `PlacementCompositionManager: operation ${operation} has no mapping`,
      );
    }
    if (isArithmeticOperator(operation) && composition.category === 'arithmetic') {
      return composition;
    }
    if (isSysFlowOperator(operation) && composition.category === 'sys-flow') {
      return composition;
    }
    throw new Error(
      `PlacementCompositionManager: operation ${operation} has an invalid composition category`,
    );
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

    if (isArithmeticOperator(operation)) {
      if (composition.category !== 'arithmetic') {
        throw new Error(
          `PlacementCompositionManager: arithmetic operation ${operation} requires an arithmetic composition`,
        );
      }
      this._validateArithmeticComposition(operation, composition);
      return;
    }

    if (!isSysFlowOperator(operation) || composition.category !== 'sys-flow') {
      throw new Error(
        `PlacementCompositionManager: sys-flow operation ${operation} requires a sys-flow composition`,
      );
    }
    this._validateSysFlowComposition(operation, composition);
  }

  private _validateArithmeticComposition(
    operation: ArithmeticOperator,
    composition: ArithmeticPlacementComposition,
  ): void {
    if (
      composition.placementStrategy !== 'generic'
      && composition.placementStrategy !== 'poseidon'
    ) {
      throw new Error(
        `PlacementCompositionManager: ${operation} has an invalid placement strategy`,
      );
    }
    const hasDynamicSelector = composition.steps.some(
      ({ selector }) => selector === 'dynamic',
    );
    if (
      composition.placementStrategy === 'generic'
      && (composition.numSteps === 'dynamic' || hasDynamicSelector)
    ) {
      throw new Error(
        `PlacementCompositionManager: ${operation} cannot use generic placement with dynamic numSteps or selectors`,
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
    assertIndex(composition.numOperands, `${operation} numOperands`);
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

    for (const [constantIndex, constant] of composition.constants.entries()) {
      const { valueDomain, wireLayout } = constant.dataPtType
      if (
        valueDomain.kind === 'uint'
        && (
          !Number.isInteger(valueDomain.bits)
          || valueDomain.bits < 1
          || valueDomain.bits > 256
        )
      ) {
        throw new Error(
          `PlacementCompositionManager: ${operation} constant ${constantIndex} uint domain must have between 1 and 256 bits`,
        );
      }
      if (
        wireLayout.kind === 'limbs-128'
        && wireLayout.count === 1
        && (
          valueDomain.kind !== 'uint'
          || valueDomain.bits > 128
        )
      ) {
        throw new Error(
          `PlacementCompositionManager: ${operation} constant ${constantIndex} one-limb layout requires a uint domain of at most 128 bits`,
        );
      }
      if (
        wireLayout.kind === 'native-fr'
        && valueDomain.kind === 'uint'
      ) {
        throw new Error(
          `PlacementCompositionManager: ${operation} constant ${constantIndex} native-fr layout requires a field or scalar domain`,
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
          if (input.index >= composition.numOperands) {
            throw new Error(
              `PlacementCompositionManager: ${operation} step ${stepIndex} operand index is out of range`,
            );
          }
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

  private _validateSysFlowComposition(
    operation: SysFlowOperator,
    composition: SysFlowPlacementComposition,
  ): void {
    if (composition.operator !== operation) {
      throw new Error(
        `PlacementCompositionManager: sys-flow operation ${operation} does not match composition operator ${composition.operator}`,
      );
    }
    if (
      composition.operator === 'MEMORY_TO_STACK_LOAD'
      && composition.topology !== 'serial-memory-load-step'
    ) {
      throw new Error(
        'PlacementCompositionManager: MEMORY_TO_STACK_LOAD requires serial-memory-load-step topology',
      );
    }
    if (
      composition.operator === 'MEMORY_TO_MEMORY_LOAD'
      && composition.topology !== 'chunk-first-memory-load-step'
    ) {
      throw new Error(
        'PlacementCompositionManager: MEMORY_TO_MEMORY_LOAD requires chunk-first-memory-load-step topology',
      );
    }
  }
}

const createSingleStepMapping = (
  operation: ArithmeticOperator,
  subcircuit: ArithmeticSubcircuit,
  selector: SelectorDefinition,
  numOperands: number,
  numResults: number,
  constants: readonly ConstantDefinition[] = [],
): PlacementCompositionMapping => Object.freeze({
  operation,
  composition: freezeComposition({
    category: 'arithmetic',
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
  dataPtType: {
    valueDomain: { kind: 'uint', bits: 256 },
    wireLayout: { kind: 'limbs-128', count: 2 },
  },
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

export const FIXED_SYS_FLOW_COMPOSITION_MAPPINGS: readonly PlacementCompositionMapping[] =
  Object.freeze([
    Object.freeze({
      operation: 'MEMORY_TO_STACK_LOAD',
      composition: freezeComposition({
        category: 'sys-flow',
        operator: 'MEMORY_TO_STACK_LOAD',
        topology: 'serial-memory-load-step',
      }),
    }),
    Object.freeze({
      operation: 'MEMORY_TO_MEMORY_LOAD',
      composition: freezeComposition({
        category: 'sys-flow',
        operator: 'MEMORY_TO_MEMORY_LOAD',
        topology: 'chunk-first-memory-load-step',
      }),
    }),
  ]);

export type SelectorFreeArithmeticMappingConfig = Pick<
  PlacementCompositionManagerConfig,
  'nEqualBatch'
>;

export const createSelectorFreeArithmeticMappings = (
  config: SelectorFreeArithmeticMappingConfig,
): readonly PlacementCompositionMapping[] => {
  assertPositiveInteger(config.nEqualBatch, 'nEqualBatch');

  return Object.freeze([
    createSingleStepMapping(
      'EqualBatch',
      'EqualBatch',
      null,
      2 * config.nEqualBatch,
      0,
    ),
  ]);
};

export type PlacementCompositionManagerConfig = Readonly<{
  nEqualBatch: number;
  nJubjubExpBatch: number;
  nPoseidonBatch: number;
}>;

export const createPlacementCompositionManager = (
  config: PlacementCompositionManagerConfig,
): PlacementCompositionManager => new PlacementCompositionManager([
  ...FIXED_SINGLE_STEP_ARITHMETIC_MAPPINGS,
  ...FIXED_SYS_FLOW_COMPOSITION_MAPPINGS,
  ...createDivisionArithmeticMappings(),
  ...createAddMulModArithmeticMappings(),
  ...createSelectorFreeArithmeticMappings(config),
  createExpArithmeticMapping(),
  createTransactionSignatureVerifyArithmeticMapping(config),
  createPoseidonArithmeticMapping(config),
]);
