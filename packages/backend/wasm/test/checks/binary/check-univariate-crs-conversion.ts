import { decodeBinaryArtifactFile } from "../../../src/artifacts/binary/binary-artifact-file.js";
import { BinaryArtifactFileKind } from "../../../src/artifacts/binary/binary-format.js";
import { assertBinaryArtifactShape } from "../../../src/artifacts/binary/structural-validation.js";
import {
  UNIVARIATE_V2_PREPROCESS_CRS_V1_SPEC,
  UNIVARIATE_V2_PROVER_CRS_V1_SPEC,
  UNIVARIATE_V2_VERIFIER_CRS_V1_SPEC,
} from "../../../src/generated/browser-artifact-contracts.generated.js";
import { convertUnivariateCrs } from "../../../src/converter/conversion/univariate-crs-converter.js";
import { withCurveRuntime } from "../../../src/converter/conversion/conversion-runtime.js";
import {
  parseUnivariatePreprocessCrs,
  parseUnivariateProverCrs,
  parseUnivariateVerifierCrs,
} from "../../../src/univariate/crs.js";

async function main(): Promise<void> {
  const fixture = await withCurveRuntime((runtime) => {
    const g1 = runtime.G1.formatAffine(runtime.G1.generator);
    const g2 = runtime.G2.formatAffine(runtime.G2.generator);
    return {
      schemaId: "tokamak-zk-evm-univariate-v2",
      shape: { declaredCapacity: [1, 1, 1], k: 1 },
      s0G1: [g1, g1],
      sxiG1: [g1, g1],
      spsiG1: [g1, g1],
      oneG2: g2,
      tauG2: g2,
      tauKG2: g2,
      gammaG2: g2,
      etaG2: g2,
      deltaG2: g2,
      gammaInvPublicQueries: [
        { bufferSubcircuitId: 0, localPublicWireIndex: 1, point: g1 },
      ],
      etaInvInterfaceQueries: [
        { placementIndex: 0, subcircuitId: 0, localWireIndex: 2, point: g1 },
      ],
      deltaInvInternalQueries: [
        { placementIndex: 1, subcircuitId: 0, localWireIndex: 3, point: g1 },
      ],
      deltaInvUMaskingQueries: [g1, g1],
      deltaInvVMaskingQueries: [g1, g1],
      deltaInvWMaskingQueries: [g1, g1],
      deltaInvBMaskingQueries: [g1, g1],
      deltaG1: g1,
      etaG1: g1,
    };
  });
  const artifacts = await convertUnivariateCrs(fixture);

  checkArtifact(
    artifacts.preprocessCrs,
    BinaryArtifactFileKind.UnivariateV2PreprocessCrs,
    UNIVARIATE_V2_PREPROCESS_CRS_V1_SPEC,
  );
  checkArtifact(
    artifacts.proverCrs,
    BinaryArtifactFileKind.UnivariateV2ProverCrs,
    UNIVARIATE_V2_PROVER_CRS_V1_SPEC,
  );
  checkArtifact(
    artifacts.verifierCrs,
    BinaryArtifactFileKind.UnivariateV2VerifierCrs,
    UNIVARIATE_V2_VERIFIER_CRS_V1_SPEC,
  );

  if (parseUnivariatePreprocessCrs(artifacts.preprocessCrs).s0.elementCount !== 2) {
    throw new Error("Univariate preprocess CRS reader lost the S0 range.");
  }
  const proverRuntime = parseUnivariateProverCrs(artifacts.proverCrs);
  if (proverRuntime.interfaceQueries.keyAt(0).localWireIndex !== 2) {
    throw new Error("Univariate prover CRS reader lost the tagged interface key.");
  }
  const verifierRuntime = parseUnivariateVerifierCrs(artifacts.verifierCrs);
  if (verifierRuntime.publicQueries.keyAt(0).localPublicWireIndex !== 1) {
    throw new Error("Univariate verifier CRS reader lost the compressed public key.");
  }
  await expectRejects(
    async () => parseUnivariateProverCrs(artifacts.preprocessCrs),
    "kind mismatch",
  );

  const prover = decodeBinaryArtifactFile(artifacts.proverCrs);
  const interfaceKeys = prover.sections.find((section) => section.label === "crs.interface-query-keys");
  if (interfaceKeys?.elementCount !== 1 || interfaceKeys.elementByteLength !== 12) {
    throw new Error("Univariate prover CRS did not preserve its tagged-query key table.");
  }
  const verifier = decodeBinaryArtifactFile(artifacts.verifierCrs);
  const publicKeys = verifier.sections.find((section) => section.label === "crs.public-query-keys");
  if (publicKeys?.elementCount !== 1 || publicKeys.elementByteLength !== 8) {
    throw new Error("Univariate verifier CRS did not preserve its compressed public-query key table.");
  }

  await expectRejects(
    () => convertUnivariateCrs({ ...fixture, schemaId: "legacy-sigma" }),
    "supported univariate schema",
  );
  console.log("Checked role-specific U18--U22 browser CRS conversion and legacy-schema rejection");
}

function checkArtifact(
  bytes: Uint8Array,
  kind: BinaryArtifactFileKind,
  spec: Parameters<typeof assertBinaryArtifactShape>[1],
): void {
  const artifact = decodeBinaryArtifactFile(bytes);
  if (artifact.kind !== kind) {
    throw new Error(`Univariate CRS artifact kind mismatch: expected ${kind}, got ${artifact.kind}.`);
  }
  assertBinaryArtifactShape(artifact, spec);
}

async function expectRejects(run: () => Promise<unknown>, expectedMessage: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected conversion to reject with ${JSON.stringify(expectedMessage)}.`);
}

await main();
