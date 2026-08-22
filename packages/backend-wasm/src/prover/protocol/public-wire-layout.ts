import type { SetupParams } from "../../artifacts/setup/setup-params.js";
import {
  placementCount,
  placementSubcircuitId,
  type ProverPlacementVariables,
  type ProverSubcircuitInfo,
} from "./witness.js";

export interface PublicWireSource {
  readonly subcircuitId: number;
  readonly localWireIndex: number;
}

export interface PublicWireSegment {
  readonly start: number;
  readonly end: number;
  readonly subcircuitId: number;
  readonly phase: number;
}

export class PublicWireLayout {
  private constructor(
    private readonly lFree: number,
    private readonly sources: readonly (PublicWireSource | undefined)[],
    private readonly publicSegments: readonly PublicWireSegment[],
  ) {}

  static derive(
    setup: SetupParams,
    subcircuitInfos: readonly ProverSubcircuitInfo[],
  ): PublicWireLayout {
    validateSetupDimensions(setup, subcircuitInfos);

    const globalSources: (PublicWireSource | undefined)[] = Array.from({ length: setup.m_D });
    for (let subcircuitId = 0; subcircuitId < subcircuitInfos.length; subcircuitId += 1) {
      const info = subcircuitInfos[subcircuitId];
      validateSubcircuitInfo(info, subcircuitId, setup.m_D);
      for (let localWireIndex = 0; localWireIndex < info.flattenMap.length; localWireIndex += 1) {
        const globalWireIndex = info.flattenMap[localWireIndex];
        if (globalSources[globalWireIndex] !== undefined) {
          throw new Error(`Global wire ${globalWireIndex} has more than one local-wire source.`);
        }
        globalSources[globalWireIndex] = { subcircuitId, localWireIndex };
      }
    }

    validateBufferPrefix(subcircuitInfos, setup.s_max);

    const sources = globalSources.slice(0, setup.l);
    const segments: PublicWireSegment[] = [];
    const seenPublicBuffers = new Set<number>();
    let active: ActiveSegment | undefined;

    for (let globalWireIndex = 0; globalWireIndex < sources.length; globalWireIndex += 1) {
      const source = sources[globalWireIndex];
      if (source === undefined) {
        if (globalWireIndex >= setup.l_free) {
          throw new Error(`Public padding at wire ${globalWireIndex} is outside the free region.`);
        }
        finishSegment(active, seenPublicBuffers, segments);
        active = undefined;
        continue;
      }

      const info = subcircuitInfos[source.subcircuitId];
      const publicPort = publicPortForBuffer(info);
      if (active !== undefined && active.subcircuitId === source.subcircuitId) {
        const expectedLocalWireIndex = active.publicPort.start + globalWireIndex - active.start;
        if (source.localWireIndex !== expectedLocalWireIndex) {
          throw new Error(
            `Public buffer ${source.subcircuitId} has a non-contiguous local-wire mapping at global wire ${globalWireIndex}.`,
          );
        }
        active.end = globalWireIndex + 1;
        continue;
      }

      finishSegment(active, seenPublicBuffers, segments);
      if (source.localWireIndex !== publicPort.start) {
        throw new Error(
          `Public buffer ${source.subcircuitId} starts at local wire ${source.localWireIndex}, expected ${publicPort.start}.`,
        );
      }
      active = {
        start: globalWireIndex,
        end: globalWireIndex + 1,
        subcircuitId: source.subcircuitId,
        publicPort,
      };
    }
    finishSegment(active, seenPublicBuffers, segments);

    return new PublicWireLayout(setup.l_free, sources, segments);
  }

  freePublicLen(): number {
    return this.lFree;
  }

  isFreePublicIndex(globalWireIndex: number): boolean {
    return globalWireIndex >= 0 && globalWireIndex < this.lFree && globalWireIndex < this.sources.length;
  }

  sourceForPublicWire(globalWireIndex: number): PublicWireSource | undefined {
    return this.sources[globalWireIndex];
  }

  segments(): readonly PublicWireSegment[] {
    return this.publicSegments;
  }

  validateRuntimeBufferPlacements(placements: ProverPlacementVariables): void {
    for (const segment of this.publicSegments) {
      if (segment.phase >= placementCount(placements)) {
        throw new Error(`Public buffer phase ${segment.phase} has no runtime placement.`);
      }
      const subcircuitId = placementSubcircuitId(placements, segment.phase);
      if (subcircuitId !== segment.subcircuitId) {
        throw new Error(
          `Runtime placement ${segment.phase} has subcircuit ${subcircuitId}, expected public buffer ${segment.subcircuitId}.`,
        );
      }
    }
  }
}

interface ActiveSegment {
  readonly start: number;
  end: number;
  readonly subcircuitId: number;
  readonly publicPort: WireRange;
}

interface WireRange {
  readonly start: number;
  readonly end: number;
}

function validateSetupDimensions(
  setup: SetupParams,
  subcircuitInfos: readonly ProverSubcircuitInfo[],
): void {
  if (setup.l_free > setup.l) {
    throw new Error("l_free must not exceed l.");
  }
  if (setup.l > setup.l_D || setup.l_D > setup.m_D) {
    throw new Error("Setup public and interface boundaries are invalid.");
  }
  if (subcircuitInfos.length !== setup.s_D) {
    throw new Error(`subcircuitInfo has ${subcircuitInfos.length} entries, expected s_D ${setup.s_D}.`);
  }
}

function validateSubcircuitInfo(
  info: ProverSubcircuitInfo,
  expectedId: number,
  globalWireCount: number,
): void {
  if (info.id !== expectedId) {
    throw new Error(`Subcircuit info id ${info.id} does not match its index ${expectedId}.`);
  }
  if (!Number.isSafeInteger(info.Nwires) || info.Nwires < 0 || info.flattenMap.length !== info.Nwires) {
    throw new Error(`Subcircuit ${info.id} has an invalid flattenMap length.`);
  }
  for (const globalWireIndex of info.flattenMap) {
    if (!Number.isSafeInteger(globalWireIndex) || globalWireIndex < 0 || globalWireIndex >= globalWireCount) {
      throw new Error(`Subcircuit ${info.id} maps outside the global-wire domain.`);
    }
  }
}

function validateBufferPrefix(
  subcircuitInfos: readonly ProverSubcircuitInfo[],
  sMax: number,
): void {
  const bufferIds = subcircuitInfos
    .filter((info) => info.bufferDirection !== undefined)
    .map((info) => info.id);
  if (bufferIds.length === 0) {
    throw new Error("subcircuitInfo does not declare any buffers.");
  }
  for (let expectedId = 0; expectedId < bufferIds.length; expectedId += 1) {
    if (bufferIds[expectedId] !== expectedId) {
      throw new Error(`Buffer subcircuit ids must form a prefix; missing id ${expectedId}.`);
    }
    if (expectedId >= sMax) {
      throw new Error(`Buffer phase ${expectedId} is outside s_max ${sMax}.`);
    }
  }
}

function publicPortForBuffer(info: ProverSubcircuitInfo): WireRange {
  if (info.bufferDirection === undefined) {
    throw new Error(`Public wire references non-buffer subcircuit ${info.id}.`);
  }
  if (info.bufferDirection !== "in" && info.bufferDirection !== "out") {
    throw new Error(`Buffer ${info.id} has an invalid direction.`);
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

function finishSegment(
  active: ActiveSegment | undefined,
  seenPublicBuffers: Set<number>,
  segments: PublicWireSegment[],
): void {
  if (active === undefined) {
    return;
  }
  if (seenPublicBuffers.has(active.subcircuitId)) {
    throw new Error(`Public buffer ${active.subcircuitId} appears in more than one global-wire run.`);
  }
  if (active.end - active.start !== active.publicPort.end - active.publicPort.start) {
    throw new Error(`Public buffer ${active.subcircuitId} does not cover its complete public port.`);
  }
  seenPublicBuffers.add(active.subcircuitId);
  segments.push({
    start: active.start,
    end: active.end,
    subcircuitId: active.subcircuitId,
    phase: active.subcircuitId,
  });
}
