import {
  parseProverSubcircuitInfos,
  parseSetupParams,
} from "../../../scripts/generate/subcircuit-library-input.js";

const setup = {
  l_free: 8,
  l: 12,
  l_user_out: 4,
  l_user: 5,
  l_D: 32,
  m_D: 48,
  n: 16,
  s_D: 4,
  s_max: 8,
  futureFrontendOnlyField: { enabled: true },
};

const subcircuit = {
  id: 0,
  name: "example",
  Nwires: 3,
  Nconsts: 2,
  Out_idx: [1],
  In_idx: [2],
  flattenMap: [12, 0, 1],
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

expectFailure(
  () => parseSetupParams({ ...setup, l_free: "8" }),
  "Setup decoder must reject malformed required fields.",
);
expectFailure(
  () => parseProverSubcircuitInfos([{ ...subcircuit, flattenMap: undefined }]),
  "Subcircuit decoder must reject missing required fields.",
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
