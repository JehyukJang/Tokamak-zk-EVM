import type { SetupParams } from "../../artifacts/setup/setup-params.js";
import {
  placementCount,
  placementSubcircuitId,
  type ProverPlacementVariables,
  type ProverSubcircuitInfo,
} from "./witness.js";
import {
  bufferPublicPort,
  validateProverSubcircuitLibrary,
} from "./subcircuit-library-validation.js";

export interface PublicWireSource {
  readonly subcircuitId: number;
  readonly localWireIndex: number;
}

export interface PublicWireSegment {
  readonly start: number;
  readonly end: number;
  readonly subcircuitId: number;
  /** Placement-list phase assigned by the ordered buffer declarations. */
  readonly placementPhase: number;
}

export class PublicWireLayout {
  private constructor(
    private readonly lFree: number,
    private readonly sources: readonly (PublicWireSource | undefined)[],
    private readonly publicSegments: readonly PublicWireSegment[],
    private readonly placementPhaseBySubcircuitId: ReadonlyMap<number, number>,
  ) {}

  static derive(
    setup: SetupParams,
    subcircuitInfos: readonly ProverSubcircuitInfo[],
  ): PublicWireLayout {
    validateProverSubcircuitLibrary(setup, subcircuitInfos);
    const placementPhaseBySubcircuitId = deriveBufferPlacementPhases(subcircuitInfos, setup.s_max);

    const globalSources: (PublicWireSource | undefined)[] = Array.from({ length: setup.m_D });
    for (let subcircuitId = 0; subcircuitId < subcircuitInfos.length; subcircuitId += 1) {
      const info = subcircuitInfos[subcircuitId];
      for (let localWireIndex = 0; localWireIndex < info.flattenMap.length; localWireIndex += 1) {
        const globalWireIndex = info.flattenMap[localWireIndex];
        if (globalSources[globalWireIndex] !== undefined) {
          throw new Error(`Global wire ${globalWireIndex} has more than one local-wire source.`);
        }
        globalSources[globalWireIndex] = { subcircuitId, localWireIndex };
      }
    }

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
        finishSegment(active, seenPublicBuffers, segments, placementPhaseBySubcircuitId);
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

      finishSegment(active, seenPublicBuffers, segments, placementPhaseBySubcircuitId);
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
    finishSegment(active, seenPublicBuffers, segments, placementPhaseBySubcircuitId);

    return new PublicWireLayout(
      setup.l_free,
      sources,
      segments,
      placementPhaseBySubcircuitId,
    );
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

  placementPhaseForPublicWire(globalWireIndex: number): number | undefined {
    const source = this.sourceForPublicWire(globalWireIndex);
    return source === undefined
      ? undefined
      : this.placementPhaseForSubcircuit(source.subcircuitId);
  }

  placementPhaseForSubcircuit(subcircuitId: number): number | undefined {
    return this.placementPhaseBySubcircuitId.get(subcircuitId);
  }

  segments(): readonly PublicWireSegment[] {
    return this.publicSegments;
  }

  validateRuntimeBufferPlacements(placements: ProverPlacementVariables): void {
    const publicBufferIds = new Set(this.publicSegments.map((segment) => segment.subcircuitId));
    const runtimePhaseBySubcircuitId = new Map<number, number>();

    for (let placementPhase = 0; placementPhase < placementCount(placements); placementPhase += 1) {
      const subcircuitId = placementSubcircuitId(placements, placementPhase);
      if (!publicBufferIds.has(subcircuitId)) {
        continue;
      }
      const previousPhase = runtimePhaseBySubcircuitId.get(subcircuitId);
      if (previousPhase !== undefined) {
        throw new Error(
          `Public buffer ${subcircuitId} appears at runtime placement phases ${previousPhase} and ${placementPhase}.`,
        );
      }
      runtimePhaseBySubcircuitId.set(subcircuitId, placementPhase);
    }

    for (const segment of this.publicSegments) {
      const runtimePhase = runtimePhaseBySubcircuitId.get(segment.subcircuitId);
      if (runtimePhase === undefined) {
        throw new Error(`Public buffer ${segment.subcircuitId} has no runtime placement.`);
      }
      if (runtimePhase !== segment.placementPhase) {
        throw new Error(
          `Public buffer ${segment.subcircuitId} is at runtime placement phase ${runtimePhase}, expected ${segment.placementPhase}.`,
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

function publicPortForBuffer(info: ProverSubcircuitInfo): WireRange {
  return bufferPublicPort(info);
}

function finishSegment(
  active: ActiveSegment | undefined,
  seenPublicBuffers: Set<number>,
  segments: PublicWireSegment[],
  placementPhaseBySubcircuitId: ReadonlyMap<number, number>,
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
  const placementPhase = placementPhaseBySubcircuitId.get(active.subcircuitId);
  if (placementPhase === undefined) {
    throw new Error(`Public buffer ${active.subcircuitId} has no placement phase.`);
  }
  segments.push({
    start: active.start,
    end: active.end,
    subcircuitId: active.subcircuitId,
    placementPhase,
  });
}

function deriveBufferPlacementPhases(
  subcircuitInfos: readonly ProverSubcircuitInfo[],
  sMax: number,
): ReadonlyMap<number, number> {
  const placementPhaseBySubcircuitId = new Map<number, number>();

  for (const info of subcircuitInfos) {
    if (info.bufferDirection === undefined) {
      continue;
    }
    const placementPhase = placementPhaseBySubcircuitId.size;
    if (placementPhase >= sMax) {
      throw new Error(`Buffer placement phase ${placementPhase} is outside s_max ${sMax}.`);
    }
    if (placementPhaseBySubcircuitId.has(info.id)) {
      throw new Error(`Subcircuit library contains duplicate buffer id ${info.id}.`);
    }
    placementPhaseBySubcircuitId.set(info.id, placementPhase);
  }

  if (placementPhaseBySubcircuitId.size === 0) {
    throw new Error("Subcircuit library does not declare any buffers.");
  }

  return placementPhaseBySubcircuitId;
}
