import { BUFFER_LIST } from '../subcircuit/configuredTypes.ts';
import { createArithmeticSubcircuitComposition } from '../subcircuit/arithmeticSubcircuitComposition.ts';
import type {
  ResolvedSubcircuitLibrary,
  SubcircuitInfo,
  SubcircuitLibraryData,
  SubcircuitLibraryProvider,
} from '../subcircuit/libraryTypes.ts';
import { createInfoByName } from '../subcircuit/utils.ts';

export function resolveSubcircuitLibraryData(
  data: SubcircuitLibraryData,
): ResolvedSubcircuitLibrary {
  const subcircuitInfoByName = createInfoByName(data.subcircuitInfo);

  return {
    data,
    arithmeticSubcircuitComposition: createArithmeticSubcircuitComposition(
      data.frontendCfg,
    ),
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
    accumulatorInputLimit: data.frontendCfg.nAccumulation,
    numberOfPrevBlockHashes: data.frontendCfg.nPrevBlockHashes,
    poseidonBatchSize: data.frontendCfg.nPoseidonBatch,
    jubjubExpBatchSize: data.frontendCfg.nJubjubExpBatch,
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
