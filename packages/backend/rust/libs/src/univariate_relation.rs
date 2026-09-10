//! Sparse univariate selector polynomials for the migrated protocol.
//!
//! These polynomials are represented by the nonzero coefficient stride implied
//! by U2 and U5. They never expand a selector into an `N_A` or `N_C` dense
//! vector.

use crate::frontend_artifacts::{Permutation, SetupParams};
use crate::ntt_domain::init_ntt_domain_for_size;
use crate::univariate_crs::UnivariateCrsShape;
use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt::{self, NTTConfig, NTTDir};
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::errors::eIcicleError;
use icicle_runtime::memory::HostSlice;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UnivariateRelationError {
    #[error("{name} must be a power of two for the selected direct NTT provider")]
    TransformDomainNotPowerOfTwo { name: &'static str },
    #[error("selector capacity is {actual}, expected {expected}")]
    SelectorCapacity { actual: usize, expected: usize },
    #[error("placement index {value} is outside the placement capacity")]
    PlacementIndex { value: usize },
    #[error("subcircuit ID {value} is outside the admitted range")]
    SubcircuitId { value: usize },
    #[error("m_I = l_D - l must be a nonzero power of two")]
    InterfaceWireCount,
    #[error("subcircuit catalog has {actual} entries, expected {expected}")]
    SubcircuitCatalog { actual: usize, expected: usize },
    #[error("selector slot {placement_index} and witness slot disagree")]
    SlotWitnessMismatch { placement_index: usize },
    #[error("subcircuit {subcircuit_id} has {actual} {matrix} rows, exceeding n = {expected}")]
    MatrixRows {
        subcircuit_id: usize,
        matrix: &'static str,
        actual: usize,
        expected: usize,
    },
    #[error("subcircuit {subcircuit_id} references local wire {wire_index} outside its witness")]
    LocalWireIndex {
        subcircuit_id: usize,
        wire_index: usize,
    },
    #[error("subcircuit {subcircuit_id} flatten map has {actual} entries, expected {expected}")]
    FlattenMapLength {
        subcircuit_id: usize,
        actual: usize,
        expected: usize,
    },
    #[error(
        "subcircuit {subcircuit_id} maps two local wires to interface coordinate {interface_index}"
    )]
    DuplicateInterfaceCoordinate {
        subcircuit_id: usize,
        interface_index: usize,
    },
    #[error("permutation coordinate ({row}, {col}) is outside the connection domain")]
    PermutationCoordinate { row: usize, col: usize },
    #[error("permutation explicitly maps inactive placement slot {placement_index}")]
    PermutationInactivePlacement { placement_index: usize },
    #[error("permutation maps more than one source to connection coordinate {index}")]
    PermutationNotBijective { index: usize },
    #[error("ICICLE NTT failed: {0:?}")]
    Ntt(eIcicleError),
    #[error("{name} is too large to convert into the scalar field")]
    DomainSizeTooLarge { name: &'static str },
    #[error("evaluation point belongs to the {domain} domain")]
    EvaluationPointInsideDomain { domain: &'static str },
}

/// A polynomial containing only powers whose exponents are multiples of
/// `stride`: `sum_q coefficients[q] * Z^(stride * q)`.
#[derive(Clone, Debug, PartialEq)]
pub struct StridedPolynomial {
    pub stride: usize,
    pub coefficients: Box<[ScalarField]>,
}

/// A degree-`< domain_size` polynomial represented both by its canonical
/// domain evaluations and by its interpolated coefficients.
///
/// The evaluation buffer is the only large temporary required to build U8 or
/// U12. Callers may discard it after downstream relation construction.
#[derive(Clone, Debug, PartialEq)]
pub struct DenseDomainPolynomial {
    pub evaluations: Box<[ScalarField]>,
    pub coefficients: Box<[ScalarField]>,
}

/// The sparse R1CS data needed by U6 and U8 for one fixed library subcircuit.
/// Every row stores compact-column indices. `*_active_wires` resolves such an
/// index to the local wire index without expanding the R1CS matrix.
pub struct UnivariateSubcircuit<'a> {
    pub id: usize,
    pub flatten_map: &'a [usize],
    pub a_active_wires: &'a [usize],
    pub b_active_wires: &'a [usize],
    pub c_active_wires: &'a [usize],
    pub a_rows: &'a [Vec<(usize, ScalarField)>],
    pub b_rows: &'a [Vec<(usize, ScalarField)>],
    pub c_rows: &'a [Vec<(usize, ScalarField)>],
}

/// The local assignment for one active selector slot.
pub struct SlotWitness<'a> {
    pub subcircuit_id: usize,
    pub values: &'a [ScalarField],
}

/// U8's four interpolated assignment maps.
#[derive(Clone, Debug, PartialEq)]
pub struct WitnessMaps {
    pub u_a: DenseDomainPolynomial,
    pub v_a: DenseDomainPolynomial,
    pub w_a: DenseDomainPolynomial,
    pub b_c: DenseDomainPolynomial,
}

/// Selects one R1CS column for a U6 arithmetic lift.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum R1csMatrix {
    A,
    B,
    C,
}

impl StridedPolynomial {
    pub fn evaluate(&self, point: ScalarField) -> ScalarField {
        let base = point.pow(self.stride);
        self.coefficients
            .iter()
            .rev()
            .fold(ScalarField::zero(), |accumulator, coefficient| {
                accumulator * base + *coefficient
            })
    }
}

/// Builds the U2 selector `C^A_(i,k)` by interpolating one value on the
/// `s*t` coset-label domain. The returned polynomial has exactly `s*t`
/// coefficients rather than an `N_A`-element dense representation.
pub fn arithmetic_coset_selector(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit_id: usize,
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    if subcircuit_id >= shape.subcircuit_capacity {
        return Err(UnivariateRelationError::SubcircuitId {
            value: subcircuit_id,
        });
    }
    let label_count = arithmetic_label_count(shape, setup)?;
    let mut evaluations = vec![ScalarField::zero(); label_count];
    evaluations[placement_index + setup.s_max * subcircuit_id] = ScalarField::one();
    interpolate_selector(evaluations, setup.n)
}

/// Builds the U9a polynomial `S_kappa` directly from a capacity-length
/// selector. Only real library IDs are admitted; the `t - s_D` padding range
/// is never a legal placement value.
pub fn placement_selector_polynomial(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    selector: &[Option<usize>],
) -> Result<StridedPolynomial, UnivariateRelationError> {
    validate_placement_selector(selector, setup)?;
    let label_count = arithmetic_label_count(shape, setup)?;
    let mut evaluations = vec![ScalarField::zero(); label_count];
    for (placement_index, subcircuit_id) in selector.iter().enumerate() {
        if let Some(subcircuit_id) = subcircuit_id {
            evaluations[placement_index + setup.s_max * *subcircuit_id] = ScalarField::one();
        }
    }
    interpolate_selector(evaluations, setup.n)
}

/// Builds the U5 slot selector `C^C_i` over the `s` connection cosets.
pub fn connection_coset_selector(
    setup: &SetupParams,
    placement_index: usize,
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    let interface_wire_count = interface_wire_count(setup)?;
    let mut evaluations = vec![ScalarField::zero(); setup.s_max];
    evaluations[placement_index] = ScalarField::one();
    interpolate_selector(evaluations, interface_wire_count)
}

/// Builds one U6 lift for a tagged local wire without materializing any
/// bivariate QAP object. The result is supported on exactly one arithmetic
/// `(placement_index, subcircuit_id)` coset.
pub fn arithmetic_wire_lift(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
    matrix: R1csMatrix,
) -> Result<DenseDomainPolynomial, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    if subcircuit.id >= setup.s_D || local_wire_index >= subcircuit.flatten_map.len() {
        return Err(UnivariateRelationError::LocalWireIndex {
            subcircuit_id: subcircuit.id,
            wire_index: local_wire_index,
        });
    }
    let (active_wires, rows, name) = match matrix {
        R1csMatrix::A => (subcircuit.a_active_wires, subcircuit.a_rows, "A"),
        R1csMatrix::B => (subcircuit.b_active_wires, subcircuit.b_rows, "B"),
        R1csMatrix::C => (subcircuit.c_active_wires, subcircuit.c_rows, "C"),
    };
    if rows.len() > setup.n {
        return Err(UnivariateRelationError::MatrixRows {
            subcircuit_id: subcircuit.id,
            matrix: name,
            actual: rows.len(),
            expected: setup.n,
        });
    }
    let mut evaluations = vec![ScalarField::zero(); shape.arithmetic_domain_size];
    for (row_index, row) in rows.iter().enumerate() {
        let coefficient =
            row.iter()
                .try_fold(ScalarField::zero(), |sum, (compact_index, value)| {
                    let active_wire = active_wires.get(*compact_index).ok_or(
                        UnivariateRelationError::LocalWireIndex {
                            subcircuit_id: subcircuit.id,
                            wire_index: *compact_index,
                        },
                    )?;
                    Ok::<_, UnivariateRelationError>(if *active_wire == local_wire_index {
                        sum + *value
                    } else {
                        sum
                    })
                })?;
        let index = shape
            .arithmetic_index(placement_index, row_index, setup)
            .map_err(|_| UnivariateRelationError::PlacementIndex {
                value: placement_index,
            })?;
        evaluations[index] = coefficient;
    }
    interpolate_dense(evaluations)
}

/// Builds one U7 lift. A non-interface tagged wire has the required zero
/// polynomial; an interface wire is one at its canonical connection position.
pub fn connection_wire_lift(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
) -> Result<DenseDomainPolynomial, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    let global_index = *subcircuit.flatten_map.get(local_wire_index).ok_or(
        UnivariateRelationError::LocalWireIndex {
            subcircuit_id: subcircuit.id,
            wire_index: local_wire_index,
        },
    )?;
    let mut evaluations = vec![ScalarField::zero(); shape.connection_domain_size];
    if global_index >= setup.l && global_index < setup.l_D {
        let interface_index = global_index - setup.l;
        let index = shape
            .connection_index(placement_index, interface_index, setup)
            .map_err(|_| UnivariateRelationError::PlacementIndex {
                value: placement_index,
            })?;
        evaluations[index] = ScalarField::one();
    }
    interpolate_dense(evaluations)
}

/// Evaluates the three arithmetic components of U19 for one tagged local
/// wire at a point outside `D_A`.
///
/// Trusted setup needs these values only at `tau`.  Materializing an
/// `N_A`-element evaluation vector and running an inverse NTT for every U20
/// query would turn CRS construction into a per-wire dense transform.  This
/// evaluates the sparse R1CS rows directly and applies the canonical U1
/// Lagrange basis at the requested coordinate instead.
pub fn arithmetic_wire_lifts_at(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
    point: ScalarField,
) -> Result<[ScalarField; 3], UnivariateRelationError> {
    if point.pow(shape.arithmetic_domain_size) == ScalarField::one() {
        return Err(UnivariateRelationError::EvaluationPointInsideDomain {
            domain: "arithmetic",
        });
    }

    Ok([
        arithmetic_wire_lift_at(
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
            R1csMatrix::A,
            point,
        )?,
        arithmetic_wire_lift_at(
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
            R1csMatrix::B,
            point,
        )?,
        arithmetic_wire_lift_at(
            shape,
            setup,
            placement_index,
            subcircuit,
            local_wire_index,
            R1csMatrix::C,
            point,
        )?,
    ])
}

/// Evaluates U7 for one tagged local wire at a point outside `D_C`.
/// A non-interface wire has the required zero connection lift.
pub fn connection_wire_lift_at(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
    point: ScalarField,
) -> Result<ScalarField, UnivariateRelationError> {
    if point.pow(shape.connection_domain_size) == ScalarField::one() {
        return Err(UnivariateRelationError::EvaluationPointInsideDomain {
            domain: "connection",
        });
    }
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    let global_index = *subcircuit.flatten_map.get(local_wire_index).ok_or(
        UnivariateRelationError::LocalWireIndex {
            subcircuit_id: subcircuit.id,
            wire_index: local_wire_index,
        },
    )?;
    if global_index < setup.l || global_index >= setup.l_D {
        return Ok(ScalarField::zero());
    }
    let coordinate = shape
        .connection_index(placement_index, global_index - setup.l, setup)
        .map_err(|_| UnivariateRelationError::PlacementIndex {
            value: placement_index,
        })?;
    lagrange_basis_at(
        point,
        shape.connection_domain_size,
        shape.connection_root,
        coordinate,
        "connection",
    )
}

fn arithmetic_wire_lift_at(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    local_wire_index: usize,
    matrix: R1csMatrix,
    point: ScalarField,
) -> Result<ScalarField, UnivariateRelationError> {
    if placement_index >= setup.s_max {
        return Err(UnivariateRelationError::PlacementIndex {
            value: placement_index,
        });
    }
    if subcircuit.id >= setup.s_D || local_wire_index >= subcircuit.flatten_map.len() {
        return Err(UnivariateRelationError::LocalWireIndex {
            subcircuit_id: subcircuit.id,
            wire_index: local_wire_index,
        });
    }
    let (active_wires, rows, name) = match matrix {
        R1csMatrix::A => (subcircuit.a_active_wires, subcircuit.a_rows, "A"),
        R1csMatrix::B => (subcircuit.b_active_wires, subcircuit.b_rows, "B"),
        R1csMatrix::C => (subcircuit.c_active_wires, subcircuit.c_rows, "C"),
    };
    if rows.len() > setup.n {
        return Err(UnivariateRelationError::MatrixRows {
            subcircuit_id: subcircuit.id,
            matrix: name,
            actual: rows.len(),
            expected: setup.n,
        });
    }

    rows.iter()
        .enumerate()
        .try_fold(ScalarField::zero(), |sum, (row_index, row)| {
            let coefficient =
                row.iter()
                    .try_fold(ScalarField::zero(), |row_sum, (compact_index, value)| {
                        let active_wire = active_wires.get(*compact_index).ok_or(
                            UnivariateRelationError::LocalWireIndex {
                                subcircuit_id: subcircuit.id,
                                wire_index: *compact_index,
                            },
                        )?;
                        Ok::<_, UnivariateRelationError>(if *active_wire == local_wire_index {
                            row_sum + *value
                        } else {
                            row_sum
                        })
                    })?;
            if coefficient == ScalarField::zero() {
                return Ok(sum);
            }
            let coordinate = shape
                .arithmetic_index(placement_index, row_index, setup)
                .map_err(|_| UnivariateRelationError::PlacementIndex {
                    value: placement_index,
                })?;
            Ok(sum
                + coefficient
                    * lagrange_basis_at(
                        point,
                        shape.arithmetic_domain_size,
                        shape.arithmetic_root,
                        coordinate,
                        "arithmetic",
                    )?)
        })
}

fn lagrange_basis_at(
    point: ScalarField,
    domain_size: usize,
    root: ScalarField,
    coordinate: usize,
    domain: &'static str,
) -> Result<ScalarField, UnivariateRelationError> {
    if coordinate >= domain_size {
        return Err(UnivariateRelationError::PlacementIndex { value: coordinate });
    }
    let root_at_coordinate = root.pow(coordinate);
    let denominator = point - root_at_coordinate;
    if denominator == ScalarField::zero() {
        return Err(UnivariateRelationError::EvaluationPointInsideDomain { domain });
    }
    let scalar_size = u32::try_from(domain_size)
        .map_err(|_| UnivariateRelationError::DomainSizeTooLarge { name: domain })?;
    Ok((point.pow(domain_size) - ScalarField::one())
        * root_at_coordinate
        * (ScalarField::from_u32(scalar_size) * denominator).inv())
}

/// Builds U8 directly on the two canonical evaluation domains and interpolates
/// each result once. `witnesses_by_slot` is capacity-length: an inactive
/// selector slot must have no witness, and each active slot must carry the
/// same subcircuit ID as its selector entry.
pub fn witness_maps(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    selector: &[Option<usize>],
    witnesses_by_slot: &[Option<SlotWitness<'_>>],
    subcircuits: &[UnivariateSubcircuit<'_>],
) -> Result<WitnessMaps, UnivariateRelationError> {
    if selector.len() != setup.s_max {
        return Err(UnivariateRelationError::SelectorCapacity {
            actual: selector.len(),
            expected: setup.s_max,
        });
    }
    if witnesses_by_slot.len() != setup.s_max {
        return Err(UnivariateRelationError::SelectorCapacity {
            actual: witnesses_by_slot.len(),
            expected: setup.s_max,
        });
    }
    if subcircuits.len() != setup.s_D {
        return Err(UnivariateRelationError::SubcircuitCatalog {
            actual: subcircuits.len(),
            expected: setup.s_D,
        });
    }

    let interface_count = interface_wire_count(setup)?;
    let mut u_evaluations = vec![ScalarField::zero(); shape.arithmetic_domain_size];
    let mut v_evaluations = vec![ScalarField::zero(); shape.arithmetic_domain_size];
    let mut w_evaluations = vec![ScalarField::zero(); shape.arithmetic_domain_size];
    let mut b_evaluations = vec![ScalarField::zero(); shape.connection_domain_size];

    for placement_index in 0..setup.s_max {
        let (Some(subcircuit_id), Some(witness)) = (
            selector[placement_index],
            witnesses_by_slot[placement_index].as_ref(),
        ) else {
            if selector[placement_index].is_some() || witnesses_by_slot[placement_index].is_some() {
                return Err(UnivariateRelationError::SlotWitnessMismatch { placement_index });
            }
            continue;
        };
        if subcircuit_id >= setup.s_D || witness.subcircuit_id != subcircuit_id {
            return Err(UnivariateRelationError::SlotWitnessMismatch { placement_index });
        }
        let subcircuit =
            subcircuits
                .get(subcircuit_id)
                .ok_or(UnivariateRelationError::SubcircuitId {
                    value: subcircuit_id,
                })?;
        if subcircuit.id != subcircuit_id {
            return Err(UnivariateRelationError::SubcircuitId {
                value: subcircuit.id,
            });
        }
        if subcircuit.flatten_map.len() != witness.values.len() {
            return Err(UnivariateRelationError::FlattenMapLength {
                subcircuit_id,
                actual: subcircuit.flatten_map.len(),
                expected: witness.values.len(),
            });
        }

        write_matrix_evaluations(
            &mut u_evaluations,
            shape,
            setup,
            placement_index,
            subcircuit_id,
            subcircuit.a_active_wires,
            subcircuit.a_rows,
            witness.values,
            "A",
        )?;
        write_matrix_evaluations(
            &mut v_evaluations,
            shape,
            setup,
            placement_index,
            subcircuit_id,
            subcircuit.b_active_wires,
            subcircuit.b_rows,
            witness.values,
            "B",
        )?;
        write_matrix_evaluations(
            &mut w_evaluations,
            shape,
            setup,
            placement_index,
            subcircuit_id,
            subcircuit.c_active_wires,
            subcircuit.c_rows,
            witness.values,
            "C",
        )?;
        write_connection_evaluations(
            &mut b_evaluations,
            shape,
            setup,
            placement_index,
            subcircuit,
            witness.values,
            interface_count,
        )?;
    }

    Ok(WitnessMaps {
        u_a: interpolate_dense(u_evaluations)?,
        v_a: interpolate_dense(v_evaluations)?,
        w_a: interpolate_dense(w_evaluations)?,
        b_c: interpolate_dense(b_evaluations)?,
    })
}

/// Builds the U12 interpolation polynomial for the sparse permutation format.
/// Omitted entries retain the identity mapping, exactly as in
/// `permutation.json`.
pub fn connection_permutation_polynomial(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    selector: &[Option<usize>],
    permutation: &[Permutation],
) -> Result<DenseDomainPolynomial, UnivariateRelationError> {
    validate_placement_selector(selector, setup)?;
    let interface_count = interface_wire_count(setup)?;
    let domain_size = shape.connection_domain_size;
    let mut targets: Vec<usize> = (0..domain_size).collect();
    let mut explicitly_mapped = vec![false; domain_size];

    for entry in permutation {
        if entry.row >= interface_count
            || entry.X >= interface_count
            || entry.col >= setup.s_max
            || entry.Y >= setup.s_max
        {
            return Err(UnivariateRelationError::PermutationCoordinate {
                row: entry.row,
                col: entry.col,
            });
        }
        if selector[entry.col].is_none() {
            return Err(UnivariateRelationError::PermutationInactivePlacement {
                placement_index: entry.col,
            });
        }
        if selector[entry.Y].is_none() {
            return Err(UnivariateRelationError::PermutationInactivePlacement {
                placement_index: entry.Y,
            });
        }
        let source = shape
            .connection_index(entry.col, entry.row, setup)
            .map_err(|_| UnivariateRelationError::PermutationCoordinate {
                row: entry.row,
                col: entry.col,
            })?;
        let target = shape
            .connection_index(entry.Y, entry.X, setup)
            .map_err(|_| UnivariateRelationError::PermutationCoordinate {
                row: entry.X,
                col: entry.Y,
            })?;
        if explicitly_mapped[source] {
            return Err(UnivariateRelationError::PermutationNotBijective { index: source });
        }
        explicitly_mapped[source] = true;
        targets[source] = target;
    }

    let mut seen_targets = vec![false; domain_size];
    for target in &targets {
        if seen_targets[*target] {
            return Err(UnivariateRelationError::PermutationNotBijective { index: *target });
        }
        seen_targets[*target] = true;
    }

    let mut evaluations = vec![ScalarField::zero(); domain_size];
    for (source, target) in targets.into_iter().enumerate() {
        evaluations[source] = shape.connection_root.pow(target);
    }
    interpolate_dense(evaluations)
}

fn validate_placement_selector(
    selector: &[Option<usize>],
    setup: &SetupParams,
) -> Result<(), UnivariateRelationError> {
    if selector.len() != setup.s_max {
        return Err(UnivariateRelationError::SelectorCapacity {
            actual: selector.len(),
            expected: setup.s_max,
        });
    }
    if let Some(value) = selector.iter().flatten().find(|value| **value >= setup.s_D) {
        return Err(UnivariateRelationError::SubcircuitId { value: *value });
    }
    Ok(())
}

/// Builds U13's copy factors from U8 and U12 coefficient representations.
pub fn connection_copy_factors(
    b_c: &DenseDomainPolynomial,
    s_c: &DenseDomainPolynomial,
    beta: ScalarField,
    gamma_c: ScalarField,
) -> Result<(Box<[ScalarField]>, Box<[ScalarField]>), UnivariateRelationError> {
    if b_c.coefficients.len() != s_c.coefficients.len() || b_c.coefficients.len() < 2 {
        return Err(UnivariateRelationError::TransformDomainNotPowerOfTwo {
            name: "connection coefficient domain",
        });
    }
    let mut f_c = b_c.coefficients.to_vec();
    let mut g_c = b_c.coefficients.to_vec();
    for (factor, selector) in f_c.iter_mut().zip(s_c.coefficients.iter()) {
        *factor = *factor + beta * *selector;
    }
    f_c[0] = f_c[0] + gamma_c;
    g_c[0] = g_c[0] + gamma_c;
    g_c[1] = g_c[1] + beta;
    Ok((f_c.into_boxed_slice(), g_c.into_boxed_slice()))
}

fn write_matrix_evaluations(
    evaluations: &mut [ScalarField],
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit_id: usize,
    active_wires: &[usize],
    rows: &[Vec<(usize, ScalarField)>],
    witness: &[ScalarField],
    matrix: &'static str,
) -> Result<(), UnivariateRelationError> {
    if rows.len() > setup.n {
        return Err(UnivariateRelationError::MatrixRows {
            subcircuit_id,
            matrix,
            actual: rows.len(),
            expected: setup.n,
        });
    }
    for (row_index, row) in rows.iter().enumerate() {
        let mut value = ScalarField::zero();
        for (compact_index, coefficient) in row {
            let wire_index = active_wires.get(*compact_index).ok_or(
                UnivariateRelationError::LocalWireIndex {
                    subcircuit_id,
                    wire_index: *compact_index,
                },
            )?;
            let wire_value =
                witness
                    .get(*wire_index)
                    .ok_or(UnivariateRelationError::LocalWireIndex {
                        subcircuit_id,
                        wire_index: *wire_index,
                    })?;
            value = value + *coefficient * *wire_value;
        }
        let index = shape
            .arithmetic_index(placement_index, row_index, setup)
            .map_err(|_| UnivariateRelationError::PlacementIndex {
                value: placement_index,
            })?;
        evaluations[index] = value;
    }
    Ok(())
}

fn write_connection_evaluations(
    evaluations: &mut [ScalarField],
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
    placement_index: usize,
    subcircuit: &UnivariateSubcircuit<'_>,
    witness: &[ScalarField],
    interface_count: usize,
) -> Result<(), UnivariateRelationError> {
    let mut seen_interface = vec![false; interface_count];
    for (local_index, global_index) in subcircuit.flatten_map.iter().enumerate() {
        if *global_index < setup.l || *global_index >= setup.l_D {
            continue;
        }
        let interface_index = *global_index - setup.l;
        if seen_interface[interface_index] {
            return Err(UnivariateRelationError::DuplicateInterfaceCoordinate {
                subcircuit_id: subcircuit.id,
                interface_index,
            });
        }
        seen_interface[interface_index] = true;
        let value = witness
            .get(local_index)
            .ok_or(UnivariateRelationError::LocalWireIndex {
                subcircuit_id: subcircuit.id,
                wire_index: local_index,
            })?;
        let index = shape
            .connection_index(placement_index, interface_index, setup)
            .map_err(|_| UnivariateRelationError::PlacementIndex {
                value: placement_index,
            })?;
        evaluations[index] = *value;
    }
    Ok(())
}

fn interface_wire_count(setup: &SetupParams) -> Result<usize, UnivariateRelationError> {
    let count = setup
        .l_D
        .checked_sub(setup.l)
        .ok_or(UnivariateRelationError::InterfaceWireCount)?;
    if !count.is_power_of_two() {
        return Err(UnivariateRelationError::InterfaceWireCount);
    }
    Ok(count)
}

fn interpolate_dense(
    mut evaluations: Vec<ScalarField>,
) -> Result<DenseDomainPolynomial, UnivariateRelationError> {
    if !evaluations.len().is_power_of_two() {
        return Err(UnivariateRelationError::TransformDomainNotPowerOfTwo {
            name: "dense interpolation domain",
        });
    }
    init_ntt_domain_for_size(evaluations.len()).map_err(UnivariateRelationError::Ntt)?;
    let mut coefficients = vec![ScalarField::zero(); evaluations.len()];
    ntt::ntt(
        HostSlice::from_slice(&evaluations),
        NTTDir::kInverse,
        &NTTConfig::<ScalarField>::default(),
        HostSlice::from_mut_slice(&mut coefficients),
    )
    .map_err(UnivariateRelationError::Ntt)?;
    Ok(DenseDomainPolynomial {
        evaluations: std::mem::take(&mut evaluations).into_boxed_slice(),
        coefficients: coefficients.into_boxed_slice(),
    })
}

fn arithmetic_label_count(
    shape: &UnivariateCrsShape,
    setup: &SetupParams,
) -> Result<usize, UnivariateRelationError> {
    setup
        .s_max
        .checked_mul(shape.subcircuit_capacity)
        .ok_or(UnivariateRelationError::TransformDomainNotPowerOfTwo { name: "s * t" })
}

fn interpolate_selector(
    evaluations: Vec<ScalarField>,
    stride: usize,
) -> Result<StridedPolynomial, UnivariateRelationError> {
    if !evaluations.len().is_power_of_two() {
        return Err(UnivariateRelationError::TransformDomainNotPowerOfTwo {
            name: "selector-label domain",
        });
    }
    init_ntt_domain_for_size(evaluations.len()).map_err(UnivariateRelationError::Ntt)?;

    let mut coefficients = vec![ScalarField::zero(); evaluations.len()];
    ntt::ntt(
        HostSlice::from_slice(&evaluations),
        NTTDir::kInverse,
        &NTTConfig::<ScalarField>::default(),
        HostSlice::from_mut_slice(&mut coefficients),
    )
    .map_err(UnivariateRelationError::Ntt)?;
    Ok(StridedPolynomial {
        stride,
        coefficients: coefficients.into_boxed_slice(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        arithmetic_coset_selector, arithmetic_wire_lift, arithmetic_wire_lifts_at,
        connection_copy_factors, connection_coset_selector, connection_permutation_polynomial,
        connection_wire_lift, connection_wire_lift_at, placement_selector_polynomial, witness_maps,
        R1csMatrix, SlotWitness, UnivariateRelationError, UnivariateSubcircuit,
    };
    use crate::frontend_artifacts::{Permutation, SetupParams};
    use crate::univariate_crs::UnivariateCrsShape;
    use icicle_bls12_381::curve::ScalarField;
    use icicle_core::traits::{Arithmetic, FieldImpl};
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct RelationFixture {
        setup: FixtureSetup,
        selector: Vec<Option<usize>>,
        subcircuits: Vec<FixtureSubcircuit>,
        #[serde(rename = "witnessesBySlot")]
        witnesses_by_slot: Vec<Option<FixtureWitness>>,
        permutation: Vec<Permutation>,
        expected: FixtureExpected,
    }

    #[derive(Deserialize)]
    struct FixtureSetup {
        m: usize,
        t: usize,
        l_free: usize,
        l: usize,
        l_user_out: usize,
        l_user: usize,
        #[serde(rename = "l_D")]
        l_d: usize,
        #[serde(rename = "m_D")]
        m_d: usize,
        n: usize,
        #[serde(rename = "s_D")]
        s_d: usize,
        s_max: usize,
    }

    #[derive(Deserialize)]
    struct FixtureSubcircuit {
        id: usize,
        #[serde(rename = "flattenMap")]
        flatten_map: Vec<usize>,
        #[serde(rename = "aActiveWires")]
        a_active_wires: Vec<usize>,
        #[serde(rename = "bActiveWires")]
        b_active_wires: Vec<usize>,
        #[serde(rename = "cActiveWires")]
        c_active_wires: Vec<usize>,
        #[serde(rename = "aRows")]
        a_rows: Vec<Vec<(usize, u32)>>,
        #[serde(rename = "bRows")]
        b_rows: Vec<Vec<(usize, u32)>>,
        #[serde(rename = "cRows")]
        c_rows: Vec<Vec<(usize, u32)>>,
    }

    #[derive(Deserialize)]
    struct FixtureWitness {
        #[serde(rename = "subcircuitId")]
        subcircuit_id: usize,
        values: Vec<u32>,
    }

    #[derive(Deserialize)]
    struct FixtureExpected {
        #[serde(rename = "uA")]
        u_a: Vec<u32>,
        #[serde(rename = "vA")]
        v_a: Vec<u32>,
        #[serde(rename = "wA")]
        w_a: Vec<u32>,
        #[serde(rename = "bC")]
        b_c: u32,
        #[serde(rename = "u6LocalWire")]
        u6_local_wire: usize,
        #[serde(rename = "connectionLocalWire")]
        connection_local_wire: usize,
    }

    fn relation_fixture() -> RelationFixture {
        serde_json::from_str(include_str!(
            "../../../common/contracts/fixtures/univariate-relation.v1.json"
        ))
        .expect("univariate relation fixture must be valid")
    }

    fn fixture_setup(fixture: &FixtureSetup) -> SetupParams {
        SetupParams {
            l_free: fixture.l_free,
            l: fixture.l,
            l_user_out: fixture.l_user_out,
            l_user: fixture.l_user,
            l_D: fixture.l_d,
            m_D: fixture.m_d,
            n: fixture.n,
            m: fixture.m,
            t: fixture.t,
            s_D: fixture.s_d,
            s_max: fixture.s_max,
        }
    }

    fn setup() -> SetupParams {
        SetupParams {
            l_free: 0,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 4,
            n: 2,
            m: 2,
            t: 4,
            s_D: 3,
            s_max: 2,
        }
    }

    #[test]
    fn arithmetic_selectors_match_the_u2_coset_values() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let selector = arithmetic_coset_selector(&shape, &setup, 1, 2).unwrap();

        for placement in 0..setup.s_max {
            for subcircuit in 0..shape.subcircuit_capacity {
                for row in 0..setup.n {
                    let point = shape
                        .arithmetic_root
                        .pow(shape.arithmetic_index(placement, row, &setup).unwrap());
                    let expected = if (placement, subcircuit) == (1, 2) {
                        ScalarField::one()
                    } else {
                        ScalarField::zero()
                    };
                    assert_eq!(selector.evaluate(point), expected);
                }
            }
        }
    }

    #[test]
    fn placement_selector_uses_only_real_catalog_ids() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let selector = placement_selector_polynomial(&shape, &setup, &[Some(0), None]).unwrap();

        for placement in 0..setup.s_max {
            for subcircuit in 0..shape.subcircuit_capacity {
                let point = shape
                    .arithmetic_root
                    .pow(shape.arithmetic_index(placement, 0, &setup).unwrap());
                let expected = if (placement, subcircuit) == (0, 0) {
                    ScalarField::one()
                } else {
                    ScalarField::zero()
                };
                assert_eq!(selector.evaluate(point), expected);
            }
        }
        assert!(placement_selector_polynomial(&shape, &setup, &[Some(3), None]).is_err());
    }

    #[test]
    fn connection_selectors_match_the_u5_coset_values() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let selector = connection_coset_selector(&setup, 1).unwrap();

        for placement in 0..setup.s_max {
            for wire in 0..(setup.l_D - setup.l) {
                let connection_point = shape
                    .connection_root
                    .pow(shape.connection_index(placement, wire, &setup).unwrap());
                let expected = if placement == 1 {
                    ScalarField::one()
                } else {
                    ScalarField::zero()
                };
                assert_eq!(selector.evaluate(connection_point), expected);
            }
        }
    }

    #[test]
    fn witness_maps_and_connection_permutation_use_the_canonical_flat_domains() {
        let fixture = relation_fixture();
        let setup = fixture_setup(&fixture.setup);
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let a_rows: Vec<Vec<Vec<(usize, ScalarField)>>> = fixture
            .subcircuits
            .iter()
            .map(|subcircuit| {
                subcircuit
                    .a_rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|(wire, coefficient)| (*wire, ScalarField::from_u32(*coefficient)))
                            .collect()
                    })
                    .collect()
            })
            .collect();
        let b_rows: Vec<Vec<Vec<(usize, ScalarField)>>> = fixture
            .subcircuits
            .iter()
            .map(|subcircuit| {
                subcircuit
                    .b_rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|(wire, coefficient)| (*wire, ScalarField::from_u32(*coefficient)))
                            .collect()
                    })
                    .collect()
            })
            .collect();
        let c_rows: Vec<Vec<Vec<(usize, ScalarField)>>> = fixture
            .subcircuits
            .iter()
            .map(|subcircuit| {
                subcircuit
                    .c_rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|(wire, coefficient)| (*wire, ScalarField::from_u32(*coefficient)))
                            .collect()
                    })
                    .collect()
            })
            .collect();
        let subcircuits: Vec<UnivariateSubcircuit<'_>> = fixture
            .subcircuits
            .iter()
            .enumerate()
            .map(|(index, subcircuit)| UnivariateSubcircuit {
                id: subcircuit.id,
                flatten_map: &subcircuit.flatten_map,
                a_active_wires: &subcircuit.a_active_wires,
                b_active_wires: &subcircuit.b_active_wires,
                c_active_wires: &subcircuit.c_active_wires,
                a_rows: &a_rows[index],
                b_rows: &b_rows[index],
                c_rows: &c_rows[index],
            })
            .collect();
        let witness_values: Vec<Option<Vec<ScalarField>>> = fixture
            .witnesses_by_slot
            .iter()
            .map(|witness| {
                witness.as_ref().map(|witness| {
                    witness
                        .values
                        .iter()
                        .map(|value| ScalarField::from_u32(*value))
                        .collect()
                })
            })
            .collect();
        let witnesses: Vec<Option<SlotWitness<'_>>> = fixture
            .witnesses_by_slot
            .iter()
            .zip(witness_values.iter())
            .map(|(witness, values)| {
                witness
                    .as_ref()
                    .zip(values.as_ref())
                    .map(|(witness, values)| SlotWitness {
                        subcircuit_id: witness.subcircuit_id,
                        values,
                    })
            })
            .collect();

        let maps =
            witness_maps(&shape, &setup, &fixture.selector, &witnesses, &subcircuits).unwrap();
        assert_eq!(
            maps.u_a.evaluations[shape.arithmetic_index(0, 0, &setup).unwrap()],
            ScalarField::from_u32(fixture.expected.u_a[0])
        );
        assert_eq!(
            maps.u_a.evaluations[shape.arithmetic_index(0, 1, &setup).unwrap()],
            ScalarField::from_u32(fixture.expected.u_a[1])
        );
        assert_eq!(
            maps.v_a.evaluations[shape.arithmetic_index(0, 0, &setup).unwrap()],
            ScalarField::from_u32(fixture.expected.v_a[0])
        );
        assert_eq!(
            maps.w_a.evaluations[shape.arithmetic_index(0, 1, &setup).unwrap()],
            ScalarField::from_u32(fixture.expected.w_a[1])
        );
        assert_eq!(
            maps.b_c.evaluations[shape.connection_index(0, 0, &setup).unwrap()],
            ScalarField::from_u32(fixture.expected.b_c)
        );
        assert!(maps
            .b_c
            .evaluations
            .iter()
            .enumerate()
            .filter(|(index, _)| *index != shape.connection_index(0, 0, &setup).unwrap())
            .all(|(_, value)| *value == ScalarField::zero()));

        let u_lift = arithmetic_wire_lift(
            &shape,
            &setup,
            0,
            &subcircuits[0],
            fixture.expected.u6_local_wire,
            R1csMatrix::A,
        )
        .unwrap();
        assert_eq!(
            u_lift.evaluations[shape.arithmetic_index(0, 0, &setup).unwrap()],
            ScalarField::zero()
        );
        assert_eq!(
            u_lift.evaluations[shape.arithmetic_index(0, 1, &setup).unwrap()],
            ScalarField::one()
        );
        let b_lift = connection_wire_lift(
            &shape,
            &setup,
            0,
            &subcircuits[0],
            fixture.expected.connection_local_wire,
        )
        .unwrap();
        assert_eq!(
            b_lift.evaluations[shape.connection_index(0, 0, &setup).unwrap()],
            ScalarField::one()
        );
        let zero_b_lift = connection_wire_lift(&shape, &setup, 0, &subcircuits[0], 0).unwrap();
        assert!(zero_b_lift
            .evaluations
            .iter()
            .all(|value| *value == ScalarField::zero()));

        let s_c = connection_permutation_polynomial(
            &shape,
            &setup,
            &fixture.selector,
            &fixture.permutation,
        )
        .unwrap();
        assert_eq!(
            s_c.evaluations[shape.connection_index(0, 0, &setup).unwrap()],
            shape
                .connection_root
                .pow(shape.connection_index(1, 1, &setup).unwrap()),
        );
        assert_eq!(
            s_c.evaluations[shape.connection_index(1, 1, &setup).unwrap()],
            ScalarField::one(),
        );

        let (f_c, g_c) = connection_copy_factors(
            &maps.b_c,
            &s_c,
            ScalarField::from_u32(7),
            ScalarField::from_u32(11),
        )
        .unwrap();
        assert_eq!(f_c.len(), shape.connection_domain_size);
        assert_eq!(g_c.len(), shape.connection_domain_size);
    }

    #[test]
    fn non_power_of_two_interface_count_is_rejected_before_connection_transforms() {
        let mut setup = setup();
        setup.l_D = 5;
        assert!(UnivariateCrsShape::from_setup_params(&setup).is_err());
        assert!(connection_coset_selector(&setup, 0).is_err());
    }

    #[test]
    fn permutation_admission_rejects_invalid_selector_and_mapping_shapes() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();

        assert!(matches!(
            connection_permutation_polynomial(&shape, &setup, &[Some(setup.s_D), None], &[],),
            Err(UnivariateRelationError::SubcircuitId { .. })
        ));
        assert!(matches!(
            connection_permutation_polynomial(
                &shape,
                &setup,
                &[Some(0), None],
                &[Permutation {
                    row: 0,
                    col: 0,
                    X: 0,
                    Y: 1,
                }],
            ),
            Err(UnivariateRelationError::PermutationInactivePlacement { .. })
        ));
        assert!(matches!(
            connection_permutation_polynomial(
                &shape,
                &setup,
                &[Some(0), Some(0)],
                &[Permutation {
                    row: setup.l_D - setup.l,
                    col: 0,
                    X: 0,
                    Y: 1,
                }],
            ),
            Err(UnivariateRelationError::PermutationCoordinate { .. })
        ));
        assert!(matches!(
            connection_permutation_polynomial(
                &shape,
                &setup,
                &[Some(0), Some(0)],
                &[Permutation {
                    row: 0,
                    col: 0,
                    X: 0,
                    Y: 1,
                }],
            ),
            Err(UnivariateRelationError::PermutationNotBijective { .. })
        ));
    }

    #[test]
    fn direct_tagged_wire_evaluation_matches_dense_interpolation() {
        let fixture = relation_fixture();
        let setup = fixture_setup(&fixture.setup);
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let a_rows: Vec<Vec<Vec<(usize, ScalarField)>>> = fixture
            .subcircuits
            .iter()
            .map(|subcircuit| field_rows(&subcircuit.a_rows))
            .collect();
        let b_rows: Vec<Vec<Vec<(usize, ScalarField)>>> = fixture
            .subcircuits
            .iter()
            .map(|subcircuit| field_rows(&subcircuit.b_rows))
            .collect();
        let c_rows: Vec<Vec<Vec<(usize, ScalarField)>>> = fixture
            .subcircuits
            .iter()
            .map(|subcircuit| field_rows(&subcircuit.c_rows))
            .collect();
        let subcircuits: Vec<UnivariateSubcircuit<'_>> = fixture
            .subcircuits
            .iter()
            .enumerate()
            .map(|(index, subcircuit)| UnivariateSubcircuit {
                id: subcircuit.id,
                flatten_map: &subcircuit.flatten_map,
                a_active_wires: &subcircuit.a_active_wires,
                b_active_wires: &subcircuit.b_active_wires,
                c_active_wires: &subcircuit.c_active_wires,
                a_rows: &a_rows[index],
                b_rows: &b_rows[index],
                c_rows: &c_rows[index],
            })
            .collect();
        let point = test_point_outside_domains(&shape);
        let local_wire = fixture.expected.u6_local_wire;

        let dense_u = arithmetic_wire_lift(
            &shape,
            &setup,
            0,
            &subcircuits[0],
            local_wire,
            R1csMatrix::A,
        )
        .unwrap();
        let dense_v = arithmetic_wire_lift(
            &shape,
            &setup,
            0,
            &subcircuits[0],
            local_wire,
            R1csMatrix::B,
        )
        .unwrap();
        let dense_w = arithmetic_wire_lift(
            &shape,
            &setup,
            0,
            &subcircuits[0],
            local_wire,
            R1csMatrix::C,
        )
        .unwrap();
        let direct =
            arithmetic_wire_lifts_at(&shape, &setup, 0, &subcircuits[0], local_wire, point)
                .unwrap();
        assert_eq!(
            direct[0],
            evaluate_coefficients(&dense_u.coefficients, point)
        );
        assert_eq!(
            direct[1],
            evaluate_coefficients(&dense_v.coefficients, point)
        );
        assert_eq!(
            direct[2],
            evaluate_coefficients(&dense_w.coefficients, point)
        );

        let dense_b = connection_wire_lift(
            &shape,
            &setup,
            0,
            &subcircuits[0],
            fixture.expected.connection_local_wire,
        )
        .unwrap();
        assert_eq!(
            connection_wire_lift_at(
                &shape,
                &setup,
                0,
                &subcircuits[0],
                fixture.expected.connection_local_wire,
                point,
            )
            .unwrap(),
            evaluate_coefficients(&dense_b.coefficients, point)
        );
    }

    fn evaluate_coefficients(coefficients: &[ScalarField], point: ScalarField) -> ScalarField {
        coefficients
            .iter()
            .rev()
            .fold(ScalarField::zero(), |value, coefficient| {
                value * point + *coefficient
            })
    }

    fn test_point_outside_domains(shape: &UnivariateCrsShape) -> ScalarField {
        let mut point = ScalarField::from_u32(2);
        while point.pow(shape.arithmetic_domain_size) == ScalarField::one()
            || point.pow(shape.connection_domain_size) == ScalarField::one()
        {
            point = point + ScalarField::one();
        }
        point
    }

    fn field_rows(rows: &[Vec<(usize, u32)>]) -> Vec<Vec<(usize, ScalarField)>> {
        rows.iter()
            .map(|row| {
                row.iter()
                    .map(|(wire, coefficient)| (*wire, ScalarField::from_u32(*coefficient)))
                    .collect()
            })
            .collect()
    }
}
