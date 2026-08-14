import { BUFFER_LIST, TRANSACTION_INPUT_VARIABLES } from '../subcircuit/configuredTypes.ts';
import { createPlacementCompositionMapping } from '../subcircuit/placementCompositionMapping.ts';
import { calculateSubcircuitOutputValues } from '../subcircuit/subcircuitOutputOperations.ts';
import {
  getDataPtTypeFromLogicalInterfaceType,
  getDataPtWireCount,
} from '../synthesizer/types/dataStructure.ts';
import type {
  LogicalInterfacePort,
  ResolvedSubcircuitLibrary,
  SubcircuitInfo,
  SubcircuitLibraryData,
  SubcircuitLibraryProvider,
} from '../subcircuit/libraryTypes.ts';
import { createInfoByName } from '../subcircuit/utils.ts';

function getLogicalPortWireCount(ports: readonly LogicalInterfacePort[]): number {
  return ports.reduce(
    (count, { logicalType }) => count + getDataPtWireCount(
      getDataPtTypeFromLogicalInterfaceType(logicalType),
    ),
    0,
  )
}

function assertLogicalInterfaceWireCounts(
  subcircuitInfoByName: ResolvedSubcircuitLibrary['subcircuitInfoByName'],
): void {
  for (const subcircuit of subcircuitInfoByName.values()) {
    if (subcircuit.logicalInterface === undefined) continue

    const expectedInputWires = getLogicalPortWireCount(subcircuit.logicalInterface.inputs)
    if (expectedInputWires !== subcircuit.NInWires) {
      throw new Error(
        `Synthesizer: ${subcircuit.name} logical interface declares ${expectedInputWires} input wires, but qap-compiler provides ${subcircuit.NInWires}`,
      )
    }

    const expectedOutputWires = getLogicalPortWireCount(subcircuit.logicalInterface.outputs)
    if (expectedOutputWires !== subcircuit.NOutWires) {
      throw new Error(
        `Synthesizer: ${subcircuit.name} logical interface declares ${expectedOutputWires} output wires, but qap-compiler provides ${subcircuit.NOutWires}`,
      )
    }
  }
}

export function resolveSubcircuitLibraryData(
  data: SubcircuitLibraryData,
): ResolvedSubcircuitLibrary {
  if (data.frontendCfg.nPrivateMessageInputs !== TRANSACTION_INPUT_VARIABLES.length) {
    throw new Error(
      `Synthesizer: qap-compiler declares ${data.frontendCfg.nPrivateMessageInputs} private message inputs, but Synthesizer reserves ${TRANSACTION_INPUT_VARIABLES.length}`,
    )
  }
  const subcircuitInfoByName = createInfoByName(data.subcircuitInfo);
  assertLogicalInterfaceWireCounts(subcircuitInfoByName)

  return {
    data,
    placementCompositionMapping: createPlacementCompositionMapping(
      data.frontendCfg,
    ),
    calculateSubcircuitOutputValues,
    subcircuitInfoByName,
    subcircuitBufferMapping: {
      LOG_OUT: subcircuitInfoByName.get('bufferLogOut'),
      STORAGE_STORE: subcircuitInfoByName.get('bufferStorageStore'),
      STORAGE_LOAD: subcircuitInfoByName.get('bufferStorageLoad'),
      TX_IN: subcircuitInfoByName.get('bufferTxIn'),
      BLOCK_IN: subcircuitInfoByName.get('bufferBlockIn'),
      EVM_IN: subcircuitInfoByName.get('bufferEVMIn'),
      PRIVATE_IN: subcircuitInfoByName.get('bufferPrvIn'),
    },
    numberOfPrevBlockHashes: data.frontendCfg.nPrevBlockHashes,
    poseidonBatchSize: data.frontendCfg.nPoseidonBatch,
    firstArithmeticPlacementIndex: BUFFER_LIST.length,
  };
}

export async function loadResolvedSubcircuitLibrary(
  provider: SubcircuitLibraryProvider,
): Promise<ResolvedSubcircuitLibrary> {
  return resolveSubcircuitLibraryData(await provider.getData());
}

export async function loadSubcircuitWasmBuffers(
  provider: SubcircuitLibraryProvider,
  subcircuitInfo: SubcircuitInfo,
): Promise<ArrayBuffer[]> {
  const wasmBuffers: ArrayBuffer[] = [];

  await Promise.all(
    subcircuitInfo.map(async (subcircuit) => {
      wasmBuffers[subcircuit.id] = await provider.loadWasm(subcircuit.id);
    }),
  );

  return wasmBuffers;
}
