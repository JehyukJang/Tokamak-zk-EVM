import {
  parseProverSubcircuitInfos,
  parseSetupParams,
} from "../../../scripts/generate/subcircuit-library-input.js";
import { parseR1csTransport } from "../../../scripts/generate/generate-subcircuit-library.js";
import { readSelectedInputOrigin } from "../../../scripts/generate/input-origin.js";
import { parseSubcircuitLibraryOrigin } from "../../../src/generated/crs-provenance-validator.generated.js";
import { PublicWireLayout } from "../../../src/prover/protocol/public-wire-layout.js";
import { validateProverSubcircuitLibrary } from "../../../src/prover/protocol/subcircuit-library-validation.js";

const setup = {
  l_free: 8,
  l: 12,
  l_user_out: 4,
  l_user: 5,
  l_D: 28,
  m_D: 48,
  n: 16,
  s_D: 1,
  s_max: 8,
  futureFrontendOnlyField: { enabled: true },
};

const subcircuit = {
  id: 0,
  name: "example",
  Nwires: 5,
  Nconsts: 2,
  Out_idx: [1, 4],
  In_idx: [1, 4],
  flattenMap: [12, 8, 9, 10, 11],
  bufferDirection: "out",
  logicalInterface: { inputs: [], outputs: [] },
};

const projectedSetup = parseSetupParams(setup);
if (hasOwn(projectedSetup, "futureFrontendOnlyField")) {
  throw new Error("Setup projection must omit frontend-owned extension fields.");
}
if (projectedSetup.l !== setup.l) {
  throw new Error("Setup projection changed a required field.");
}

const projectedSubcircuits = parseProverSubcircuitInfos([subcircuit]);
if (hasOwn(projectedSubcircuits[0], "logicalInterface")) {
  throw new Error("Subcircuit projection must omit frontend-owned extension fields.");
}
if (projectedSubcircuits[0].bufferDirection !== "out") {
  throw new Error("Subcircuit projection changed an owned optional field.");
}
validateProverSubcircuitLibrary(projectedSetup, projectedSubcircuits);
PublicWireLayout.derive(projectedSetup, projectedSubcircuits);

const r1csTransport = {
  format: "circom-r1cs",
  magic: "r1cs",
  version: 1,
  endianness: "little",
  sections: { header: 1, constraints: 2 },
};
if (parseR1csTransport(r1csTransport).version !== 1) {
  throw new Error("R1CS transport projection changed its declared version.");
}
expectFailure(
  () => parseR1csTransport({ ...r1csTransport, version: 2 }),
  "Generator must reject an unsupported producer R1CS version.",
);
expectFailure(
  () => parseR1csTransport({ ...r1csTransport, sections: { header: 1, constraints: 3 } }),
  "Generator must reject stale producer R1CS section identifiers.",
);

expectFailure(
  () => parseSetupParams({ ...setup, l_free: "8" }),
  "Setup decoder must reject malformed required fields.",
);
expectFailure(
  () => parseProverSubcircuitInfos([{ ...subcircuit, flattenMap: undefined }]),
  "Subcircuit decoder must reject missing required fields.",
);
expectFailure(
  () => validateProverSubcircuitLibrary({ ...projectedSetup, n: 12 }, projectedSubcircuits),
  "Semantic validation must reject a non-domain setup dimension.",
);
expectFailure(
  () => validateProverSubcircuitLibrary(
    projectedSetup,
    [{ ...projectedSubcircuits[0], flattenMap: [12, 8, 9, 10, 48] }],
  ),
  "Semantic validation must reject a flatten map outside m_D.",
);
expectFailure(
  () => validateProverSubcircuitLibrary(
    projectedSetup,
    [{ ...projectedSubcircuits[0], Out_idx: [0, 4] }],
  ),
  "Semantic validation must reject an invalid buffer public port.",
);

for (const origin of ["localQapCompiler", "npmSnapshot"] as const) {
  if (parseSubcircuitLibraryOrigin(origin) !== origin) {
    throw new Error(`Provenance parser changed accepted origin ${origin}.`);
  }
  if (readSelectedInputOrigin([`--origin=${origin}`]) !== origin) {
    throw new Error(`Generator parser changed accepted origin ${origin}.`);
  }
}
expectFailure(
  () => parseSubcircuitLibraryOrigin("unsupported"),
  "Provenance parser must reject unknown origins.",
);
expectFailure(
  () => readSelectedInputOrigin(["--origin=unsupported"]),
  "Generator parser must reject unknown origins.",
);

console.log("Checked active subcircuit-library input projection");

function expectFailure(action: () => unknown, message: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(message);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
