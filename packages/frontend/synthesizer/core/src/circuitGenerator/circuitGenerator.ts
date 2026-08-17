import { SynthesizerInterface } from '../synthesizer/types/index.ts';
import {
  VariableGenerator,
} from './handlers/variableGenerator.ts';
import { PermutationGenerator } from './handlers/permutationGenerator.ts';
import {
  CircuitGenerationResult,
} from './types/types.ts';

export async function createCircuitGenerator(synthesizer: SynthesizerInterface): Promise<CircuitGenerationResult> {
  const variableGeneration = await new VariableGenerator(
    synthesizer,
    synthesizer.subcircuitLibrary,
  ).generate();
  const permutation = new PermutationGenerator(
    variableGeneration.circuitPlacements,
    variableGeneration.placementVariables,
    synthesizer.subcircuitLibrary,
  ).permutation;
  return {
    placements: variableGeneration.circuitPlacements,
    placementVariables: variableGeneration.placementVariables,
    publicInstance: variableGeneration.publicInstance,
    publicInstanceDescription: variableGeneration.publicInstanceDescription,
    permutation,
  };
}
