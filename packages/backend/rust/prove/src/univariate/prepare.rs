//! Frontend ingress into engine-native fields and the ordered protocol domains.
use super::{engine::Engine, DomainPolynomial, Prepared, UnivariateProverError};
use crate::univariate_crs::ProverCrs;
use libs::{
    frontend_artifacts::{
        public_wire_layout::PublicWireLayout, Instance, Permutation, PlacementVariables,
        SetupParams,
    },
    univariate_field::ProtocolField,
    univariate_relation::UnivariateSubcircuit,
};

pub fn root<F: ProtocolField>(n: usize) -> Result<F, UnivariateProverError> {
    let r = libs::univariate_field::canonical_root(n)
        .ok_or("unsupported protocol domain".to_owned())?;
    Ok(F::from_le(&r.canonical_le()))
}
fn parse<F: ProtocolField>(text: &str) -> Result<F, UnivariateProverError> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    let padded = if text.len() % 2 == 1 {
        format!("0{text}")
    } else {
        text.to_owned()
    };
    let mut bytes = hex::decode(padded).map_err(|e| e.to_string())?;
    bytes.reverse();
    if bytes.len() > 32 {
        return Err("scalar input exceeds 32 bytes".to_owned().into());
    }
    bytes.resize(32, 0);
    if !libs::univariate_field::canonical_scalar(&bytes) {
        return Err("noncanonical scalar input".to_owned().into());
    }
    Ok(F::from_le(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scalar_ingress_has_identical_canonical_bounds_on_both_engines() {
        use ark_bls12_381::Fr;
        use ark_ff::{BigInteger, PrimeField};
        use icicle_bls12_381::curve::ScalarField;
        let modulus = hex::encode(Fr::MODULUS.to_bytes_be());
        for invalid in [modulus.as_str(), "xyz", &"ff".repeat(33)] {
            assert!(parse::<Fr>(invalid).is_err());
            assert!(parse::<ScalarField>(invalid).is_err());
        }
        for valid in ["0", "0x1", "0100", "0x123456789abcdef"] {
            assert_eq!(
                parse::<Fr>(valid).unwrap().canonical_le(),
                parse::<ScalarField>(valid).unwrap().canonical_le()
            );
        }
    }
}
pub fn prepare<E: Engine>(
    crs: &ProverCrs,
    setup: &SetupParams,
    selector: &[Option<usize>],
    permutation: &[Permutation],
    placements: &[PlacementVariables],
    instance: &Instance,
    circuits: &[UnivariateSubcircuit<'_>],
) -> Result<Prepared<E::F>, UnivariateProverError> {
    if selector.len() != setup.s_max
        || circuits.len() != setup.s_D
        || selector.iter().flatten().any(|k| *k >= setup.s_D)
    {
        return Err("selector or catalog dimensions mismatch".to_owned().into());
    }
    let na = crs.shape.arithmetic_domain_size;
    let nc = crs.shape.connection_domain_size;
    E::initialize(
        (2 * (na.max(nc) + 4))
            .next_power_of_two()
            .max((crs.shape.selection_domain_size + 1).next_power_of_two()),
    )?;
    let mut records = placements.iter();
    let mut slots = Vec::with_capacity(setup.s_max);
    for k in selector {
        match k {
            None => slots.push(None),
            Some(k) => {
                let record = records.next().ok_or("missing placement".to_owned())?;
                if record.subcircuitId != *k
                    || record.variables.len() != circuits[*k].flatten_map.len()
                {
                    return Err("selector and witness mismatch".to_owned().into());
                }
                slots.push(Some(
                    record
                        .variables
                        .iter()
                        .map(|s| parse::<E::F>(s.as_ref()))
                        .collect::<Result<Vec<_>, _>>()?
                        .into_boxed_slice(),
                ));
            }
        }
    }
    if records.next().is_some() {
        return Err("extra placement".to_owned().into());
    }
    let public_inputs = instance
        .a_pub_user
        .iter()
        .chain(instance.a_pub_block.iter())
        .chain(instance.a_pub_function.iter())
        .map(|s| parse::<E::F>(s.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    if public_inputs.len() != setup.l {
        return Err("public instance length mismatch".to_owned().into());
    }
    let mut evaluations = [
        vec![E::F::zero(); na],
        vec![E::F::zero(); na],
        vec![E::F::zero(); na],
        vec![E::F::zero(); nc],
    ];
    // The existing sparse parser exposes canonical field limbs. Convert each
    // library coefficient once at ingress, never during polynomial operations.
    let matrices: Vec<_> = circuits
        .iter()
        .map(|c| {
            [
                (c.a_active_wires, c.a_rows),
                (c.b_active_wires, c.b_rows),
                (c.c_active_wires, c.c_rows),
            ]
            .map(|(active, rows)| {
                (
                    active,
                    rows.iter()
                        .map(|row| {
                            row.iter()
                                .map(|(j, v)| (*j, E::F::from_le(&v.canonical_le())))
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>(),
                )
            })
        })
        .collect();
    let mi = setup.l_D - setup.l;
    for (i, slot) in slots.iter().enumerate() {
        if let Some(w) = slot {
            let k = selector[i].unwrap();
            let c = &circuits[k];
            if c.id != k {
                return Err("catalog ID mismatch".to_owned().into());
            }
            for (matrix, (active, rows)) in matrices[k].iter().enumerate() {
                if rows.len() > setup.n {
                    return Err("R1CS row count exceeds n".to_owned().into());
                }
                for (r, row) in rows.iter().enumerate() {
                    let mut value = E::F::zero();
                    for (j, v) in row {
                        let local = *active
                            .get(*j)
                            .ok_or("invalid compact R1CS column".to_owned())?;
                        value = value
                            + *v * *w.get(local).ok_or("R1CS wire outside witness".to_owned())?;
                    }
                    evaluations[matrix][i + setup.s_max * r] = value;
                }
            }
            let mut seen = vec![false; mi];
            for (j, g) in c.flatten_map.iter().enumerate() {
                if *g >= setup.l && *g < setup.l_D {
                    let h = *g - setup.l;
                    if seen[h] {
                        return Err("duplicate interface coordinate".to_owned().into());
                    }
                    seen[h] = true;
                    evaluations[3][i + setup.s_max * h] = w[j];
                }
            }
        }
    }
    let ar = E::F::from_le(&crs.shape.arithmetic_root.canonical_le());
    let cr = E::F::from_le(&crs.shape.connection_root.canonical_le());
    let mut at = 0;
    let maps = evaluations.map(|values| {
        let root = if at < 3 { ar } else { cr };
        at += 1;
        let coefficients = E::coefficients(&E::interpolate(&values, root));
        DomainPolynomial {
            evaluations: values,
            coefficients,
        }
    });
    let targets = libs::univariate_relation::connection_permutation_targets(
        &crs.shape,
        setup,
        selector,
        permutation,
    )
    .map_err(|e| e.to_string())?;
    let mut powers = Vec::with_capacity(nc);
    let mut power = E::F::one();
    for _ in 0..nc {
        powers.push(power);
        power = power * cr;
    }
    let evaluations = targets.into_iter().map(|t| powers[t]).collect::<Vec<_>>();
    let coefficients = E::coefficients(&E::interpolate(&evaluations, cr));
    Ok(Prepared {
        slots,
        public_inputs,
        maps,
        s_c: DomainPolynomial {
            evaluations,
            coefficients,
        },
    })
}

pub fn validate_public<F: ProtocolField>(
    setup: &SetupParams,
    public: &PublicWireLayout,
    selector: &[Option<usize>],
    slots: &[Option<Box<[F]>>],
    values: &[F],
) -> Result<(), UnivariateProverError> {
    if values.len() != setup.l || selector.len() != setup.s_max || slots.len() != setup.s_max {
        return Err("proving input dimensions mismatch".to_owned().into());
    }
    for (i, k) in selector.iter().enumerate() {
        if let Some(k) = k {
            if i != *k && public.segments().iter().any(|s| s.subcircuit_id == *k) {
                return Err("public buffer cannot be repeated at another placement"
                    .to_owned()
                    .into());
            }
        }
    }
    for (g, value) in values.iter().enumerate() {
        let expected = if let Some(key) = public.public_query_key_for_public_wire(g) {
            // The i == subcircuit ID specialization applies only to public
            // buffer wires. Private/intermediate queries use actual placements.
            let k = key.buffer_subcircuit_id;
            if selector.get(k) != Some(&Some(k)) {
                return Err("public buffer must occupy its matching placement"
                    .to_owned()
                    .into());
            }
            slots[k]
                .as_ref()
                .and_then(|w| w.get(key.local_public_wire_index))
                .copied()
                .ok_or("missing public witness".to_owned())?
        } else {
            F::zero()
        };
        if *value != expected {
            return Err(format!("public wire {g} differs from witness or padding").into());
        }
    }
    Ok(())
}
