import { SynthesizerInterface } from '../synthesizer/types/index.ts';
import {
  VariableGenerator,
  type VariableGenerationResult,
} from './handlers/variableGenerator.ts';
import { Placements } from '../synthesizer/types/placements.ts';
import { PermutationGenerator } from './handlers/permutationGenerator.ts';
import {
  CircuitArtifacts,
} from './types/types.ts';
import type { ResolvedSubcircuitLibrary } from '../subcircuit/libraryTypes.ts';

export async function createCircuitGenerator(synthesizer: SynthesizerInterface, subcircuitWasmBuffers: any[]): Promise<CircuitGenerator> {
  const variableGeneration = await new VariableGenerator(
    synthesizer,
    synthesizer.subcircuitLibrary,
    subcircuitWasmBuffers,
  ).generate();
  const permutation = new PermutationGenerator(
    variableGeneration,
    synthesizer.subcircuitLibrary,
  ).permutation;
  return new CircuitGenerator(
    synthesizer,
    variableGeneration,
    permutation,
  );
}

export class CircuitGenerator {
  public readonly synthesizer: SynthesizerInterface;
  public readonly subcircuitLibrary: ResolvedSubcircuitLibrary;
  public readonly circuitPlacements: Placements;
  private readonly artifacts: CircuitArtifacts;

  constructor(
    synthesizer: SynthesizerInterface,
    variableGeneration: VariableGenerationResult,
    permutation: CircuitArtifacts['permutation'],
  ) {
    this.synthesizer = synthesizer;
    this.subcircuitLibrary = synthesizer.subcircuitLibrary;
    this.circuitPlacements = variableGeneration.circuitPlacements;
    this.artifacts = {
      placementVariables: variableGeneration.placementVariables,
      publicInstance: variableGeneration.publicInstance,
      publicInstanceDescription: variableGeneration.publicInstanceDescription,
      permutation,
    };
  }

  public getArtifacts(): CircuitArtifacts {
    return this.artifacts;
  }
}
