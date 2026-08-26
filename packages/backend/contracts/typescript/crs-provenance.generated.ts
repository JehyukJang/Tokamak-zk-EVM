import contract from "./crs-provenance-contract.generated.js";

export type SubcircuitLibraryOrigin = "npmSnapshot" | "localQapCompiler";

export interface DuskSourceProvenance {
  readonly sourceUrl: string;
  readonly sourceSizeBytes: number;
  readonly rawEncoding: string;
  readonly pinnedContribution: string;
  readonly pinnedReadmeUrl: string;
  readonly pinnedDriveFileId: string;
  readonly expectedSourceSha256: string;
  readonly actualSourceSha256: string;
  readonly autoDownloaded: boolean;
  readonly downloadedContribution: string | null;
  readonly downloadedReadmeUrl: string | null;
  readonly downloadedDriveFileId: string | null;
  readonly maxG1ExpUsed: number;
  readonly maxG2ExpUsed: number;
  readonly transcriptConsistencyVerified: boolean;
}

export interface FinalMpcCrsProvenance {
  readonly documentKind: "finalMpcCrs";
  readonly releaseEligible: boolean;
  readonly generatedAtUtc: string;
  readonly compatibleBackendVersion: string;
  readonly subcircuitLibrary: {
    readonly packageName: string;
    readonly packageVersion: string;
    readonly origin: SubcircuitLibraryOrigin;
  };
  readonly phase1SourceProvenance: null | "native" | { readonly duskGroth16: DuskSourceProvenance };
  readonly combinedSigmaSha256: string;
  readonly sigmaPreprocessSha256: string;
  readonly sigmaVerifySha256: string;
}

type JsonSchema = {
  readonly additionalProperties?: boolean;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly type?: string | readonly string[];
};

type ProvenanceContract = {
  readonly documentKinds: {
    readonly finalMpcCrs?: { readonly schema?: JsonSchema };
  };
};

/** Validates a final-MPC document against the backend-owned JSON contract. */
export function parseFinalMpcCrsProvenance(
  value: unknown,
  subject = "CRS provenance",
): FinalMpcCrsProvenance {
  validateJsonSchema(finalMpcCrsSchema(), value, subject);
  return value as FinalMpcCrsProvenance;
}

function validateJsonSchema(schema: JsonSchema, value: unknown, subject: string): void {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter(candidate => tryValidate(candidate, value, subject));
    if (matches.length !== 1) {
      throw new Error(`${subject} does not match exactly one allowed contract shape.`);
    }
    return;
  }

  if (schema.const !== undefined && !sameJsonValue(value, schema.const)) {
    throw new Error(`${subject} must equal ${JSON.stringify(schema.const)}.`);
  }
  if (schema.enum !== undefined && !schema.enum.some(candidate => sameJsonValue(value, candidate))) {
    throw new Error(`${subject} has an unsupported value.`);
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length > 0 && !types.some(type => hasJsonType(value, type))) {
    throw new Error(`${subject} has an invalid type.`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${subject} is shorter than the contract allows.`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      throw new Error(`${subject} does not match the contract pattern.`);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      throw new Error(`${subject} must be an RFC 3339 date-time.`);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    throw new Error(`${subject} is below the contract minimum.`);
  }

  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const field of schema.required ?? []) {
      if (!hasOwn(value, field)) {
        throw new Error(`${subject} is missing ${field}.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (!hasOwn(properties, field)) {
          throw new Error(`${subject} has unsupported field ${field}.`);
        }
      }
    }
    for (const [field, fieldSchema] of Object.entries(properties)) {
      if (hasOwn(value, field)) {
        validateJsonSchema(fieldSchema, value[field], `${subject}.${field}`);
      }
    }
  }
}

function tryValidate(schema: JsonSchema, value: unknown, subject: string): boolean {
  try {
    validateJsonSchema(schema, value, subject);
    return true;
  } catch {
    return false;
  }
}

function hasJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "null":
      return value === null;
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finalMpcCrsSchema(): JsonSchema {
  const schema = (contract as ProvenanceContract).documentKinds.finalMpcCrs?.schema;
  if (schema === undefined) {
    throw new Error("Backend CRS provenance contract does not define finalMpcCrs.");
  }
  return schema;
}

function hasOwn(value: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
