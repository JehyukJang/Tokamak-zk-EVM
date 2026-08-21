import { addHexPrefix } from '@ethereumjs/util';
import { BUFFER_LIST } from '../subcircuit/configuredTypes.ts';
import { SynthesizerInterface } from '../synthesizer/types/index.ts';
import type { PlacementVariables } from '../synthesizer/types/placements.ts';
import {
  VariableGenerator,
} from './generators/variableGenerator.ts';
import { PermutationGenerator } from './generators/permutationGenerator.ts';
import {
  CircuitGenerationResult,
  PublicInstance,
  PublicInstanceDescription,
} from './types/types.ts';

const extractPublicProjection = (
  placementVariables: PlacementVariables,
  synthesizer: SynthesizerInterface,
): Readonly<{
  publicInstance: PublicInstance;
  publicInstanceDescription: PublicInstanceDescription;
}> => {
  const { globalWireList, setupParams } = synthesizer.subcircuitLibrary.data;
  const values: `0x${string}`[] = Array(setupParams.l).fill('0x00');
  const descriptions: string[] = Array(setupParams.l).fill('');
  for (let globalIdx = 0; globalIdx < setupParams.l; globalIdx++) {
    const [subcircuitId, localVariableIdx] = globalWireList[globalIdx];
    if (subcircuitId === -1 || localVariableIdx === -1) continue

    const publicBuffers = BUFFER_LIST.filter(
      (buffer) =>
        synthesizer.subcircuitLibrary.subcircuitBufferMapping[buffer]?.id === subcircuitId
        && buffer !== 'PRIVATE_IN',
    );
    if (publicBuffers.length !== 1) {
      throw new Error(`Public wire ${globalIdx} does not belong to one declared public buffer`);
    }
    const placements = placementVariables.filter((entry) => entry.subcircuitId === subcircuitId);
    if (placements.length !== 1) {
      throw new Error(`Public buffer ${publicBuffers[0]} must have exactly one runtime placement`);
    }
    const placement = placements[0]!;
    const value = placement.variables[localVariableIdx];
    const description = placement.instanceList[localVariableIdx];
    if (value === undefined || description === undefined) {
      throw new Error('Global wire metadata does not resolve to a placement variable');
    }
    values[globalIdx] = addHexPrefix(value);
    descriptions[globalIdx] = description;
  }
  const { l_user, l_free } = setupParams;
  return {
    publicInstance: {
      a_pub_user: values.slice(0, l_user),
      a_pub_block: values.slice(l_user, l_free),
      a_pub_function: values.slice(l_free),
    },
    publicInstanceDescription: {
      a_pub_user_description: descriptions.slice(0, l_user),
      a_pub_block_description: descriptions.slice(l_user, l_free),
      a_pub_function_description: descriptions.slice(l_free),
    },
  };
};

export async function createCircuitGenerator(synthesizer: SynthesizerInterface): Promise<CircuitGenerationResult> {
  const variableGeneration = await new VariableGenerator(
    synthesizer,
    synthesizer.subcircuitLibrary,
  ).generate();
  const publicProjection = extractPublicProjection(
    variableGeneration.placementVariables,
    synthesizer,
  );
  const permutation = new PermutationGenerator(
    variableGeneration.circuitPlacements,
    variableGeneration.placementVariables,
    synthesizer.subcircuitLibrary,
  ).permutation;
  return {
    placements: variableGeneration.circuitPlacements,
    placementVariables: variableGeneration.placementVariables,
    ...publicProjection,
    permutation,
  };
}
