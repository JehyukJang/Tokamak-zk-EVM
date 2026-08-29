import type { SetupParams } from "../../src/artifacts/setup/setup-params.js";
import { SUBCIRCUIT_LIBRARY_CONTRACT } from "../../src/generated/subcircuit-library-contract.generated.js";
import type { ProverSubcircuitInfo } from "../../src/prover/protocol/witness.js";

const { setupParams: setupContract, subcircuitInfo: subcircuitContract } =
  SUBCIRCUIT_LIBRARY_CONTRACT.libraryArtifacts;

export function parseSetupParams(raw: unknown): SetupParams {
  const source = requireRecord(raw, setupContract.fileName);
  const fields = setupContract.fields;
  return {
    l_free: requireNonNegativeInteger(source[fields.freePublicLength], fieldLabel(setupContract.fileName, fields.freePublicLength)),
    l: requireNonNegativeInteger(source[fields.publicLength], fieldLabel(setupContract.fileName, fields.publicLength)),
    l_user_out: requireNonNegativeInteger(source[fields.userOutputLength], fieldLabel(setupContract.fileName, fields.userOutputLength)),
    l_user: requireNonNegativeInteger(source[fields.userLength], fieldLabel(setupContract.fileName, fields.userLength)),
    l_D: requireNonNegativeInteger(source[fields.domainPublicLength], fieldLabel(setupContract.fileName, fields.domainPublicLength)),
    m_D: requireNonNegativeInteger(source[fields.domainWireLength], fieldLabel(setupContract.fileName, fields.domainWireLength)),
    n: requireNonNegativeInteger(source[fields.constraintCount], fieldLabel(setupContract.fileName, fields.constraintCount)),
    s_D: requireNonNegativeInteger(source[fields.subcircuitCount], fieldLabel(setupContract.fileName, fields.subcircuitCount)),
    s_max: requireNonNegativeInteger(source[fields.placementCapacity], fieldLabel(setupContract.fileName, fields.placementCapacity)),
  };
}

export function parseProverSubcircuitInfos(raw: unknown): readonly ProverSubcircuitInfo[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${subcircuitContract.fileName} must be an array.`);
  }

  return raw.map((entry, index) => {
    const entryLabel = `${subcircuitContract.fileName}[${index}]`;
    const source = requireRecord(entry, entryLabel);
    const fields = subcircuitContract.fields;
    const id = requireNonNegativeInteger(source[fields.id], fieldLabel(entryLabel, fields.id));
    if (id !== index) {
      throw new Error(`${fieldLabel(entryLabel, fields.id)} must equal its array index.`);
    }
    const bufferDirection = parseBufferDirection(
      source[fields.bufferDirection],
      fieldLabel(entryLabel, fields.bufferDirection),
    );
    return {
      id,
      name: requireNonEmptyString(source[fields.name], fieldLabel(entryLabel, fields.name)),
      Nwires: requireNonNegativeInteger(source[fields.wireCount], fieldLabel(entryLabel, fields.wireCount)),
      Nconsts: requireNonNegativeInteger(source[fields.constraintCount], fieldLabel(entryLabel, fields.constraintCount)),
      Out_idx: parseIntegerArray(source[fields.outputRange], fieldLabel(entryLabel, fields.outputRange)),
      In_idx: parseIntegerArray(source[fields.inputRange], fieldLabel(entryLabel, fields.inputRange)),
      flattenMap: parseIntegerArray(source[fields.globalWireMap], fieldLabel(entryLabel, fields.globalWireMap)),
      ...(bufferDirection === undefined ? {} : { bufferDirection }),
    } satisfies ProverSubcircuitInfo;
  });
}

function fieldLabel(objectLabel: string, fieldName: string): string {
  return `${objectLabel}.${fieldName}`;
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
