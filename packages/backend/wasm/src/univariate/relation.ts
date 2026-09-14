import type { SetupParams } from "../artifacts/setup/setup-params.js";
import type { FieldElement, FieldRuntime } from "../runtime/field/field-types.js";
import { arithmeticIndex, connectionIndex, type UnivariateDomainShape } from "./domain.js";

/** Packed sparse R1CS rows used by the U6/U8 relation builder. */
export interface UnivariateSparseMatrix {
  readonly activeWires: readonly number[];
  readonly rowOffsets: Uint8Array;
  readonly columns: Uint8Array;
  readonly coefficients: Uint8Array;
  readonly rowCount: number;
}

/** Fixed library data required for one selected subcircuit. */
export interface UnivariateSubcircuit {
  readonly id: number;
  readonly flattenMap: readonly number[];
  readonly A: UnivariateSparseMatrix;
  readonly B: UnivariateSparseMatrix;
  readonly C: UnivariateSparseMatrix;
}

/** The local assignment attached to one active placement slot. */
export interface UnivariateSlotWitness {
  readonly subcircuitId: number;
  readonly values: Uint8Array;
}

/** The sparse `permutation.json` coordinate convention. */
export interface UnivariatePermutationEntry {
  readonly row: number;
  readonly col: number;
  readonly X: number;
  readonly Y: number;
}

/** A polynomial together with the domain values from which it was interpolated. */
export interface DenseDomainPolynomial {
  readonly evaluations: Uint8Array;
  readonly coefficients: Uint8Array;
}

/** U8's four assignment maps. */
export interface WitnessMaps {
  readonly uA: DenseDomainPolynomial;
  readonly vA: DenseDomainPolynomial;
  readonly wA: DenseDomainPolynomial;
  readonly bC: DenseDomainPolynomial;
}

export type R1csMatrixName = "A" | "B" | "C";

/** Builds one U6 arithmetic lift for a tagged local wire. */
export async function buildArithmeticWireLift(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  placementIndex: number,
  subcircuit: UnivariateSubcircuit,
  localWireIndex: number,
  matrixName: R1csMatrixName,
): Promise<DenseDomainPolynomial> {
  if (!Number.isSafeInteger(placementIndex) || placementIndex < 0 || placementIndex >= setup.s_max) {
    throw new Error(`Placement index ${placementIndex} is outside the placement capacity.`);
  }
  if (!Number.isSafeInteger(localWireIndex) || localWireIndex < 0 || localWireIndex >= subcircuit.flattenMap.length) {
    throw new Error(`Subcircuit ${subcircuit.id} local wire ${localWireIndex} is outside its wire range.`);
  }
  const matrix = subcircuit[matrixName];
  if (matrix.rowCount > setup.n) {
    throw new Error(`Subcircuit ${subcircuit.id} ${matrixName} rows exceed n.`);
  }
  const activeValues = field.createZeroBuffer(matrix.activeWires.length);
  for (let index = 0; index < matrix.activeWires.length; index += 1) {
    if (matrix.activeWires[index] === localWireIndex) {
      field.writeBufferElement(activeValues, index, field.one);
    }
  }
  const rows = await field.sparseRowDotBuffer(
    matrix.rowOffsets,
    matrix.columns,
    matrix.coefficients,
    activeValues,
    matrix.rowCount,
  );
  const evaluations = field.createZeroBuffer(domain.arithmeticSize);
  for (let row = 0; row < matrix.rowCount; row += 1) {
    field.writeBufferElement(
      evaluations,
      arithmeticIndex(domain, setup, placementIndex, subcircuit.id, row),
      field.readBufferElement(rows, row),
    );
  }
  return { evaluations, coefficients: await field.ifftBuffer(evaluations) };
}

/** Builds one U7 connection lift, including the required zero polynomial. */
export async function buildConnectionWireLift(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  placementIndex: number,
  subcircuit: UnivariateSubcircuit,
  localWireIndex: number,
): Promise<DenseDomainPolynomial> {
  if (!Number.isSafeInteger(placementIndex) || placementIndex < 0 || placementIndex >= setup.s_max) {
    throw new Error(`Placement index ${placementIndex} is outside the placement capacity.`);
  }
  const globalIndex = subcircuit.flattenMap[localWireIndex];
  if (!Number.isSafeInteger(globalIndex) || globalIndex < 0) {
    throw new Error(`Subcircuit ${subcircuit.id} local wire ${localWireIndex} is outside its wire range.`);
  }
  const evaluations = field.createZeroBuffer(domain.connectionSize);
  if (globalIndex >= setup.l && globalIndex < setup.l_D) {
    field.writeBufferElement(
      evaluations,
      connectionIndex(setup, placementIndex, globalIndex - setup.l),
      field.one,
    );
  }
  return { evaluations, coefficients: await field.ifftBuffer(evaluations) };
}

/**
 * Builds U8 directly in the U1 and U4 flat evaluation domains. The caller
 * supplies one selector-capacity-length witness array, so inactive slots do
 * not inherit the compact witness-list position used by the legacy protocol.
 */
export async function buildWitnessMaps(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  selector: readonly (number | null)[],
  witnessesBySlot: readonly (UnivariateSlotWitness | null)[],
  subcircuits: readonly UnivariateSubcircuit[],
): Promise<WitnessMaps> {
  assertRelationInputs(domain, setup, selector, witnessesBySlot, subcircuits);
  const uEvaluations = field.createZeroBuffer(domain.arithmeticSize);
  const vEvaluations = field.createZeroBuffer(domain.arithmeticSize);
  const wEvaluations = field.createZeroBuffer(domain.arithmeticSize);
  const bEvaluations = field.createZeroBuffer(domain.connectionSize);

  for (let placementIndex = 0; placementIndex < setup.s_max; placementIndex += 1) {
    const subcircuitId = selector[placementIndex];
    const witness = witnessesBySlot[placementIndex];
    if (subcircuitId === null && witness === null) {
      continue;
    }
    if (subcircuitId === null || witness === null || witness.subcircuitId !== subcircuitId) {
      throw new Error(`Selector slot ${placementIndex} and witness slot disagree.`);
    }
    if (subcircuitId < 0 || subcircuitId >= setup.s_D) {
      throw new Error(`Selector subcircuit id ${subcircuitId} is outside the library range.`);
    }
    const subcircuit = subcircuits[subcircuitId];
    if (subcircuit === undefined || subcircuit.id !== subcircuitId) {
      throw new Error(`Missing subcircuit metadata for selected id ${subcircuitId}.`);
    }
    const variableCount = field.bufferElementCount(witness.values);
    if (subcircuit.flattenMap.length !== variableCount) {
      throw new Error(`Subcircuit ${subcircuitId} flattenMap does not match its witness width.`);
    }

    await writeArithmeticMatrix(
      field,
      uEvaluations,
      domain,
      setup,
      placementIndex,
      subcircuitId,
      subcircuit.A,
      witness.values,
      "A",
    );
    await writeArithmeticMatrix(
      field,
      vEvaluations,
      domain,
      setup,
      placementIndex,
      subcircuitId,
      subcircuit.B,
      witness.values,
      "B",
    );
    await writeArithmeticMatrix(
      field,
      wEvaluations,
      domain,
      setup,
      placementIndex,
      subcircuitId,
      subcircuit.C,
      witness.values,
      "C",
    );
    writeConnectionAssignment(
      field,
      bEvaluations,
      setup,
      placementIndex,
      subcircuit,
      witness.values,
    );
  }

  const [uCoefficients, vCoefficients, wCoefficients, bCoefficients] = await Promise.all([
    field.ifftBuffer(uEvaluations),
    field.ifftBuffer(vEvaluations),
    field.ifftBuffer(wEvaluations),
    field.ifftBuffer(bEvaluations),
  ]);
  return {
    uA: { evaluations: uEvaluations, coefficients: uCoefficients },
    vA: { evaluations: vEvaluations, coefficients: vCoefficients },
    wA: { evaluations: wEvaluations, coefficients: wCoefficients },
    bC: { evaluations: bEvaluations, coefficients: bCoefficients },
  };
}

/**
 * Builds U12. Omitted sparse entries preserve the identity mapping, which is
 * the physical `permutation.json` convention.
 */
export async function buildConnectionPermutationPolynomial(
  field: FieldRuntime,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  selector: readonly (number | null)[],
  permutation: readonly UnivariatePermutationEntry[],
): Promise<DenseDomainPolynomial> {
  if (selector.length !== setup.s_max) {
    throw new Error(`Selector capacity is ${selector.length}, expected ${setup.s_max}.`);
  }
  for (const [placementIndex, subcircuitId] of selector.entries()) {
    if (subcircuitId !== null && (subcircuitId < 0 || subcircuitId >= setup.s_D)) {
      throw new Error(`Selector placement ${placementIndex} subcircuit index is outside its admitted range.`);
    }
  }
  const mI = interfaceWireCount(setup);
  const targets = new Uint32Array(domain.connectionSize);
  const explicitlyMapped = new Uint8Array(domain.connectionSize);
  for (let source = 0; source < domain.connectionSize; source += 1) {
    targets[source] = source;
  }

  for (const entry of permutation) {
    assertPermutationCoordinate(entry.row, entry.col, mI, setup.s_max);
    assertPermutationCoordinate(entry.X, entry.Y, mI, setup.s_max);
    if (selector[entry.col] === null) {
      throw new Error(`Permutation explicitly maps inactive placement slot ${entry.col}.`);
    }
    if (selector[entry.Y] === null) {
      throw new Error(`Permutation explicitly maps inactive placement slot ${entry.Y}.`);
    }
    const source = connectionIndex(setup, entry.col, entry.row);
    const target = connectionIndex(setup, entry.Y, entry.X);
    if (explicitlyMapped[source] !== 0) {
      throw new Error(`Permutation has duplicate source coordinate ${source}.`);
    }
    explicitlyMapped[source] = 1;
    targets[source] = target;
  }

  const seenTargets = new Uint8Array(domain.connectionSize);
  for (const target of targets) {
    if (seenTargets[target] !== 0) {
      throw new Error(`Permutation maps more than one source to coordinate ${target}.`);
    }
    seenTargets[target] = 1;
  }

  const evaluations = field.createZeroBuffer(domain.connectionSize);
  let identityPoint = field.one;
  for (let source = 0; source < domain.connectionSize; source += 1) {
    field.writeBufferElement(evaluations, source, identityPoint);
    identityPoint = field.mul(identityPoint, domain.connectionRoot);
  }
  for (let source = 0; source < domain.connectionSize; source += 1) {
    if (explicitlyMapped[source] !== 0) {
      field.writeBufferElement(
        evaluations,
        source,
        field.pow(domain.connectionRoot, targets[source]),
      );
    }
  }
  return { evaluations, coefficients: await field.ifftBuffer(evaluations) };
}

/** Builds U13 in coefficient form. */
export async function buildConnectionCopyFactors(
  field: FieldRuntime,
  bC: DenseDomainPolynomial,
  sC: DenseDomainPolynomial,
  beta: FieldElement,
  gammaC: FieldElement,
): Promise<readonly [Uint8Array, Uint8Array]> {
  if (bC.coefficients.byteLength !== sC.coefficients.byteLength || field.bufferElementCount(bC.coefficients) < 2) {
    throw new Error("Connection factors require matching coefficient buffers of length at least two.");
  }
  const fC = await field.batchAddScaledBuffer(bC.coefficients, sC.coefficients, beta);
  const gC = field.cloneBuffer(bC.coefficients);
  field.writeBufferElement(fC, 0, field.add(field.readBufferElement(fC, 0), gammaC));
  field.writeBufferElement(gC, 0, field.add(field.readBufferElement(gC, 0), gammaC));
  field.writeBufferElement(gC, 1, field.add(field.readBufferElement(gC, 1), beta));
  return [fC, gC];
}

async function writeArithmeticMatrix(
  field: FieldRuntime,
  evaluations: Uint8Array,
  domain: UnivariateDomainShape,
  setup: SetupParams,
  placementIndex: number,
  subcircuitId: number,
  matrix: UnivariateSparseMatrix,
  values: Uint8Array,
  matrixName: string,
): Promise<void> {
  if (matrix.rowCount > setup.n) {
    throw new Error(`Subcircuit ${subcircuitId} ${matrixName} rows exceed n.`);
  }
  const activeValues = field.createZeroBuffer(matrix.activeWires.length);
  const valueCount = field.bufferElementCount(values);
  for (let index = 0; index < matrix.activeWires.length; index += 1) {
    const localWire = matrix.activeWires[index];
    if (!Number.isSafeInteger(localWire) || localWire < 0 || localWire >= valueCount) {
      throw new Error(`Subcircuit ${subcircuitId} ${matrixName} references local wire ${localWire} outside its witness.`);
    }
    field.writeBufferElement(activeValues, index, field.readBufferElement(values, localWire));
  }
  const rows = await field.sparseRowDotBuffer(
    matrix.rowOffsets,
    matrix.columns,
    matrix.coefficients,
    activeValues,
    matrix.rowCount,
  );
  for (let row = 0; row < matrix.rowCount; row += 1) {
    field.writeBufferElement(
      evaluations,
      arithmeticIndex(domain, setup, placementIndex, subcircuitId, row),
      field.readBufferElement(rows, row),
    );
  }
}

function writeConnectionAssignment(
  field: FieldRuntime,
  evaluations: Uint8Array,
  setup: SetupParams,
  placementIndex: number,
  subcircuit: UnivariateSubcircuit,
  values: Uint8Array,
): void {
  const mI = interfaceWireCount(setup);
  const seenInterface = new Uint8Array(mI);
  for (const [localIndex, globalIndex] of subcircuit.flattenMap.entries()) {
    if (globalIndex < setup.l || globalIndex >= setup.l_D) {
      continue;
    }
    const interfaceIndex = globalIndex - setup.l;
    if (seenInterface[interfaceIndex] !== 0) {
      throw new Error(`Subcircuit ${subcircuit.id} maps multiple local wires to interface coordinate ${interfaceIndex}.`);
    }
    seenInterface[interfaceIndex] = 1;
    field.writeBufferElement(
      evaluations,
      connectionIndex(setup, placementIndex, interfaceIndex),
      field.readBufferElement(values, localIndex),
    );
  }
}

function assertRelationInputs(
  domain: UnivariateDomainShape,
  setup: SetupParams,
  selector: readonly (number | null)[],
  witnessesBySlot: readonly (UnivariateSlotWitness | null)[],
  subcircuits: readonly UnivariateSubcircuit[],
): void {
  interfaceWireCount(setup);
  if (selector.length !== setup.s_max || witnessesBySlot.length !== setup.s_max) {
    throw new Error("Selector and slot-witness arrays must have exactly s_max entries.");
  }
  if (subcircuits.length !== setup.s_D) {
    throw new Error(`Subcircuit catalog has ${subcircuits.length} entries, expected ${setup.s_D}.`);
  }
  if (domain.arithmeticSize < 1 || domain.connectionSize < 1) {
    throw new Error("Univariate domains must be nonempty.");
  }
}

function interfaceWireCount(setup: SetupParams): number {
  const mI = setup.l_D - setup.l;
  if (!isPowerOfTwo(mI)) {
    throw new Error("m_I = l_D - l must be a nonzero power of two.");
  }
  return mI;
}

function isPowerOfTwo(value: number): boolean {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return false;
  }
  while (value > 1) {
    if (value % 2 !== 0) {
      return false;
    }
    value /= 2;
  }
  return true;
}

function assertPermutationCoordinate(row: number, col: number, mI: number, s: number): void {
  if (!Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || row >= mI || col < 0 || col >= s) {
    throw new Error(`Permutation coordinate (${row}, ${col}) is outside the connection domain.`);
  }
}
