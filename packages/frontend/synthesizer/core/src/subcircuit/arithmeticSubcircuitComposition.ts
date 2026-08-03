import {
  ARITHMETIC_OPERATOR_LIST,
  ArithmeticOperator,
  SUBCIRCUIT_LIST,
  SubcircuitNames,
} from './configuredTypes.ts';

export type SelectorDefinition = bigint | null | 'dynamic';

export type InputReference =
  | Readonly<{ kind: 'selector' }>
  | Readonly<{ kind: 'operand'; index: number }>
  | Readonly<{ kind: 'step-output'; index: number }>;

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

export type ArithmeticSubcircuitCompositionDefinition = Readonly<{
  numOperands: number;
  numResults: number;
  steps: readonly CompositionStep[];
}>;

const assertNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ArithmeticSubcircuitComposition: ${name} must be a non-negative integer`);
  }
};

const assertReferenceIndex = (value: number, description: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ArithmeticSubcircuitComposition: ${description} must be a non-negative integer`);
  }
};

const freezeReference = <T extends InputReference | OutputReference>(reference: T): T =>
  Object.freeze({ ...reference }) as T;

export class ArithmeticSubcircuitComposition {
  public readonly numOperands: number;
  public readonly numResults: number;
  public readonly steps: readonly CompositionStep[];

  constructor(definition: ArithmeticSubcircuitCompositionDefinition) {
    assertNonNegativeInteger(definition.numOperands, 'numOperands');
    assertNonNegativeInteger(definition.numResults, 'numResults');
    if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
      throw new Error('ArithmeticSubcircuitComposition: at least one step is required');
    }

    this.numOperands = definition.numOperands;
    this.numResults = definition.numResults;
    this.steps = Object.freeze(definition.steps.map((step, stepIndex) => {
      if (typeof step !== 'object' || step === null) {
        throw new Error(`ArithmeticSubcircuitComposition: step ${stepIndex} must be an object`);
      }
      if (!Array.isArray(step.inputs) || !Array.isArray(step.outputs)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} inputs and outputs must be arrays`,
        );
      }
      return Object.freeze({
        subcircuit: step.subcircuit,
        usage: step.usage,
        selector: step.selector,
        inputs: Object.freeze(step.inputs.map(freezeReference)),
        outputs: Object.freeze(step.outputs.map(freezeReference)),
      });
    }));

    this._validateStructure();
    Object.freeze(this);
  }

  public assertUsage(operation: ArithmeticOperator): void {
    for (const [stepIndex, step] of this.steps.entries()) {
      const expectedUsage = step.subcircuit.startsWith('ALU')
        ? operation
        : step.subcircuit;
      if (step.usage !== expectedUsage) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} usage must be ${expectedUsage}`,
        );
      }
    }
  }

  private _validateStructure(): void {
    const producedIntermediates = new Set<number>();
    const consumedIntermediates = new Set<number>();
    const producedResults = new Set<number>();

    for (const [stepIndex, step] of this.steps.entries()) {
      if (!SUBCIRCUIT_LIST.includes(step.subcircuit)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} references an unknown subcircuit`,
        );
      }
      if (
        !SUBCIRCUIT_LIST.includes(step.usage as SubcircuitNames)
        && !ARITHMETIC_OPERATOR_LIST.includes(step.usage as ArithmeticOperator)
      ) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} has an unknown usage`,
        );
      }
      if (
        step.selector !== null
        && step.selector !== 'dynamic'
        && typeof step.selector !== 'bigint'
      ) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} has an invalid selector`,
        );
      }

      let selectorInputs = 0;
      for (const input of step.inputs) {
        switch (input.kind) {
          case 'selector':
            selectorInputs += 1;
            break;
          case 'operand':
            assertReferenceIndex(input.index, `step ${stepIndex} operand index`);
            if (input.index >= this.numOperands) {
              throw new Error(
                `ArithmeticSubcircuitComposition: step ${stepIndex} operand index is out of range`,
              );
            }
            break;
          case 'step-output':
            assertReferenceIndex(input.index, `step ${stepIndex} intermediate input index`);
            if (!producedIntermediates.has(input.index)) {
              throw new Error(
                `ArithmeticSubcircuitComposition: step ${stepIndex} references an intermediate before it is produced`,
              );
            }
            consumedIntermediates.add(input.index);
            break;
          default:
            throw new Error(
              `ArithmeticSubcircuitComposition: step ${stepIndex} has an invalid input reference`,
            );
        }
      }

      const expectedSelectorInputs = step.selector === null ? 0 : 1;
      if (selectorInputs !== expectedSelectorInputs) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} selector input does not match its selector definition`,
        );
      }

      for (const output of step.outputs) {
        switch (output.kind) {
          case 'step-output':
            assertReferenceIndex(output.index, `step ${stepIndex} intermediate output index`);
            if (producedIntermediates.has(output.index)) {
              throw new Error(
                `ArithmeticSubcircuitComposition: intermediate ${output.index} has multiple producers`,
              );
            }
            producedIntermediates.add(output.index);
            break;
          case 'result':
            assertReferenceIndex(output.index, `step ${stepIndex} result index`);
            if (output.index >= this.numResults) {
              throw new Error(
                `ArithmeticSubcircuitComposition: step ${stepIndex} result index is out of range`,
              );
            }
            if (producedResults.has(output.index)) {
              throw new Error(
                `ArithmeticSubcircuitComposition: result ${output.index} has multiple producers`,
              );
            }
            producedResults.add(output.index);
            break;
          case 'discard':
            break;
          default:
            throw new Error(
              `ArithmeticSubcircuitComposition: step ${stepIndex} has an invalid output reference`,
            );
        }
      }
    }

    for (let index = 0; index < producedIntermediates.size; index++) {
      if (!producedIntermediates.has(index)) {
        throw new Error('ArithmeticSubcircuitComposition: intermediate indices must be contiguous');
      }
      if (!consumedIntermediates.has(index)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: intermediate ${index} is never consumed`,
        );
      }
    }

    for (let index = 0; index < this.numResults; index++) {
      if (!producedResults.has(index)) {
        throw new Error(`ArithmeticSubcircuitComposition: result ${index} is not produced`);
      }
    }
  }
}
