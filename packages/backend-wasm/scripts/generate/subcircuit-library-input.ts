import type { SetupParams } from "../../src/artifacts/setup/setup-params.js";
import type { ProverSubcircuitInfo } from "../../src/prover/protocol/witness.js";

export function parseSetupParams(raw: unknown): SetupParams {
  const source = requireRecord(raw, "setupParams.json");
  return {
    l_free: requireNonNegativeInteger(source.l_free, "setupParams.json.l_free"),
    l: requireNonNegativeInteger(source.l, "setupParams.json.l"),
    l_user_out: requireNonNegativeInteger(source.l_user_out, "setupParams.json.l_user_out"),
    l_user: requireNonNegativeInteger(source.l_user, "setupParams.json.l_user"),
    l_D: requireNonNegativeInteger(source.l_D, "setupParams.json.l_D"),
    m_D: requireNonNegativeInteger(source.m_D, "setupParams.json.m_D"),
    n: requireNonNegativeInteger(source.n, "setupParams.json.n"),
    s_D: requireNonNegativeInteger(source.s_D, "setupParams.json.s_D"),
    s_max: requireNonNegativeInteger(source.s_max, "setupParams.json.s_max"),
  };
}

export function parseProverSubcircuitInfos(raw: unknown): readonly ProverSubcircuitInfo[] {
  if (!Array.isArray(raw)) {
    throw new Error("subcircuitInfo.json must be an array.");
  }

  return raw.map((entry, index) => {
    const source = requireRecord(entry, `subcircuitInfo.json[${index}]`);
    const id = requireNonNegativeInteger(source.id, `subcircuitInfo.json[${index}].id`);
    if (id !== index) {
      throw new Error(`subcircuitInfo.json[${index}].id must equal its array index.`);
    }
    const bufferDirection = parseBufferDirection(
      source.bufferDirection,
      `subcircuitInfo.json[${index}].bufferDirection`,
    );
    return {
      id,
      name: requireNonEmptyString(source.name, `subcircuitInfo.json[${index}].name`),
      Nwires: requireNonNegativeInteger(source.Nwires, `subcircuitInfo.json[${index}].Nwires`),
      Nconsts: requireNonNegativeInteger(source.Nconsts, `subcircuitInfo.json[${index}].Nconsts`),
      Out_idx: parseIntegerArray(source.Out_idx, `subcircuitInfo.json[${index}].Out_idx`),
      In_idx: parseIntegerArray(source.In_idx, `subcircuitInfo.json[${index}].In_idx`),
      flattenMap: parseIntegerArray(source.flattenMap, `subcircuitInfo.json[${index}].flattenMap`),
      ...(bufferDirection === undefined ? {} : { bufferDirection }),
    } satisfies ProverSubcircuitInfo;
  });
}

function parseBufferDirection(value: unknown, label: string): "in" | "out" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "in" || value === "out") {
    return value;
  }
  throw new Error(`${label} must be \"in\" or \"out\" when present.`);
}

function parseIntegerArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => requireNonNegativeInteger(entry, `${label}[${index}]`));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}
