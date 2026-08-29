import {
  BinaryArtifactFileKind,
  BinarySectionEncoding,
  BinarySectionType,
  type BinarySectionInput,
} from '../../../src/artifacts/binary/binary-format.js';
import {
  createBinaryArtifactFile,
  decodeBinaryArtifactFile,
} from '../../../src/artifacts/binary/binary-artifact-file.js';
import { loadNamedArtifactPoints } from '../../../src/artifacts/specs/format-spec-loader.js';
import { VERIFIER_PROOF_V1_SPEC } from '../../../src/generated/browser-artifact-contracts.generated.js';
import { createCurveRuntime } from '../../../src/runtime/curve/curve.js';
import { BACKEND_WASM_PACKAGE_VERSION } from '../../../src/version.js';
import type { FieldElement, FieldRuntime } from '../../../src/runtime/field/field-runtime.js';
import type { SetupParams } from '../../../src/artifacts/setup/setup-params.js';
import { BivariatePolynomialBuffer } from '../../../src/runtime/polynomial/bivariate-polynomial-buffer.js';
import {
  parseProverCrs,
  loadProverRuntimeWitnessInputParts,
  proverCrsG1PointAt,
  proverCrsG1PointRange,
  validateProverCrsForSetup,
} from '../../../src/prover/api/binary-input.js';
import {
  combineInitialRelation,
  computeArithmeticArgumentCommitments,
  computeCopyWitnessCommitment,
} from '../../../src/prover/protocol/initial-relation.js';
import {
  buildProverBinding,
  countOMidVariables,
  countOPrvVariables,
} from '../../../src/prover/commitments/binding-commitments.js';
import { PublicWireLayout } from '../../../src/prover/protocol/public-wire-layout.js';
import {
  createSigma1CommitmentEncoder,
  encodePolynomialBufferWithSigma1,
} from '../../../src/prover/commitments/sigma1-encoder.js';
import { computeRecursionCommitment } from '../../../src/prover/protocol/recursion-commitment.js';
import { computeCopyQuotientCommitments } from '../../../src/prover/protocol/copy-quotient.js';
import { evaluateChallengePoints } from '../../../src/prover/protocol/challenge-evaluations.js';
import {
  combineOpeningCommitments,
  computeCopyOpeningCommitments,
  computeIntegratedOpeningCommitments,
} from '../../../src/prover/protocol/opening-commitments.js';
import { createVerifierProofArtifactFromProverOutput } from '../../../src/prover/api/proof-output.js';
import {
  buildProverInstancePolynomials,
  createProverMixer,
  createProverState,
} from '../../../src/prover/protocol/state.js';
import { GENERATED_SETUP_PARAMS } from '../../../src/generated/active/setup.generated.js';
import {
  buildWitnessPolynomials,
  placementCount,
  placementVariableAt,
  type ProverPackedSparseMatrix,
  type ProverPackedSparseSubcircuitR1cs,
  type ProverPlacementVariables,
  type ProverPermutationEntry,
  type ProverSubcircuitInfo,
} from '../../../src/prover/protocol/witness.js';
import { assertEqual } from '../../support/assertions.js';
import { assertBytesEqual, concatBytes } from '../../support/bytes.js';

interface ProverSparseMatrix {
  readonly activeWires: readonly number[];
  readonly sparseRows: readonly (readonly {
    readonly column: number;
    readonly coefficient: FieldElement;
  }[])[];
}

interface ProverSparseSubcircuitR1cs {
  readonly subcircuitId: number;
  readonly A: ProverSparseMatrix;
  readonly B: ProverSparseMatrix;
  readonly C: ProverSparseMatrix;
}

async function main(): Promise<void> {
  checkPublicWireLayout();
  const runtime = await createCurveRuntime();

  try {
    const setup: SetupParams = {
      l_free: 2,
      l: 2,
      l_user_out: 0,
      l_user: 1,
      l_D: 4,
      m_D: 4,
      n: 2,
      s_D: 2,
      s_max: 2,
    };
    const subcircuitInfos: ProverSubcircuitInfo[] = [
      {
        id: 0,
        name: 'synthetic-0',
        Nwires: 3,
        Nconsts: 0,
        Out_idx: [],
        In_idx: [],
        flattenMap: [0, 2, 3],
      },
      {
        id: 1,
        name: 'synthetic-1',
        Nwires: 3,
        Nconsts: 0,
        Out_idx: [],
        In_idx: [],
        flattenMap: [1, 2, 3],
      },
    ];
    const placementEntries = [
      {
        subcircuitId: 0,
        variables: [fr(2n), fr(5n), fr(0n)],
      },
      {
        subcircuitId: 1,
        variables: [fr(3n), fr(7n), fr(11n)],
      },
    ];
    const placementVariables = packPlacementVariables(runtime.Fr.byteLength, placementEntries);
    const permutation: ProverPermutationEntry[] = [
      { row: 0, col: 0, X: 1, Y: 1 },
      { row: 1, col: 1, X: 0, Y: 0 },
    ];
    const r1csBySubcircuit: ProverSparseSubcircuitR1cs[] = [
      {
        subcircuitId: 0,
        A: {
          activeWires: [0, 1],
          sparseRows: [
            [
              { column: 0, coefficient: fr(2n) },
              { column: 1, coefficient: fr(3n) },
            ],
            [{ column: 1, coefficient: fr(1n) }],
          ],
        },
        B: {
          activeWires: [1],
          sparseRows: [[{ column: 0, coefficient: fr(4n) }], []],
        },
        C: {
          activeWires: [2],
          sparseRows: [[], [{ column: 0, coefficient: fr(5n) }]],
        },
      },
      {
        subcircuitId: 1,
        A: {
          activeWires: [0, 2],
          sparseRows: [
            [
              { column: 0, coefficient: fr(1n) },
              { column: 1, coefficient: fr(2n) },
            ],
            [{ column: 1, coefficient: fr(3n) }],
          ],
        },
        B: {
          activeWires: [1],
          sparseRows: [[{ column: 0, coefficient: fr(6n) }], []],
        },
        C: {
          activeWires: [0, 2],
          sparseRows: [[], [{ column: 1, coefficient: fr(7n) }]],
        },
      },
    ];

    const witness = await buildWitnessPolynomials(runtime.Fr, {
      setup,
      subcircuitInfos,
      placementVariables,
      r1csBySubcircuit: packSparseR1cs(runtime.Fr, r1csBySubcircuit, setup.n),
    });

    await assertRouEvals(witness.bXY, [5n, 7n, 0n, 11n], 'bXY');
    await assertRouEvals(witness.uXY, [19n, 25n, 5n, 33n], 'uXY');
    await assertRouEvals(witness.vXY, [20n, 42n, 0n, 0n], 'vXY');
    await assertRouEvals(witness.wXY, [0n, 0n, 0n, 77n], 'wXY');
    assertEqual(witness.rXY.xSize, 1, 'rXY xSize');
    assertEqual(witness.rXY.ySize, 1, 'rXY ySize');
    assertFieldEqual(witness.rXY.getCoeff(0, 0), runtime.Fr.zero, 'rXY zero');

    const instancePolynomials = await buildProverInstancePolynomials(
      runtime.Fr,
      setup,
      [fr(13n), fr(17n)],
      permutation,
    );
    await assertRouEvals(instancePolynomials.aFreeX, [13n, 17n], 'aFreeX');
    const negOne = runtime.Fr.toBigInt(runtime.Fr.neg(runtime.Fr.one));
    await assertRouEvals(instancePolynomials.s0XY, [negOne, 1n, negOne, 1n], 's0XY');
    await assertRouEvals(instancePolynomials.s1XY, [negOne, negOne, 1n, 1n], 's1XY');
    assertFieldEqual(instancePolynomials.tN.getCoeff(0, 0), runtime.Fr.neg(runtime.Fr.one), 'tN constant');
    assertFieldEqual(instancePolynomials.tN.getCoeff(setup.n, 0), runtime.Fr.one, 'tN lead');
    assertFieldEqual(instancePolynomials.tSMax.getCoeff(0, setup.s_max), runtime.Fr.one, 'tSMax lead');
    const mixer = await createProverMixer(runtime);
    assertEqual(mixer.rW_X.length, 4, 'mixer rW_X length');
    assertEqual(mixer.rW_Y.length, 4, 'mixer rW_Y length');
    assertEqual(mixer.rB_X.length, 2, 'mixer rB_X length');
    assertEqual(mixer.rB_Y.length, 2, 'mixer rB_Y length');
    const prove0Setup: SetupParams = {
      l_free: 2,
      l: 2,
      l_user_out: 0,
      l_user: 1,
      l_D: 6,
      m_D: 10,
      n: 4,
      s_D: 2,
      s_max: 4,
    };
    const prove0Witness = {
      bXY: monomialPolynomial(3, 3, fr(2n), 4, 4),
      uXY: monomialPolynomial(4, 4, fr(1n), 8, 8),
      vXY: BivariatePolynomialBuffer.fromCoeffs(runtime.Fr, [fr(1n)], 1, 1),
      wXY: BivariatePolynomialBuffer.zero(runtime.Fr),
      rXY: BivariatePolynomialBuffer.zero(runtime.Fr),
    };
    const smallProverState = await createProverState({
      runtime,
      setup: prove0Setup,
      publicInstance: [fr(13n), fr(17n)],
      permutation: [],
      witness: prove0Witness,
    });
    const smallCrs = createSyntheticProverCrs(prove0Setup, 64);
    validateProverCrsForSetup(smallCrs, prove0Setup);
    assertThrows(
      () => validateProverCrsForSetup(createSyntheticProverCrs(prove0Setup, 63), prove0Setup),
      'setup-bound prover CRS validation',
    );
    const smallEncoder = createSigma1CommitmentEncoder(runtime, smallCrs, prove0Setup);
    const smallArithmetic = await computeArithmeticArgumentCommitments(runtime, smallProverState, smallEncoder);
    const smallCopyWitness = await computeCopyWitnessCommitment(runtime, smallProverState, smallEncoder);
    const smallProve0 = combineInitialRelation(smallArithmetic, smallCopyWitness);
    assertEqual(smallProve0.commitments.U.byteLength, 144, 'prove0 U byte length');
    assertEqual(smallProve0.commitments.B.byteLength, 144, 'prove0 B byte length');
    const smallProve1 = await computeRecursionCommitment(
      runtime,
      smallProverState,
      [runtime.Fr.zero, runtime.Fr.zero, runtime.Fr.one],
      smallEncoder,
    );
    assertEqual(smallProve1.commitment.R.byteLength, 144, 'prove1 R byte length');
    await assertRouEvals(
      smallProve1.rXY,
      Array.from({ length: (prove0Setup.l_D - prove0Setup.l) * prove0Setup.s_max }, () => 1n),
      'prove1 rXY',
    );
    const smallProve2 = await computeCopyQuotientCommitments({
      runtime,
      state: smallProverState,
      rXY: smallProve1.rXY,
      thetas: [runtime.Fr.zero, runtime.Fr.zero, runtime.Fr.one],
      kappa0: fr(9n),
      commitmentEncoder: smallEncoder,
    });
    assertEqual(smallProve2.commitments.Q_CX.byteLength, 144, 'prove2 Q_CX byte length');
    assertEqual(smallProve2.commitments.Q_CY.byteLength, 144, 'prove2 Q_CY byte length');
    const smallProve3 = await evaluateChallengePoints({
      runtime,
      state: smallProverState,
      rXY: smallProve1.rXY,
      chi: fr(11n),
      zeta: fr(13n),
    });
    assertEqual(smallProve3.V_eval.byteLength, runtime.Fr.byteLength, 'prove3 V_eval byte length');
    assertEqual(smallProve3.R_eval.byteLength, runtime.Fr.byteLength, 'prove3 R_eval byte length');
    assertEqual(smallProve3.R_omegaX_eval.byteLength, runtime.Fr.byteLength, 'prove3 R_omegaX_eval byte length');
    assertEqual(
      smallProve3.R_omegaX_omegaY_eval.byteLength,
      runtime.Fr.byteLength,
      'prove3 R_omegaX_omegaY_eval byte length',
    );
    const smallCopyOpenings = await computeCopyOpeningCommitments({
      runtime,
      state: smallProverState,
      rXY: smallProve1.rXY,
      chi: fr(11n),
      zeta: fr(13n),
      commitmentEncoder: smallEncoder,
    });
    const smallIntegratedOpenings = await computeIntegratedOpeningCommitments({
      runtime,
      state: smallProverState,
      rXY: smallProve1.rXY,
      initialRelation: smallProve0,
      copyQuotient: smallProve2,
      thetas: [runtime.Fr.zero, runtime.Fr.zero, runtime.Fr.one],
      kappa0: fr(9n),
      chi: fr(11n),
      zeta: fr(13n),
      kappa1: fr(15n),
      copyOpenings: smallCopyOpenings,
      commitmentEncoder: smallEncoder,
    });
    const smallProve4 = combineOpeningCommitments(smallCopyOpenings, smallIntegratedOpenings);
    assertEqual(smallProve4.commitments.Pi_X.byteLength, 144, 'prove4 Pi_X byte length');
    assertEqual(smallProve4.commitments.Pi_Y.byteLength, 144, 'prove4 Pi_Y byte length');
    assertEqual(smallProve4.commitments.M_X.byteLength, 144, 'prove4 M_X byte length');
    assertEqual(smallProve4.commitments.M_Y.byteLength, 144, 'prove4 M_Y byte length');
    assertEqual(smallProve4.commitments.N_X.byteLength, 144, 'prove4 N_X byte length');
    assertEqual(smallProve4.commitments.N_Y.byteLength, 144, 'prove4 N_Y byte length');
    const smallBindingSubcircuitInfos: ProverSubcircuitInfo[] = [
      {
        id: 0,
        name: 'synthetic-output-buffer',
        Nwires: 3,
        Nconsts: 0,
        Out_idx: [1, 1],
        In_idx: [2, 1],
        flattenMap: [6, 0, 7],
        bufferDirection: 'out',
      },
      {
        id: 1,
        name: 'synthetic-input-buffer',
        Nwires: 3,
        Nconsts: 0,
        Out_idx: [2, 1],
        In_idx: [1, 1],
        flattenMap: [8, 1, 9],
        bufferDirection: 'in',
      },
    ];
    const smallBindingPlacements = packPlacementVariables(runtime.Fr.byteLength, [
      { subcircuitId: 0, variables: [runtime.Fr.zero, runtime.Fr.zero, runtime.Fr.zero] },
      { subcircuitId: 1, variables: [runtime.Fr.zero, runtime.Fr.zero, runtime.Fr.zero] },
    ]);
    const smallBinding = await buildProverBinding(
      runtime,
      smallCrs,
      prove0Setup,
      smallBindingPlacements,
      smallBindingSubcircuitInfos,
      smallProverState.instance.aFreeX,
      smallProverState.mixer,
      smallEncoder,
    );
    const verifierProofArtifact = await decodeBinaryArtifactFile(
      await createVerifierProofArtifactFromProverOutput({
        runtime,
        binding: smallBinding,
        initialRelation: smallProve0,
        recursion: smallProve1,
        copyQuotient: smallProve2,
        evaluations: smallProve3,
        openings: smallProve4,
      }),
    );
    assertEqual(verifierProofArtifact.kind, BinaryArtifactFileKind.VerifierProof, 'prover output artifact kind');
    assertEqual(
      verifierProofArtifact.sourcePackageVersion,
      BACKEND_WASM_PACKAGE_VERSION,
      'prover output source package version',
    );
    const verifierProof = loadNamedArtifactPoints(verifierProofArtifact, VERIFIER_PROOF_V1_SPEC);
    assertEqual(verifierProofArtifact.sections[0]?.data.byteLength, 19 * 96, 'prover output proof.g1 byte length');
    assertEqual(verifierProofArtifact.sections[1]?.data.byteLength, 4 * 32, 'prover output proof.evals byte length');
    assertBytesEqual(
      verifierProof['proof0.U'],
      runtime.G1.toAffine(smallProve0.commitments.U),
      'proof0.U affine output',
    );
    assertBytesEqual(
      verifierProof['proof1.R'],
      runtime.G1.toAffine(smallProve1.commitment.R),
      'proof1.R affine output',
    );
    assertBytesEqual(
      verifierProof['proof4.N_X'],
      runtime.G1.toAffine(smallProve4.commitments.N_X),
      'proof4.N_X affine output',
    );
    assertBytesEqual(verifierProof['proof3.V_eval'], smallProve3.V_eval, 'proof3.V_eval output');
    const binaryArtifacts = {
      placementVariables: await decodeBinaryArtifactFile(
        await createBinaryArtifactFile({
          kind: BinaryArtifactFileKind.ProverPlacementVariables,
          sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
          sections: [
            {
              type: BinarySectionType.Placement,
              encoding: BinarySectionEncoding.Bytes,
              label: 'placement.subcircuit_ids',
              elementCount: placementVariables.subcircuitIds.length,
              elementByteLength: 4,
              data: encodeU32List([...placementVariables.subcircuitIds]),
            },
            {
              type: BinarySectionType.Placement,
              encoding: BinarySectionEncoding.Bytes,
              label: 'placement.variable_offsets',
              elementCount: placementVariables.variableOffsets.length,
              elementByteLength: 4,
              data: encodeU32List([...placementVariables.variableOffsets]),
            },
            {
              type: BinarySectionType.Placement,
              encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
              label: 'placement.variables',
              elementCount: placementVariables.variables.byteLength / runtime.Fr.byteLength,
              elementByteLength: runtime.Fr.byteLength,
              data: placementVariables.variables,
            },
          ],
        }),
      ),
      permutation: await decodeBinaryArtifactFile(
        await createBinaryArtifactFile({
          kind: BinaryArtifactFileKind.ProverPermutation,
          sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
          sections: [
            {
              type: BinarySectionType.Permutation,
              encoding: BinarySectionEncoding.Bytes,
              label: 'permutation.entries',
              elementCount: permutation.length,
              elementByteLength: 16,
              data: encodePermutationEntries(permutation),
            },
          ],
        }),
      ),
      instance: await decodeBinaryArtifactFile(
        await createBinaryArtifactFile({
          kind: BinaryArtifactFileKind.Instance,
          sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
          sections: [
            {
              type: BinarySectionType.Instance,
              encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
              label: 'instance.public',
              elementCount: 2,
              elementByteLength: runtime.Fr.byteLength,
              data: concatBytes([fr(13n), fr(17n)]),
            },
          ],
        }),
      ),
    };
    const binaryParts = loadProverRuntimeWitnessInputParts(runtime, binaryArtifacts);
    assertEqual(binaryParts.setup.l_free, GENERATED_SETUP_PARAMS.l_free, 'binary setup l_free');
    assertEqual(
      placementCount(binaryParts.placementVariables),
      placementCount(placementVariables),
      'binary placement count',
    );
    assertEqual(binaryParts.permutation.length, permutation.length, 'binary permutation count');
    assertEqual(binaryParts.permutation[0].X, permutation[0].X, 'binary permutation X');
    assertFieldEqual(placementVariableAt(binaryParts.placementVariables, 1, 2), fr(11n), 'binary placement variable');
    assertEqual(binaryParts.publicInstance.length, 2, 'binary public instance length');
    assertFieldEqual(binaryParts.publicInstance[1], fr(17n), 'binary public instance value');

    const placementVariablesBytes = await createBinaryArtifactFile({
      kind: BinaryArtifactFileKind.ProverPlacementVariables,
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      sections: [
        {
          type: BinarySectionType.Placement,
          encoding: BinarySectionEncoding.Bytes,
          label: 'placement.subcircuit_ids',
          elementCount: 0,
          elementByteLength: 4,
          data: new Uint8Array(),
        },
        {
          type: BinarySectionType.Placement,
          encoding: BinarySectionEncoding.Bytes,
          label: 'placement.variable_offsets',
          elementCount: 1,
          elementByteLength: 4,
          data: encodeU32List([0]),
        },
        {
          type: BinarySectionType.Placement,
          encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
          label: 'placement.variables',
          elementCount: 0,
          elementByteLength: runtime.Fr.byteLength,
          data: new Uint8Array(),
        },
      ],
    });
    const permutationBytes = await createBinaryArtifactFile({
      kind: BinaryArtifactFileKind.ProverPermutation,
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      sections: [
        {
          type: BinarySectionType.Permutation,
          encoding: BinarySectionEncoding.Bytes,
          label: 'permutation.entries',
          elementCount: 0,
          elementByteLength: 16,
          data: new Uint8Array(),
        },
      ],
    });
    const instanceBytes = await createBinaryArtifactFile({
      kind: BinaryArtifactFileKind.Instance,
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      sections: [
        {
          type: BinarySectionType.Instance,
          encoding: BinarySectionEncoding.FfjsFrMontgomeryLe32,
          label: 'instance.public',
          elementCount: 0,
          elementByteLength: runtime.Fr.byteLength,
          data: new Uint8Array(),
        },
      ],
    });
    const crsBytes = await createBinaryArtifactFile({
      kind: BinaryArtifactFileKind.ProverCrs,
      sourcePackageVersion: BACKEND_WASM_PACKAGE_VERSION,
      sections: [
        createRepeatedG1Section('sigma.g1', 6),
        createRepeatedG1Section('sigma1.xy-powers', 2),
        createRepeatedG1Section('sigma1.gamma-inv-o-inst', 1),
        createRepeatedG1Section('sigma1.eta-inv-li-o-inter-alpha4-kj', 1),
        createRepeatedG1Section('sigma1.delta-inv-li-o-prv', 1),
        createRepeatedG1Section('sigma1.delta-inv-alphak-xh-tx', 9),
        createRepeatedG1Section('sigma1.delta-inv-alpha4-xj-tx', 2),
        createRepeatedG1Section('sigma1.delta-inv-alphak-yi-ty', 12),
        {
          type: BinarySectionType.CrsG2,
          encoding: BinarySectionEncoding.FfjsG2Affine192,
          label: 'sigma.g2',
          elementCount: 10,
          elementByteLength: 192,
          data: concatBytes(Array.from({ length: 10 }, () => runtime.G2.generator)),
        },
      ],
    });
    const proverCrs = parseProverCrs(await decodeBinaryArtifactFile(crsBytes));
    assertEqual(proverCrs.sigma1.xyPowers.count, 2, 'prover CRS xy powers length');
    assertEqual(proverCrsG1PointAt(proverCrs.sigma1.xyPowers, 1).byteLength, 96, 'prover CRS xy powers point width');
    assertEqual(
      proverCrsG1PointRange(proverCrs.sigma1.xyPowers, 0, 2).byteLength,
      192,
      'prover CRS xy powers range width',
    );
    assertEqual(
      proverCrsG1PointAt(proverCrs.sigma1.xyPowers, 0).buffer,
      proverCrs.sigma1.xyPowers.data.buffer,
      'prover CRS point access backing buffer',
    );
    assertEqual(proverCrs.sigma2.y.byteLength, 192, 'prover CRS sigma2.y byte length');

    const encodedPolynomial = await encodePolynomialBufferWithSigma1(
      runtime,
      proverCrs,
      GENERATED_SETUP_PARAMS,
      BivariatePolynomialBuffer.fromCoeffs(runtime.Fr, [fr(3n), fr(5n)], 1, 2),
    );
    const expectedEncoding = runtime.G1.mulAffineScalar(runtime.G1.generator, fr(8n));
    if (!runtime.G1.eq(encodedPolynomial, expectedEncoding)) {
      throw new Error('prove0 sigma1 polynomial encoding mismatch.');
    }
  } finally {
    await runtime.terminate();
  }

  console.log('Checked prover witness polynomial generation');

  function fr(value: bigint): FieldElement {
    return runtime.Fr.fromBigInt(value);
  }

  async function assertRouEvals(
    polynomial: { toRouEvals(): Promise<FieldElement[] | Uint8Array> },
    expected: readonly bigint[],
    label: string,
  ): Promise<void> {
    const actual = await polynomial.toRouEvals();
    const actualLength = actual instanceof Uint8Array ? runtime.Fr.bufferElementCount(actual) : actual.length;
    assertEqual(actualLength, expected.length, `${label} eval count`);
    for (let index = 0; index < expected.length; index += 1) {
      const actualValue = actual instanceof Uint8Array ? runtime.Fr.readBufferElement(actual, index) : actual[index];
      assertFieldEqual(actualValue, fr(expected[index]), `${label}[${index}]`);
    }
  }

  function assertFieldEqual(actual: FieldElement, expected: FieldElement, label: string): void {
    if (!runtime.Fr.eq(actual, expected)) {
      throw new Error(`${label} mismatch: expected ${runtime.Fr.toHex(expected)}, got ${runtime.Fr.toHex(actual)}`);
    }
  }

  function createRepeatedG1Section(label: string, elementCount: number): BinarySectionInput {
    return {
      type: BinarySectionType.CrsG1,
      encoding: BinarySectionEncoding.FfjsG1Affine96,
      label,
      elementCount,
      elementByteLength: 96,
      data: concatBytes(Array.from({ length: elementCount }, () => runtime.G1.generator)),
    };
  }

  function createSyntheticProverCrs(setup: SetupParams, xyPowersLength: number) {
    const xyPowers = Array.from({ length: xyPowersLength }, () => runtime.G1.generator);
    return {
      G: runtime.G1.generator,
      H: runtime.G2.generator,
      lagrangeKL: runtime.G1.generator,
      sigma1: {
        x: runtime.G1.generator,
        y: runtime.G1.generator,
        delta: runtime.G1.generator,
        eta: runtime.G1.generator,
        xyPowers: g1Section(xyPowers),
        gammaInvOInst: g1Section(Array.from({ length: setup.l }, () => runtime.G1.generator)),
        etaInvLiOInterAlpha4Kj: g1Section(
          Array.from({ length: (setup.l_D - setup.l) * setup.s_max }, () => runtime.G1.generator),
        ),
        deltaInvLiOPrv: g1Section(
          Array.from({ length: (setup.m_D - setup.l_D) * setup.s_max }, () => runtime.G1.generator),
        ),
        deltaInvAlphakXhTx: g1Section(Array.from({ length: 9 }, () => runtime.G1.generator)),
        deltaInvAlpha4XjTx: g1Section(Array.from({ length: 2 }, () => runtime.G1.generator)),
        deltaInvAlphakYiTy: g1Section(Array.from({ length: 12 }, () => runtime.G1.generator)),
      },
      sigma2: {
        alpha: runtime.G2.generator,
        alpha2: runtime.G2.generator,
        alpha3: runtime.G2.generator,
        alpha4: runtime.G2.generator,
        gamma: runtime.G2.generator,
        delta: runtime.G2.generator,
        eta: runtime.G2.generator,
        x: runtime.G2.generator,
        y: runtime.G2.generator,
      },
    };
  }

  function monomialPolynomial(
    xIndex: number,
    yIndex: number,
    coefficient: FieldElement,
    xSize: number,
    ySize: number,
  ): BivariatePolynomialBuffer {
    const coefficients = Array.from({ length: xSize * ySize }, () => runtime.Fr.zero);
    coefficients[xIndex * ySize + yIndex] = coefficient;
    return BivariatePolynomialBuffer.fromCoeffs(runtime.Fr, coefficients, xSize, ySize);
  }

  function g1Section(points: readonly Uint8Array[]) {
    return {
      data: concatBytes(points),
      count: points.length,
      elementByteLength: 96,
    };
  }
}

function checkPublicWireLayout(): void {
  const setup: SetupParams = {
    l_free: 5,
    l: 6,
    l_user_out: 0,
    l_user: 0,
    l_D: 10,
    m_D: 12,
    n: 1,
    s_D: 3,
    s_max: 4,
  };
  const subcircuitInfos: ProverSubcircuitInfo[] = [
    {
      id: 0,
      name: 'output-buffer',
      Nwires: 3,
      Nconsts: 0,
      Out_idx: [1, 2],
      In_idx: [0, 0],
      flattenMap: [7, 0, 1],
      bufferDirection: 'out',
    },
    {
      id: 1,
      name: 'input-buffer',
      Nwires: 4,
      Nconsts: 0,
      Out_idx: [0, 0],
      In_idx: [1, 3],
      flattenMap: [8, 3, 4, 5],
      bufferDirection: 'in',
    },
    {
      id: 2,
      name: 'ordinary-subcircuit',
      Nwires: 1,
      Nconsts: 0,
      Out_idx: [0, 0],
      In_idx: [0, 0],
      flattenMap: [6],
    },
  ];
  const placements: ProverPlacementVariables = {
    subcircuitIds: Uint32Array.from([0, 1, 2]),
    variableOffsets: Uint32Array.from([0, 0, 0, 0]),
    variables: new Uint8Array(),
    fieldByteLength: 32,
  };

  const layout = PublicWireLayout.derive(setup, subcircuitInfos);
  layout.validateRuntimeBufferPlacements(placements);
  assertEqual(layout.sourceForPublicWire(2), undefined, 'public free padding source');
  assertEqual(layout.sourceForPublicWire(5)?.subcircuitId, 1, 'post-free public buffer source');
  assertEqual(layout.placementPhaseForSubcircuit(0), 0, 'output buffer placement phase');
  assertEqual(layout.placementPhaseForSubcircuit(1), 1, 'input buffer placement phase');
  assertEqual(layout.placementPhaseForPublicWire(5), 1, 'public wire placement phase');
  assertEqual(countOMidVariables(setup, placements, subcircuitInfos), 3, 'generic O_mid count');
  assertEqual(countOPrvVariables(setup, placements, subcircuitInfos), 0, 'generic O_prv count');

  const invalidPlacements: ProverPlacementVariables = {
    ...placements,
    subcircuitIds: Uint32Array.from([1, 0, 2]),
  };
  assertThrows(
    () => layout.validateRuntimeBufferPlacements(invalidPlacements),
    'runtime buffer placement phase validation',
  );

  const duplicateBufferPlacements: ProverPlacementVariables = {
    ...placements,
    subcircuitIds: Uint32Array.from([0, 0, 1, 2]),
    variableOffsets: Uint32Array.from([0, 0, 0, 0, 0]),
  };
  assertThrows(
    () => layout.validateRuntimeBufferPlacements(duplicateBufferPlacements),
    'duplicate runtime buffer placement validation',
  );

  const gappedBufferInfos: ProverSubcircuitInfo[] = [
    {
      id: 0,
      name: 'output-buffer',
      Nwires: 2,
      Nconsts: 0,
      Out_idx: [1, 1],
      In_idx: [0, 0],
      flattenMap: [2, 0],
      bufferDirection: 'out',
    },
    {
      id: 1,
      name: 'ordinary-subcircuit',
      Nwires: 1,
      Nconsts: 0,
      Out_idx: [0, 0],
      In_idx: [0, 0],
      flattenMap: [4],
    },
    {
      id: 2,
      name: 'input-buffer',
      Nwires: 2,
      Nconsts: 0,
      Out_idx: [0, 0],
      In_idx: [1, 1],
      flattenMap: [3, 1],
      bufferDirection: 'in',
    },
  ];
  assertThrows(() => PublicWireLayout.derive(setup, gappedBufferInfos), 'gapped buffer IDs must be rejected');
}

function assertThrows(action: () => void, label: string): void {
  try {
    action();
  } catch {
    return;
  }
  throw new Error(`${label} did not reject.`);
}

function packSparseR1cs(
  field: FieldRuntime,
  entries: readonly ProverSparseSubcircuitR1cs[],
  rowCount: number,
): readonly ProverPackedSparseSubcircuitR1cs[] {
  return entries.map(entry => ({
    subcircuitId: entry.subcircuitId,
    A: packSparseMatrix(field, entry.A, rowCount),
    B: packSparseMatrix(field, entry.B, rowCount),
    C: packSparseMatrix(field, entry.C, rowCount),
  }));
}

function packSparseMatrix(field: FieldRuntime, matrix: ProverSparseMatrix, rowCount: number): ProverPackedSparseMatrix {
  const rowOffsets = [0];
  const columns: number[] = [];
  const coefficients: Uint8Array[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    for (const entry of matrix.sparseRows[row] ?? []) {
      columns.push(entry.column);
      coefficients.push(entry.coefficient);
    }
    rowOffsets.push(columns.length);
  }

  for (const coefficient of coefficients) {
    if (coefficient.byteLength !== field.byteLength) {
      throw new Error('Synthetic sparse R1CS coefficient has an invalid field-element length.');
    }
  }

  return {
    activeWires: matrix.activeWires,
    rowOffsets: encodeU32List(rowOffsets),
    columns: encodeU32List(columns),
    coefficients: concatBytes(coefficients),
    rowCount,
  };
}

function packPlacementVariables(
  fieldByteLength: number,
  placements: readonly {
    readonly subcircuitId: number;
    readonly variables: readonly FieldElement[];
  }[],
): ProverPlacementVariables {
  const subcircuitIds = Uint32Array.from(placements, placement => placement.subcircuitId);
  const variableOffsets = new Uint32Array(placements.length + 1);
  const variables: FieldElement[] = [];
  for (let index = 0; index < placements.length; index += 1) {
    variables.push(...placements[index].variables);
    variableOffsets[index + 1] = variables.length;
  }

  return {
    subcircuitIds,
    variableOffsets,
    variables: concatBytes(variables),
    fieldByteLength,
  };
}

function encodeU32List(values: readonly number[]): Uint8Array {
  const output = new Uint8Array(values.length * 4);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  for (let index = 0; index < values.length; index += 1) {
    view.setUint32(index * 4, values[index], true);
  }

  return output;
}

function encodePermutationEntries(entries: readonly ProverPermutationEntry[]): Uint8Array {
  const output = new Uint8Array(entries.length * 16);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  for (let index = 0; index < entries.length; index += 1) {
    const offset = index * 16;
    const entry = entries[index];
    view.setUint32(offset, entry.row, true);
    view.setUint32(offset + 4, entry.col, true);
    view.setUint32(offset + 8, entry.X, true);
    view.setUint32(offset + 12, entry.Y, true);
  }

  return output;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
