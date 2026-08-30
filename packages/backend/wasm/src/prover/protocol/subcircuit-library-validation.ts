import type { SetupParams } from "../../artifacts/setup/setup-params.js";
import { validateSetupParams } from "../../artifacts/setup/validate-setup-params.js";
import type { ProverSubcircuitInfo } from "./witness.js";

export interface BufferPublicPort {
  readonly start: number;
  readonly end: number;
}

/** Validates backend-consumed subcircuit-library relationships after projection. */
export function validateProverSubcircuitLibrary(
  setup: SetupParams,
  subcircuitInfos: readonly ProverSubcircuitInfo[],
): void {
  validateSetupParams(setup);
  if (subcircuitInfos.length !== setup.s_D) {
    throw new Error(`subcircuitInfo has ${subcircuitInfos.length} entries, expected s_D ${setup.s_D}.`);
  }

  for (let index = 0; index < subcircuitInfos.length; index += 1) {
    const info = subcircuitInfos[index];
    if (info.id !== index) {
      throw new Error(`Subcircuit info id ${info.id} does not match its index ${index}.`);
    }
    if (!Number.isSafeInteger(info.Nwires) || info.Nwires < 0) {
      throw new Error(`Invalid Nwires for subcircuit ${info.id}.`);
    }
    if (!Number.isSafeInteger(info.Nconsts) || info.Nconsts < 0 || info.Nconsts > setup.n) {
      throw new Error(`Invalid Nconsts for subcircuit ${info.id}.`);
    }
    if (info.flattenMap.length !== info.Nwires) {
      throw new Error(`Subcircuit ${info.id} has an invalid flattenMap length.`);
    }
    for (const globalWireIndex of info.flattenMap) {
      if (!Number.isSafeInteger(globalWireIndex) || globalWireIndex < 0 || globalWireIndex >= setup.m_D) {
        throw new Error(`Subcircuit ${info.id} maps outside the global-wire domain.`);
      }
    }
    if (info.bufferDirection !== undefined) {
      bufferPublicPort(info);
    }
  }
}

export function bufferPublicPort(info: ProverSubcircuitInfo): BufferPublicPort {
  if (info.bufferDirection === undefined) {
    throw new Error(`Public wire references non-buffer subcircuit ${info.id}.`);
  }
  const encodedRange = info.bufferDirection === "in" ? info.In_idx : info.Out_idx;
  if (encodedRange.length !== 2) {
    throw new Error(`Buffer ${info.id} has an invalid public port range.`);
  }
  const [start, count] = encodedRange;
  const end = start + count;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(count)
    || start <= 0
    || count < 0
    || !Number.isSafeInteger(end)
    || end > info.Nwires
  ) {
    throw new Error(`Buffer ${info.id} has an invalid public port range.`);
  }
  return { start, end };
}
