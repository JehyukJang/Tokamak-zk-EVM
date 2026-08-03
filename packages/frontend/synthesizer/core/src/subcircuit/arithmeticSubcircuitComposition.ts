import type {
  ArithmeticOperator,
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

export class ArithmeticSubcircuitComposition {
  public readonly numOperands: number;
  public readonly numResults: number;
  public readonly steps: readonly CompositionStep[];

  constructor(definition: ArithmeticSubcircuitCompositionDefinition) {
    assertIndex(definition.numOperands, 'numOperands');
    assertIndex(definition.numResults, 'numResults');
    if (definition.steps.length === 0) {
      throw new Error('ArithmeticSubcircuitComposition: at least one step is required');
    }

    this.numOperands = definition.numOperands;
    this.numResults = definition.numResults;
    this.steps = Object.freeze(definition.steps.map((step) => Object.freeze({
      subcircuit: step.subcircuit,
      usage: step.usage,
      selector: step.selector,
      inputs: Object.freeze(step.inputs.map(freezeReference)),
      outputs: Object.freeze(step.outputs.map(freezeReference)),
    })));

    this._validateReferences();
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

  private _validateReferences(): void {
    const intermediates = new Set<number>();
    const consumedIntermediates = new Set<number>();
    const results = new Set<number>();

    for (const [stepIndex, step] of this.steps.entries()) {
      const selectorInputs = step.inputs.filter(({ kind }) => kind === 'selector').length;
      if (selectorInputs !== (step.selector === null ? 0 : 1)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: step ${stepIndex} selector input does not match its selector definition`,
        );
      }

      for (const input of step.inputs) {
        if (input.kind === 'operand') {
          assertIndex(input.index, `step ${stepIndex} operand index`);
          if (input.index >= this.numOperands) {
            throw new Error(
              `ArithmeticSubcircuitComposition: step ${stepIndex} operand index is out of range`,
            );
          }
        } else if (input.kind === 'step-output') {
          assertIndex(input.index, `step ${stepIndex} intermediate input index`);
          if (!intermediates.has(input.index)) {
            throw new Error(
              `ArithmeticSubcircuitComposition: step ${stepIndex} references an intermediate before it is produced`,
            );
          }
          consumedIntermediates.add(input.index);
        }
      }

      for (const output of step.outputs) {
        if (output.kind === 'step-output') {
          assertIndex(output.index, `step ${stepIndex} intermediate output index`);
          if (intermediates.has(output.index)) {
            throw new Error(
              `ArithmeticSubcircuitComposition: intermediate ${output.index} has multiple producers`,
            );
          }
          intermediates.add(output.index);
        } else if (output.kind === 'result') {
          assertIndex(output.index, `step ${stepIndex} result index`);
          if (output.index >= this.numResults) {
            throw new Error(
              `ArithmeticSubcircuitComposition: step ${stepIndex} result index is out of range`,
            );
          }
          if (results.has(output.index)) {
            throw new Error(
              `ArithmeticSubcircuitComposition: result ${output.index} has multiple producers`,
            );
          }
          results.add(output.index);
        }
      }
    }

    for (let index = 0; index < intermediates.size; index++) {
      if (!intermediates.has(index)) {
        throw new Error('ArithmeticSubcircuitComposition: intermediate indices must be contiguous');
      }
      if (!consumedIntermediates.has(index)) {
        throw new Error(
          `ArithmeticSubcircuitComposition: intermediate ${index} is never consumed`,
        );
      }
    }

    for (let index = 0; index < this.numResults; index++) {
      if (!results.has(index)) {
        throw new Error(`ArithmeticSubcircuitComposition: result ${index} is not produced`);
      }
    }
  }
}
