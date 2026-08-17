import { SynthesizerInterface } from '../synthesizer/types/index.ts';
import {
  VariableGenerator,
} from './handlers/variableGenerator.ts';
import { PermutationGenerator } from './handlers/permutationGenerator.ts';
import {
  CircuitGenerationResult,
} from './types/types.ts';

export async function createCircuitGenerator(synthesizer: SynthesizerInterface): Promise<CircuitGenerator> {
  const variableGeneration = await new VariableGenerator(
    synthesizer,
    synthesizer.subcircuitLibrary,
  ).generate();
  const permutation = new PermutationGenerator(
    variableGeneration.circuitPlacements,
    variableGeneration.placementVariables,
    synthesizer.subcircuitLibrary,
  ).permutation;
  return new CircuitGenerator({
    placements: variableGeneration.circuitPlacements,
    placementVariables: variableGeneration.placementVariables,
    publicInstance: variableGeneration.publicInstance,
    publicInstanceDescription: variableGeneration.publicInstanceDescription,
    permutation,
  });
}

export class CircuitGenerator {
  constructor(private readonly result: CircuitGenerationResult) {}

  public getResult(): CircuitGenerationResult {
    return this.result;
  }
}
