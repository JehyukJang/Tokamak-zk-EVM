//! Selected-root product tree and U29 quotients. ICICLE builds the product tree;
//! batched wire interpolation shares host cofactors. No s*t witness table or
//! per-wire selection-domain NTT is built.

use crate::frontend_artifacts::SetupParams;
use crate::ntt_domain::init_ntt_domain_for_size;
use crate::univariate_crs::UnivariateCrsShape;
use icicle_bls12_381::{curve::ScalarField, polynomials::DensePolynomial};
use icicle_core::polynomials::UnivariatePolynomial;
use icicle_core::traits::{Arithmetic, FieldImpl};
use icicle_runtime::memory::HostSlice;

/// One circuit's selected roots and product tree, reused across its local wires.
pub struct SelectedRoots {
    pub roots: Vec<ScalarField>,
    tree: Vec<Vec<DensePolynomial>>,
    domain_size: usize,
}

impl SelectedRoots {
    pub fn new(
        shape: &UnivariateCrsShape,
        setup: &SetupParams,
        selector: &[Option<usize>],
    ) -> Result<Self, String> {
        if selector.len() != setup.s_max || selector.iter().flatten().any(|id| *id >= setup.s_D) {
            return Err(
                "selector must contain actual IDs or unused slots at exactly s_max positions"
                    .into(),
            );
        }
        let size = shape.selection_domain_size;
        let transform_size = size
            .checked_add(1)
            .and_then(usize::checked_next_power_of_two)
            .ok_or("selection transform size overflow")?;
        init_ntt_domain_for_size(transform_size)
            .map_err(|error| format!("selection NTT initialization failed: {error:?}"))?;
        let roots = selector
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let k = id.unwrap_or(setup.t - 1);
                shape.selection_root.pow(i + setup.s_max * k)
            })
            .collect::<Vec<_>>();
        let mut tree = vec![roots
            .iter()
            .map(|z| {
                DensePolynomial::from_coeffs(
                    HostSlice::from_slice(&[ScalarField::zero() - *z, ScalarField::one()]),
                    2,
                )
            })
            .collect::<Vec<_>>()];
        while tree.last().unwrap().len() > 1 {
            // Each ICICLE multiplication owns its provider's parallelism.
            let parents = tree
                .last()
                .unwrap()
                .chunks_exact(2)
                .map(|pair| pair[0].mul(&pair[1]))
                .collect();
            tree.push(parents);
        }
        Ok(Self {
            roots,
            tree,
            domain_size: size,
        })
    }

    pub fn selected_polynomial(&self) -> &DensePolynomial {
        &self.tree.last().unwrap()[0]
    }

    /// The preprocess-only dense Z_u representation. Proving does not need
    /// to reconstruct it for each wire.
    pub fn unselected_polynomial(&self) -> Result<DensePolynomial, String> {
        let mut coefficients = vec![ScalarField::zero(); self.domain_size + 1];
        coefficients[0] = ScalarField::zero() - ScalarField::one();
        coefficients[self.domain_size] = ScalarField::one();
        let zs =
            DensePolynomial::from_coeffs(HostSlice::from_slice(&coefficients), coefficients.len());
        let (quotient, remainder) = zs.divide(self.selected_polynomial());
        if remainder.degree() >= 0 && remainder.get_coeff(0) != ScalarField::zero()
            || remainder.degree() > 0
        {
            return Err("selected-root polynomial does not divide Z^N_S - 1".into());
        }
        Ok(quotient)
    }

    /// Z_u(z_i) = N_S z_i^(N_S-1) / Z_v'(z_i).
    pub fn unselected_values(&self) -> Result<Vec<ScalarField>, String> {
        let zv = self.selected_polynomial();
        let mut coefficients = vec![ScalarField::zero(); self.roots.len() + 1];
        zv.copy_coeffs(0, HostSlice::from_mut_slice(&mut coefficients));
        let derivative = coefficients
            .iter()
            .enumerate()
            .skip(1)
            .map(|(i, value)| *value * ScalarField::from_bytes_le(&i.to_le_bytes()))
            .collect::<Vec<_>>();
        let polynomial =
            DensePolynomial::from_coeffs(HostSlice::from_slice(&derivative), derivative.len());
        let mut values = vec![ScalarField::zero(); self.roots.len()];
        polynomial.eval_on_domain(
            HostSlice::from_slice(&self.roots),
            HostSlice::from_mut_slice(&mut values),
        );
        let size = ScalarField::from_bytes_le(&self.domain_size.to_le_bytes());
        for (root, value) in self.roots.iter().zip(&mut values) {
            if *value == ScalarField::zero() {
                return Err("duplicate selected roots".into());
            }
            *value = size * root.inv() * value.inv();
        }
        Ok(values)
    }

    /// Interpolates q_j(z_i)=w_(i,j)/Z_u(z_i), degree < s. Since
    /// Z_u(z_i) Z_v'(z_i)=N_S/z_i, the leaf coefficient is simply
    /// w_(i,j) z_i/N_S. The product tree combines these weighted cofactors.
    pub fn quotient_for_wire(
        &self,
        witness_values: &[ScalarField],
    ) -> Result<DensePolynomial, String> {
        if witness_values.len() != self.roots.len() {
            return Err("selection quotient needs one value per placement slot".into());
        }
        let inverse_size = ScalarField::from_bytes_le(&self.domain_size.to_le_bytes()).inv();
        let mut numerators = witness_values
            .iter()
            .zip(&self.roots)
            .map(|(w, z)| {
                let value = *w * *z * inverse_size;
                DensePolynomial::from_coeffs(HostSlice::from_slice(&[value]), 1)
            })
            .collect::<Vec<_>>();
        for products in self.tree.iter().take(self.tree.len() - 1) {
            numerators = numerators
                .chunks_exact(2)
                .zip(products.chunks_exact(2))
                .map(|(q, p)| q[0].mul(&p[1]).add(&q[1].mul(&p[0])))
                .collect();
        }
        Ok(numerators.pop().unwrap())
    }

    /// U29 for a wire-major `m * s` assignment. All wires share the weighted
    /// cofactors `(z_i / N_S) * Z_v(Z) / (Z - z_i)`. Construct them once by
    /// synthetic division, then form each quotient by a host-field dot product.
    /// This uses O(s^2 + m*s) storage, never the selection-domain m*s*t grid.
    /// Rayon runs only host arithmetic; no ICICLE call is nested inside it.
    pub fn quotients_for_wires(
        &self,
        witness_values: &[ScalarField],
    ) -> Result<Vec<ScalarField>, String> {
        use ark_bls12_381::Fr;
        use ark_ff::{BigInteger, Field, PrimeField, Zero};
        use rayon::prelude::*;

        let s = self.roots.len();
        if witness_values.len() % s != 0 {
            return Err("selection quotients need complete placement rows".into());
        }
        let mut zv = vec![ScalarField::zero(); s + 1];
        self.selected_polynomial()
            .copy_coeffs(0, HostSlice::from_mut_slice(&mut zv));
        let zv = zv
            .iter()
            .map(|v| Fr::from_le_bytes_mod_order(&v.to_bytes_le()))
            .collect::<Vec<_>>();
        let inverse_size = Fr::from(self.domain_size as u64).inverse().unwrap();
        let roots = self
            .roots
            .iter()
            .map(|v| Fr::from_le_bytes_mod_order(&v.to_bytes_le()))
            .collect::<Vec<_>>();
        let mut cofactors = vec![
            Fr::zero();
            s.checked_mul(s)
                .ok_or("selection cofactor capacity overflow")?
        ];
        cofactors
            .par_chunks_mut(s)
            .zip(roots.par_iter())
            .for_each(|(row, z)| {
                let scale = *z * inverse_size;
                let mut coefficient = zv[s];
                for a in (0..s).rev() {
                    row[a] = coefficient * scale;
                    coefficient = zv[a] + *z * coefficient;
                }
            });
        let mut result = vec![ScalarField::zero(); witness_values.len()];
        result
            .par_chunks_mut(s)
            .zip(witness_values.par_chunks(s))
            .for_each(|(out, values)| {
                let mut coefficients = vec![Fr::zero(); s];
                for (value, row) in values.iter().zip(cofactors.chunks_exact(s)) {
                    if *value == ScalarField::zero() {
                        continue;
                    }
                    let value = Fr::from_le_bytes_mod_order(&value.to_bytes_le());
                    for (coefficient, basis) in coefficients.iter_mut().zip(row) {
                        *coefficient += value * basis;
                    }
                }
                for (out, coefficient) in out.iter_mut().zip(coefficients) {
                    *out = ScalarField::from_bytes_le(&coefficient.into_bigint().to_bytes_le());
                }
            });
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> SetupParams {
        SetupParams {
            l_free: 2,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 6,
            m_D: 12,
            n: 4,
            m: 4,
            t: 4,
            s_D: 3,
            s_max: 4,
        }
    }

    #[test]
    fn icicle_selection_tree_matches_u29_for_full_partial_and_empty_placements() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        for selector in [
            vec![Some(0), Some(1), Some(2), Some(0)],
            vec![Some(0), Some(1), None, None],
            vec![None; 4],
        ] {
            let selected = SelectedRoots::new(&shape, &setup, &selector).unwrap();
            let zu = selected.unselected_polynomial().unwrap();
            let product = selected.selected_polynomial().mul(&zu);
            assert_eq!(product.degree(), shape.selection_domain_size as i64);
            for exponent in 0..=shape.selection_domain_size {
                let expected = if exponent == 0 {
                    ScalarField::zero() - ScalarField::one()
                } else if exponent == shape.selection_domain_size {
                    ScalarField::one()
                } else {
                    ScalarField::zero()
                };
                assert_eq!(product.get_coeff(exponent as u64), expected);
            }
            let zu_values = selected.unselected_values().unwrap();
            for (root, value) in selected.roots.iter().zip(&zu_values) {
                assert_eq!(zu.eval(root), *value);
            }
            for j in 0..setup.m {
                let values = selector
                    .iter()
                    .enumerate()
                    .map(|(i, id)| {
                        if id.is_none() {
                            ScalarField::zero()
                        } else {
                            ScalarField::from_u32((i + j + 1) as u32)
                        }
                    })
                    .collect::<Vec<_>>();
                let q = selected.quotient_for_wire(&values).unwrap();
                assert!(q.degree() < setup.s_max as i64);
                let binding = zu.mul(&q);
                for k in 0..setup.t {
                    for i in 0..setup.s_max {
                        let z = shape.selection_root.pow(i + setup.s_max * k);
                        let expected = if selector[i] == Some(k) {
                            values[i]
                        } else {
                            ScalarField::zero()
                        };
                        assert_eq!(binding.eval(&z), expected);
                    }
                }
            }
        }
    }

    #[test]
    fn rejects_truncated_selectors_and_virtual_ids_as_real_entries() {
        let setup = setup();
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        assert!(SelectedRoots::new(&shape, &setup, &[None]).is_err());
        assert!(SelectedRoots::new(&shape, &setup, &[Some(3); 4]).is_err());
    }
}
