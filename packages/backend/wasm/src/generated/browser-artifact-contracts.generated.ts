// Generated from producer-owned browser artifact contracts. Do not edit.
import { BinarySectionEncoding, BinarySectionType } from "../artifacts/binary/binary-format.js";
import type { RuntimeArtifactFormatSpec } from "../artifacts/specs/types.js";

export const INSTANCE_V1_SPEC = {
  schemaVersion: 1,
  name: "instance",
  kind: 1,
  sections: [
    {
      label: "instance.public",
      type: BinarySectionType.Instance,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: null,
      elementByteLength: 32,
      points: [],
    },
    {
      label: "instance.function",
      type: BinarySectionType.Instance,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: null,
      elementByteLength: 32,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_PLACEMENT_VARIABLES_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_placement_variables",
  kind: 5,
  sections: [
    {
      label: "placement.subcircuit_ids",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 4,
      points: [],
    },
    {
      label: "placement.variable_offsets",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 4,
      points: [],
    },
    {
      label: "placement.variables",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
      elementCount: null,
      elementByteLength: 32,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_SELECTOR_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_selector",
  kind: 8,
  sections: [
    {
      label: "selector.entries",
      type: BinarySectionType.Placement,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 4,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const PROVER_PERMUTATION_V1_SPEC = {
  schemaVersion: 1,
  name: "prover_permutation",
  kind: 9,
  sections: [
    {
      label: "permutation.entries",
      type: BinarySectionType.Permutation,
      encoding: BinarySectionEncoding.Bytes,
      elementCount: null,
      elementByteLength: 16,
      points: [],
    }
  ],
} as const satisfies RuntimeArtifactFormatSpec;

export const RUNTIME_ARTIFACT_SPECS = [INSTANCE_V1_SPEC, PROVER_PLACEMENT_VARIABLES_V1_SPEC, PROVER_SELECTOR_V1_SPEC, PROVER_PERMUTATION_V1_SPEC] as const;

export function requireRuntimeArtifactSpecForKind(kind: number): RuntimeArtifactFormatSpec {
  const spec = RUNTIME_ARTIFACT_SPECS.find((candidate) => candidate.kind === kind);
  if (spec === undefined) {
    throw new Error(`Unsupported binary artifact kind: ${kind}.`);
  }
  return spec;
}
