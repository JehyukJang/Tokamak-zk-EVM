//! Current prover-only CRS ingress. Omitted zero-witness coordinates are never
//! expanded; the library-derived layout selects stored query blocks directly.

use backend_univariate_crs_interface::{
    archive, NonpublicQueryLayout, ProverKeysRkyv, TauSequenceRkyv, UnivariateG1Rkyv,
};
use icicle_bls12_381::curve::{BaseField, G1Affine, G1Projective, ScalarField};
use icicle_core::{
    msm::{msm, MSMConfig},
    traits::FieldImpl,
};
use icicle_runtime::memory::HostSlice;
use libs::{
    frontend_artifacts::{public_wire_layout::PublicWireLayout, SetupParams},
    group_structures::G1serde,
    univariate_crs::{UnivariateCrsShape, UNIVARIATE_CRS_SCHEMA_ID},
    univariate_relation::UnivariateSubcircuit,
};
use std::{fs, io, path::Path};

pub struct ProverCrs {
    pub tau: TauSequenceRkyv,
    pub keys: ProverKeysRkyv,
    pub shape: UnivariateCrsShape,
    pub layout: NonpublicQueryLayout,
}

impl ProverCrs {
    pub fn read(
        tau: &Path,
        keys: &Path,
        setup: &SetupParams,
        circuits: &[UnivariateSubcircuit<'_>],
        public: &PublicWireLayout,
    ) -> io::Result<Self> {
        let tau = archive::from_bytes::<TauSequenceRkyv, archive::rancor::Error>(&fs::read(tau)?)
            .map_err(io::Error::other)?;
        let keys = archive::from_bytes::<ProverKeysRkyv, archive::rancor::Error>(&fs::read(
            keys.join("prover_keys.rkyv"),
        )?)
        .map_err(io::Error::other)?;
        Self::new(tau, keys, setup, circuits, public).map_err(io::Error::other)
    }

    pub fn new(
        tau: TauSequenceRkyv,
        keys: ProverKeysRkyv,
        setup: &SetupParams,
        circuits: &[UnivariateSubcircuit<'_>],
        public: &PublicWireLayout,
    ) -> Result<Self, String> {
        let shape = UnivariateCrsShape::from_setup_params(setup).map_err(|e| e.to_string())?;
        let maps = circuits.iter().map(|c| c.flatten_map).collect::<Vec<_>>();
        let layout = NonpublicQueryLayout::new(setup.s_max, setup.m, setup.l, &maps)?;
        let free_count = (0..setup.l_free)
            .filter(|g| public.public_query_key_for_public_wire(*g).is_some())
            .count();
        if tau.schema_id != UNIVARIATE_CRS_SCHEMA_ID
            || keys.schema_id != UNIVARIATE_CRS_SCHEMA_ID
            || tau.s0_g1.len() != shape.minimum_capacity[0] + 1
            || tau.sxi_g1.len() != shape.minimum_capacity[1] + 1
            || tau.spsi_g1.len() != shape.minimum_capacity[2] + 1
            || keys.weighted_g1.len() != setup.m * setup.s_max
            || keys.weighted_shifted_g1.len() != setup.m * setup.s_max
            || keys.nonpublic_queries.len() != layout.len()
            || keys.free_public_queries.len() != free_count
        {
            return Err(
                "prover CRS schema or query lengths do not match the selected library".into(),
            );
        }
        Ok(Self {
            tau,
            keys,
            shape,
            layout,
        })
    }
}

pub fn point(record: &UnivariateG1Rkyv) -> G1Affine {
    G1Affine::from_limbs(
        BaseField::from_bytes_le(&record.x).into(),
        BaseField::from_bytes_le(&record.y).into(),
    )
}

/// One ICICLE MSM owns CPU/CUDA provider parallelism. Callers do not nest
/// parallel execution around it or perform one scalar multiplication per base.
pub fn msm_points(bases: &[G1Affine], scalars: &[ScalarField]) -> Result<G1serde, String> {
    if bases.len() != scalars.len() {
        return Err("MSM base/scalar length mismatch".into());
    }
    if bases.is_empty() {
        return Ok(G1serde::zero());
    }
    let mut result = [G1Projective::zero()];
    msm(
        HostSlice::from_slice(scalars),
        HostSlice::from_slice(bases),
        &MSMConfig::default(),
        HostSlice::from_mut_slice(&mut result),
    )
    .map_err(|e| format!("ICICLE MSM failed: {e:?}"))?;
    Ok(G1serde(G1Affine::from(result[0])))
}

pub fn commit(
    bases: &[UnivariateG1Rkyv],
    coefficients: &[ScalarField],
    offset: usize,
) -> Result<G1serde, String> {
    let end = offset
        .checked_add(coefficients.len())
        .ok_or("commitment exponent overflow")?;
    let selected = bases
        .get(offset..end)
        .ok_or("polynomial exceeds the published source sequence")?;
    msm_points(
        &selected.iter().map(point).collect::<Vec<_>>(),
        coefficients,
    )
}
