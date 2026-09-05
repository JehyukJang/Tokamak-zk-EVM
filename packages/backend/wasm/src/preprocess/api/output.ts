import { createBinaryArtifactFile } from "../../artifacts/binary/binary-artifact-file.js";
import { UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC } from "../../generated/browser-artifact-contracts.generated.js";
import type { CurveRuntime } from "../../runtime/curve/curve.js";
import { BACKEND_WASM_PACKAGE_VERSION } from "../../version.js";

export async function createPreprocessOutput(
  runtime: CurveRuntime,
  sKappa: Uint8Array,
  sC: Uint8Array,
): Promise<Uint8Array> {
  const [section] = UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC.sections;
  const pointsByName: Readonly<Record<string, Uint8Array>> = { S_kappa: sKappa, S_C: sC };
  const points = section.points.map((point) => {
    const value = pointsByName[point.name];
    if (value === undefined) {
      throw new Error(`Missing preprocess output point '${point.name}'.`);
    }
    return runtime.G1.toAffine(value);
  });
  const data = new Uint8Array(points.length * runtime.G1.toAffine(runtime.G1.zero).byteLength);
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].byteLength !== data.byteLength / points.length) {
      throw new Error("Preprocess output must contain 96-byte affine G1 points.");
    }
    data.set(points[index], index * points[index].byteLength);
  }

  return createBinaryArtifactFile({
    kind: UNIVARIATE_VERIFIER_PREPROCESS_V1_SPEC.kind,
    sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
    sections: [
      {
        ...section,
        elementCount: points.length,
        elementByteLength: points[0].byteLength,
        data,
      },
    ],
  });
}
