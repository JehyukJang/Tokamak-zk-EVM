use crate::alpha_x_basis::{AlphaXBasis, DuskAdaptedAlphaXBasis, DuskAdaptorLayout};
use crate::conversions::{serialize_g1_affine, serialize_g2_affine};
use crate::protocol::{
    AdaptedTau, CeremonyState, ContributionProfile, CurveGroup, PointChunkDescriptor,
    ProtocolError, Sha256Digest, SourceProvenance, UniversalTau,
};
use crate::utils::{icicle_g1_generator, icicle_g2_generator};
use ark_serialize::Compress;
use libs::group_structures::{G1serde, G2serde};
use libs::utils::SetupShape;
use serde::{Deserialize, Serialize};
use std::io;
use thiserror::Error;

const POINTS_PER_CHUNK: usize = 1 << 16;

#[derive(Debug, Error)]
pub enum UniversalTauError {
    #[error("invalid monomial layout: {0}")]
    InvalidLayout(String),
    #[error("adapted tau does not match the requested capacity or monomial layout")]
    AdaptedIdentityMismatch,
    #[error("adapted tau exponent mapping does not cover the requested monomial layout")]
    AdaptedMappingMismatch,
    #[error("universal tau has an invalid shape or inconsistent family boundary: {0}")]
    InvalidPayload(String),
    #[error("protocol contract error: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("point serialization error: {0}")]
    Serialization(#[from] io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonomialLayout {
    pub contract_version: u32,
    pub n: usize,
    pub m_i: usize,
    pub s: usize,
    pub n_max: usize,
    pub x_grid_len: usize,
    pub y_grid_len: usize,
    pub alpha_max: usize,
    pub alpha_x_max: usize,
    pub alpha_y_max: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapacityIdentity {
    contract_version: u32,
    l_free: usize,
    m_i: usize,
    n: usize,
    s_max: usize,
}

impl MonomialLayout {
    pub fn derive(shape: &SetupShape) -> Result<Self, UniversalTauError> {
        if !shape.n.is_power_of_two()
            || !shape.m_i.is_power_of_two()
            || !shape.s_max.is_power_of_two()
        {
            return Err(UniversalTauError::InvalidLayout(
                "n, m_i, and s_max must be nonzero powers of two".to_string(),
            ));
        }
        let n_max = shape.n.max(shape.m_i);
        let x_grid_len = n_max
            .checked_mul(2)
            .ok_or_else(|| UniversalTauError::InvalidLayout("x grid overflow".to_string()))?;
        let y_grid_len = shape
            .s_max
            .checked_mul(2)
            .ok_or_else(|| UniversalTauError::InvalidLayout("y grid overflow".to_string()))?;
        let alpha_x_max = x_grid_len
            .max(shape.n.checked_add(2).ok_or_else(|| {
                UniversalTauError::InvalidLayout("alpha-X n bound overflow".to_string())
            })?)
            .max(shape.m_i.checked_add(1).ok_or_else(|| {
                UniversalTauError::InvalidLayout("alpha-X m_i bound overflow".to_string())
            })?);
        let alpha_y_max = y_grid_len
            .checked_sub(1)
            .expect("twice a positive s is positive")
            .max(shape.s_max.checked_add(2).ok_or_else(|| {
                UniversalTauError::InvalidLayout("alpha-Y bound overflow".to_string())
            })?);
        let value = Self {
            contract_version: 1,
            n: shape.n,
            m_i: shape.m_i,
            s: shape.s_max,
            n_max,
            x_grid_len,
            y_grid_len,
            alpha_max: 4,
            alpha_x_max,
            alpha_y_max,
        };
        value.validate_allocations()?;
        Ok(value)
    }

    pub fn digest(&self) -> Result<Sha256Digest, UniversalTauError> {
        canonical_digest(self)
    }

    pub fn to_canonical_json(&self) -> Result<Vec<u8>, UniversalTauError> {
        self.validate()?;
        serde_json::to_vec(self)
            .map_err(|error| UniversalTauError::InvalidLayout(error.to_string()))
    }

    pub fn from_canonical_json(bytes: &[u8]) -> Result<Self, UniversalTauError> {
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|error| UniversalTauError::InvalidLayout(error.to_string()))?;
        value.validate()?;
        if value.to_canonical_json()? != bytes {
            return Err(UniversalTauError::InvalidLayout(
                "layout JSON is not in canonical form".to_string(),
            ));
        }
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), UniversalTauError> {
        if self.contract_version != 1 {
            return Err(UniversalTauError::InvalidLayout(
                "unsupported layout contract version".to_string(),
            ));
        }
        if !self.n.is_power_of_two() || !self.m_i.is_power_of_two() || !self.s.is_power_of_two() {
            return Err(UniversalTauError::InvalidLayout(
                "n, m_i, and s must be nonzero powers of two".to_string(),
            ));
        }
        let expected_n_max = self.n.max(self.m_i);
        let expected_x_grid_len = expected_n_max
            .checked_mul(2)
            .ok_or_else(|| UniversalTauError::InvalidLayout("x grid overflow".to_string()))?;
        let expected_y_grid_len = self
            .s
            .checked_mul(2)
            .ok_or_else(|| UniversalTauError::InvalidLayout("y grid overflow".to_string()))?;
        let expected_alpha_x_max = expected_x_grid_len
            .max(self.n.checked_add(2).ok_or_else(|| {
                UniversalTauError::InvalidLayout("alpha-X n bound overflow".to_string())
            })?)
            .max(self.m_i.checked_add(1).ok_or_else(|| {
                UniversalTauError::InvalidLayout("alpha-X m_i bound overflow".to_string())
            })?);
        let expected_alpha_y_max = expected_y_grid_len
            .checked_sub(1)
            .ok_or_else(|| UniversalTauError::InvalidLayout("Y grid is empty".to_string()))?
            .max(self.s.checked_add(2).ok_or_else(|| {
                UniversalTauError::InvalidLayout("alpha-Y bound overflow".to_string())
            })?);
        if self.n_max != expected_n_max
            || self.x_grid_len != expected_x_grid_len
            || self.y_grid_len != expected_y_grid_len
            || self.alpha_max != 4
            || self.alpha_x_max != expected_alpha_x_max
            || self.alpha_y_max != expected_alpha_y_max
        {
            return Err(UniversalTauError::InvalidLayout(
                "stored dimensions do not match the authoritative layout formulas".to_string(),
            ));
        }
        self.validate_allocations()
    }

    pub fn capacity_digest(shape: &SetupShape) -> Result<Sha256Digest, UniversalTauError> {
        canonical_digest(&CapacityIdentity {
            contract_version: 1,
            l_free: shape.l_free,
            m_i: shape.m_i,
            n: shape.n,
            s_max: shape.s_max,
        })
    }

    pub fn dusk_adaptor_layout(&self) -> Result<DuskAdaptorLayout, UniversalTauError> {
        DuskAdaptorLayout::new(self.n_max, self.x_grid_len - 1, self.alpha_x_max)
            .map_err(UniversalTauError::Serialization)
    }

    fn validate_allocations(&self) -> Result<(), UniversalTauError> {
        let checked = [
            self.x_grid_len.checked_mul(self.y_grid_len),
            3usize
                .checked_mul(self.n)
                .and_then(|v| v.checked_mul(self.s)),
            self.m_i.checked_mul(self.s),
            self.alpha_max
                .checked_mul(self.alpha_x_max.checked_add(1).ok_or_else(|| {
                    UniversalTauError::InvalidLayout("alpha-X length overflow".to_string())
                })?),
            self.alpha_max
                .checked_mul(self.alpha_y_max.checked_add(1).ok_or_else(|| {
                    UniversalTauError::InvalidLayout("alpha-Y length overflow".to_string())
                })?),
        ];
        if checked.iter().any(Option::is_none) {
            return Err(UniversalTauError::InvalidLayout(
                "point-family allocation overflow".to_string(),
            ));
        }
        Ok(())
    }
}

fn canonical_digest(value: &impl Serialize) -> Result<Sha256Digest, UniversalTauError> {
    serde_json::to_vec(value)
        .map(|bytes| Sha256Digest::from_bytes(&bytes))
        .map_err(|error| UniversalTauError::InvalidLayout(error.to_string()))
}

#[derive(Clone, Debug, PartialEq)]
pub struct UniversalTauPoints {
    pub g1: G1serde,
    pub g2: G2serde,
    pub alpha_g1: Vec<G1serde>,
    pub alpha_g2: Vec<G2serde>,
    pub x_g1: Vec<G1serde>,
    pub x_g2: Vec<G2serde>,
    pub y_g1: Vec<G1serde>,
    pub y_g2: Vec<G2serde>,
    pub alpha_x_g1: Vec<G1serde>,
    pub alpha_y_g1: Vec<G1serde>,
    pub xy_g1: Vec<G1serde>,
    pub alpha_xy_abc_g1: Vec<G1serde>,
    pub alpha4_xy_k_g1: Vec<G1serde>,
}

#[derive(Clone, Debug)]
pub struct UniversalTauArtifact {
    pub layout: MonomialLayout,
    pub points: UniversalTauPoints,
    pub state: CeremonyState,
}

impl UniversalTauArtifact {
    pub fn initialize_native(
        ceremony_id: impl Into<String>,
        shape: &SetupShape,
    ) -> Result<Self, UniversalTauError> {
        let layout = MonomialLayout::derive(shape)?;
        let capacity_digest = MonomialLayout::capacity_digest(shape)?;
        let layout_digest = layout.digest()?;
        let g1 = icicle_g1_generator();
        let g2 = icicle_g2_generator();
        let points = UniversalTauPoints::filled(&layout, g1, g2)?;
        points.validate_native_genesis(&layout)?;
        let payload = points.protocol_payload(&layout)?;
        let state = CeremonyState::new_initial_phase1(
            ceremony_id,
            ContributionProfile::NativeAlphaXY,
            capacity_digest,
            layout_digest,
            SourceProvenance::Native,
            payload,
        )?;
        Ok(Self {
            layout,
            points,
            state,
        })
    }

    pub fn prepare_from_adapted_tau(
        ceremony_id: impl Into<String>,
        shape: &SetupShape,
        adapted: &DuskAdaptedAlphaXBasis,
    ) -> Result<Self, UniversalTauError> {
        Self::prepare_from_adapted_basis(ceremony_id, shape, adapted.manifest(), adapted)
    }

    fn prepare_from_adapted_basis(
        ceremony_id: impl Into<String>,
        shape: &SetupShape,
        manifest: &AdaptedTau,
        adapted: &impl AlphaXBasis,
    ) -> Result<Self, UniversalTauError> {
        let layout = MonomialLayout::derive(shape)?;
        let capacity_digest = MonomialLayout::capacity_digest(shape)?;
        let layout_digest = layout.digest()?;
        if manifest.capacity_digest != capacity_digest || manifest.layout_digest != layout_digest {
            return Err(UniversalTauError::AdaptedIdentityMismatch);
        }
        if manifest.mapping.tokamak_n != layout.n_max as u64
            || manifest.mapping.alpha_max != layout.alpha_max as u64
            || manifest.mapping.x_max + 1 != layout.x_grid_len as u64
            || manifest.mapping.alpha_x_max != layout.alpha_x_max as u64
        {
            return Err(UniversalTauError::AdaptedMappingMismatch);
        }
        let points = UniversalTauPoints::from_adapted(&layout, adapted)?;
        points.validate_dusk_prepared(&layout)?;
        let payload = points.protocol_payload(&layout)?;
        let state = CeremonyState::new_initial_phase1(
            ceremony_id,
            ContributionProfile::DuskY,
            capacity_digest,
            layout_digest,
            SourceProvenance::DuskAdapted {
                adapted_tau_sha256: manifest.digest()?,
            },
            payload,
        )?;
        Ok(Self {
            layout,
            points,
            state,
        })
    }
}

impl UniversalTauPoints {
    fn filled(
        layout: &MonomialLayout,
        g1: G1serde,
        g2: G2serde,
    ) -> Result<Self, UniversalTauError> {
        Ok(Self {
            g1,
            g2,
            alpha_g1: vec![g1; layout.alpha_max + 1],
            alpha_g2: vec![g2; layout.alpha_max + 1],
            x_g1: vec![g1; layout.x_grid_len],
            x_g2: vec![g2; 2],
            y_g1: vec![g1; layout.alpha_y_max + 1],
            y_g2: vec![g2; 2],
            alpha_x_g1: vec![g1; checked_len(layout.alpha_max, layout.alpha_x_max + 1)?],
            alpha_y_g1: vec![g1; checked_len(layout.alpha_max, layout.alpha_y_max + 1)?],
            xy_g1: vec![g1; checked_len(layout.x_grid_len, layout.y_grid_len)?],
            alpha_xy_abc_g1: vec![g1; checked_len3(3, layout.n, layout.s)?],
            alpha4_xy_k_g1: vec![g1; checked_len(layout.m_i, layout.s)?],
        })
    }

    fn from_adapted(
        layout: &MonomialLayout,
        adapted: &impl AlphaXBasis,
    ) -> Result<Self, UniversalTauError> {
        let g1 = adapted.g1();
        let g2 = adapted.g2();
        let mut points = Self::filled(layout, g1, g2)?;
        points.alpha_g1 = (0..=layout.alpha_max)
            .map(|k| adapted.alphax_g1(k, 0))
            .collect();
        points.alpha_g2[0] = g2;
        for k in 1..=layout.alpha_max {
            points.alpha_g2[k] = adapted.alpha_g2(k);
        }
        points.x_g1 = adapted
            .x_g1_range(0, layout.x_grid_len - 1)
            .into_iter()
            .map(G1serde)
            .collect();
        points.x_g2 = vec![g2, adapted.x_g2(1)];
        for k in 1..=layout.alpha_max {
            for a in 0..=layout.alpha_x_max {
                points.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1) + a] = adapted.alphax_g1(k, a);
            }
        }
        for k in 1..=layout.alpha_max {
            for b in 0..=layout.alpha_y_max {
                points.alpha_y_g1[(k - 1) * (layout.alpha_y_max + 1) + b] = points.alpha_g1[k];
            }
        }
        for a in 0..layout.x_grid_len {
            for b in 0..layout.y_grid_len {
                points.xy_g1[a * layout.y_grid_len + b] = points.x_g1[a];
            }
        }
        for k in 1..=3 {
            for a in 0..layout.n {
                let base = adapted.alphax_g1(k, a);
                for b in 0..layout.s {
                    points.alpha_xy_abc_g1[((k - 1) * layout.n + a) * layout.s + b] = base;
                }
            }
        }
        for a in 0..layout.m_i {
            let base = adapted.alphax_g1(4, a);
            for b in 0..layout.s {
                points.alpha4_xy_k_g1[a * layout.s + b] = base;
            }
        }
        Ok(points)
    }

    pub fn validate_shapes(&self, layout: &MonomialLayout) -> Result<(), UniversalTauError> {
        let expected = [
            ("alpha_g1", self.alpha_g1.len(), layout.alpha_max + 1),
            ("alpha_g2", self.alpha_g2.len(), layout.alpha_max + 1),
            ("x_g1", self.x_g1.len(), layout.x_grid_len),
            ("x_g2", self.x_g2.len(), 2),
            ("y_g1", self.y_g1.len(), layout.alpha_y_max + 1),
            ("y_g2", self.y_g2.len(), 2),
            (
                "alpha_x_g1",
                self.alpha_x_g1.len(),
                checked_len(layout.alpha_max, layout.alpha_x_max + 1)?,
            ),
            (
                "alpha_y_g1",
                self.alpha_y_g1.len(),
                checked_len(layout.alpha_max, layout.alpha_y_max + 1)?,
            ),
            (
                "xy_g1",
                self.xy_g1.len(),
                checked_len(layout.x_grid_len, layout.y_grid_len)?,
            ),
            (
                "alpha_xy_abc_g1",
                self.alpha_xy_abc_g1.len(),
                checked_len3(3, layout.n, layout.s)?,
            ),
            (
                "alpha4_xy_k_g1",
                self.alpha4_xy_k_g1.len(),
                checked_len(layout.m_i, layout.s)?,
            ),
        ];
        for (family, actual, required) in expected {
            if actual != required {
                return Err(UniversalTauError::InvalidPayload(format!(
                    "{family} has {actual} points; expected {required}"
                )));
            }
        }
        if self.g1 == G1serde::zero()
            || self.g2 == G2serde::zero()
            || self.all_g1_points().any(|point| point == G1serde::zero())
            || self.alpha_g2.iter().any(|point| *point == G2serde::zero())
            || self.x_g2.iter().any(|point| *point == G2serde::zero())
            || self.y_g2.iter().any(|point| *point == G2serde::zero())
            || self.alpha_g1[0] != self.g1
            || self.alpha_g2[0] != self.g2
            || self.x_g1[0] != self.g1
            || self.x_g2[0] != self.g2
            || self.y_g1[0] != self.g1
            || self.y_g2[0] != self.g2
        {
            return Err(UniversalTauError::InvalidPayload(
                "universal tau contains an inconsistent generator boundary or point at infinity"
                    .to_string(),
            ));
        }
        Ok(())
    }

    fn validate_native_genesis(&self, layout: &MonomialLayout) -> Result<(), UniversalTauError> {
        self.validate_shapes(layout)?;
        if self.all_g1_points().any(|point| point != self.g1)
            || self.alpha_g2.iter().any(|point| *point != self.g2)
            || self.x_g2.iter().any(|point| *point != self.g2)
            || self.y_g2.iter().any(|point| *point != self.g2)
        {
            return Err(UniversalTauError::InvalidPayload(
                "native genesis must encode conceptual alpha = x = y = 1".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_dusk_prepared(&self, layout: &MonomialLayout) -> Result<(), UniversalTauError> {
        self.validate_shapes(layout)?;
        if self.y_g1.iter().any(|point| *point != self.g1)
            || self.y_g2.iter().any(|point| *point != self.g2)
        {
            return Err(UniversalTauError::InvalidPayload(
                "Dusk preparation must encode conceptual y = 1".to_string(),
            ));
        }
        for k in 1..=layout.alpha_max {
            if self.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1)] != self.alpha_g1[k]
                || self.alpha_y_g1[(k - 1) * (layout.alpha_y_max + 1)] != self.alpha_g1[k]
            {
                return Err(UniversalTauError::InvalidPayload(
                    "alpha mixed-family boundary mismatch".to_string(),
                ));
            }
            for b in 0..=layout.alpha_y_max {
                if self.alpha_y_g1[(k - 1) * (layout.alpha_y_max + 1) + b] != self.alpha_g1[k] {
                    return Err(UniversalTauError::InvalidPayload(
                        "alpha-Y slice is inconsistent with conceptual y = 1".to_string(),
                    ));
                }
            }
        }
        for a in 0..layout.x_grid_len {
            if self.xy_g1[a * layout.y_grid_len] != self.x_g1[a] {
                return Err(UniversalTauError::InvalidPayload(
                    "XY b=0 slice differs from X basis".to_string(),
                ));
            }
            for b in 0..layout.y_grid_len {
                if self.xy_g1[a * layout.y_grid_len + b] != self.x_g1[a] {
                    return Err(UniversalTauError::InvalidPayload(
                        "XY slice is inconsistent with conceptual y = 1".to_string(),
                    ));
                }
            }
        }
        for k in 1..=3 {
            for a in 0..layout.n {
                let mixed = self.alpha_xy_abc_g1[((k - 1) * layout.n + a) * layout.s];
                let alpha_x = self.alpha_x_g1[(k - 1) * (layout.alpha_x_max + 1) + a];
                if mixed != alpha_x {
                    return Err(UniversalTauError::InvalidPayload(
                        "alphaXY ABC b=0 slice differs from alpha-X basis".to_string(),
                    ));
                }
                for b in 0..layout.s {
                    if self.alpha_xy_abc_g1[((k - 1) * layout.n + a) * layout.s + b] != alpha_x {
                        return Err(UniversalTauError::InvalidPayload(
                            "alphaXY ABC slice is inconsistent with conceptual y = 1".to_string(),
                        ));
                    }
                }
            }
        }
        for a in 0..layout.m_i {
            let mixed = self.alpha4_xy_k_g1[a * layout.s];
            let alpha_x = self.alpha_x_g1[3 * (layout.alpha_x_max + 1) + a];
            if mixed != alpha_x {
                return Err(UniversalTauError::InvalidPayload(
                    "alpha4XY K b=0 slice differs from alpha-X basis".to_string(),
                ));
            }
            for b in 0..layout.s {
                if self.alpha4_xy_k_g1[a * layout.s + b] != alpha_x {
                    return Err(UniversalTauError::InvalidPayload(
                        "alpha4XY K slice is inconsistent with conceptual y = 1".to_string(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn all_g1_points(&self) -> impl Iterator<Item = G1serde> + '_ {
        std::iter::once(self.g1)
            .chain(self.alpha_g1.iter().copied())
            .chain(self.x_g1.iter().copied())
            .chain(self.y_g1.iter().copied())
            .chain(self.alpha_x_g1.iter().copied())
            .chain(self.alpha_y_g1.iter().copied())
            .chain(self.xy_g1.iter().copied())
            .chain(self.alpha_xy_abc_g1.iter().copied())
            .chain(self.alpha4_xy_k_g1.iter().copied())
    }

    pub fn protocol_payload(
        &self,
        layout: &MonomialLayout,
    ) -> Result<UniversalTau, UniversalTauError> {
        self.validate_shapes(layout)?;
        let mut chunks = Vec::new();
        push_g1_1d(&mut chunks, "generator", &[self.g1])?;
        push_g2_1d(&mut chunks, "generator", &[self.g2])?;
        push_g1_1d(&mut chunks, "alpha", &self.alpha_g1)?;
        push_g2_1d(&mut chunks, "alpha", &self.alpha_g2)?;
        push_g1_1d(&mut chunks, "x", &self.x_g1)?;
        push_g2_1d(&mut chunks, "x", &self.x_g2)?;
        push_g1_1d(&mut chunks, "y", &self.y_g1)?;
        push_g2_1d(&mut chunks, "y", &self.y_g2)?;
        push_g1_rows(
            &mut chunks,
            "alphaX",
            &self.alpha_x_g1,
            layout.alpha_max,
            layout.alpha_x_max + 1,
        )?;
        push_g1_rows(
            &mut chunks,
            "alphaY",
            &self.alpha_y_g1,
            layout.alpha_max,
            layout.alpha_y_max + 1,
        )?;
        push_g1_rows(
            &mut chunks,
            "xy",
            &self.xy_g1,
            layout.x_grid_len,
            layout.y_grid_len,
        )?;
        push_g1_3d(
            &mut chunks,
            "alphaXYAbc",
            &self.alpha_xy_abc_g1,
            3,
            layout.n,
            layout.s,
        )?;
        push_g1_rows(
            &mut chunks,
            "alpha4XYK",
            &self.alpha4_xy_k_g1,
            layout.m_i,
            layout.s,
        )?;
        Ok(UniversalTau { chunks })
    }
}

fn checked_len(a: usize, b: usize) -> Result<usize, UniversalTauError> {
    a.checked_mul(b)
        .ok_or_else(|| UniversalTauError::InvalidLayout("family length overflow".to_string()))
}

fn checked_len3(a: usize, b: usize, c: usize) -> Result<usize, UniversalTauError> {
    checked_len(a, b)?.checked_mul(c).ok_or_else(|| {
        UniversalTauError::InvalidLayout("three-dimensional family length overflow".to_string())
    })
}

fn push_g1_1d(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G1serde],
) -> Result<(), UniversalTauError> {
    for start in (0..points.len()).step_by(POINTS_PER_CHUNK) {
        let end = (start + POINTS_PER_CHUNK).min(points.len());
        chunks.push(g1_descriptor(
            family,
            vec![end - start],
            vec![start],
            &points[start..end],
        )?);
    }
    Ok(())
}

fn push_g2_1d(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G2serde],
) -> Result<(), UniversalTauError> {
    for start in (0..points.len()).step_by(POINTS_PER_CHUNK) {
        let end = (start + POINTS_PER_CHUNK).min(points.len());
        chunks.push(g2_descriptor(
            family,
            vec![end - start],
            vec![start],
            &points[start..end],
        )?);
    }
    Ok(())
}

fn push_g1_rows(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G1serde],
    rows: usize,
    columns: usize,
) -> Result<(), UniversalTauError> {
    let rows_per_chunk = (POINTS_PER_CHUNK / columns).max(1);
    if columns <= POINTS_PER_CHUNK {
        for row_start in (0..rows).step_by(rows_per_chunk) {
            let row_end = (row_start + rows_per_chunk).min(rows);
            chunks.push(g1_descriptor(
                family,
                vec![row_end - row_start, columns],
                vec![row_start, 0],
                &points[row_start * columns..row_end * columns],
            )?);
        }
    } else {
        for row in 0..rows {
            for column_start in (0..columns).step_by(POINTS_PER_CHUNK) {
                let column_end = (column_start + POINTS_PER_CHUNK).min(columns);
                chunks.push(g1_descriptor(
                    family,
                    vec![1, column_end - column_start],
                    vec![row, column_start],
                    &points[row * columns + column_start..row * columns + column_end],
                )?);
            }
        }
    }
    Ok(())
}

fn push_g1_3d(
    chunks: &mut Vec<PointChunkDescriptor>,
    family: &str,
    points: &[G1serde],
    planes: usize,
    rows: usize,
    columns: usize,
) -> Result<(), UniversalTauError> {
    let rows_per_chunk = (POINTS_PER_CHUNK / columns).max(1);
    for plane in 0..planes {
        if columns <= POINTS_PER_CHUNK {
            for row_start in (0..rows).step_by(rows_per_chunk) {
                let row_end = (row_start + rows_per_chunk).min(rows);
                let start = (plane * rows + row_start) * columns;
                let end = (plane * rows + row_end) * columns;
                chunks.push(g1_descriptor(
                    family,
                    vec![1, row_end - row_start, columns],
                    vec![plane, row_start, 0],
                    &points[start..end],
                )?);
            }
        } else {
            for row in 0..rows {
                for column_start in (0..columns).step_by(POINTS_PER_CHUNK) {
                    let column_end = (column_start + POINTS_PER_CHUNK).min(columns);
                    let start = (plane * rows + row) * columns + column_start;
                    let end = (plane * rows + row) * columns + column_end;
                    chunks.push(g1_descriptor(
                        family,
                        vec![1, 1, column_end - column_start],
                        vec![plane, row, column_start],
                        &points[start..end],
                    )?);
                }
            }
        }
    }
    Ok(())
}

fn g1_descriptor(
    family: &str,
    shape: Vec<usize>,
    start_indices: Vec<usize>,
    points: &[G1serde],
) -> Result<PointChunkDescriptor, UniversalTauError> {
    let bytes = points
        .iter()
        .flat_map(|point| serialize_g1_affine(&point.0, Compress::Yes).into_vec())
        .collect::<Vec<_>>();
    descriptor(family, CurveGroup::G1, shape, start_indices, &bytes)
}

fn g2_descriptor(
    family: &str,
    shape: Vec<usize>,
    start_indices: Vec<usize>,
    points: &[G2serde],
) -> Result<PointChunkDescriptor, UniversalTauError> {
    let bytes = points
        .iter()
        .flat_map(|point| serialize_g2_affine(&point.0, Compress::Yes).into_vec())
        .collect::<Vec<_>>();
    descriptor(family, CurveGroup::G2, shape, start_indices, &bytes)
}

fn descriptor(
    family: &str,
    group: CurveGroup,
    shape: Vec<usize>,
    start_indices: Vec<usize>,
    bytes: &[u8],
) -> Result<PointChunkDescriptor, UniversalTauError> {
    let shape = shape
        .into_iter()
        .map(u64::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| UniversalTauError::InvalidLayout("chunk shape overflow".to_string()))?;
    let start_indices = start_indices
        .into_iter()
        .map(u64::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| UniversalTauError::InvalidLayout("chunk offset overflow".to_string()))?;
    PointChunkDescriptor::from_bytes(family, group, shape, start_indices, bytes)
        .map_err(UniversalTauError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{validate_state_selection, StateStatus};
    use crate::protocol::{DuskExponentMapping, PointChunkDescriptor};
    use icicle_bls12_381::curve::G1Affine;
    use libs::crs_provenance::DuskSourceProvenance;

    struct ConstantAlphaXBasis;

    impl AlphaXBasis for ConstantAlphaXBasis {
        fn g1(&self) -> G1serde {
            icicle_g1_generator()
        }

        fn g2(&self) -> G2serde {
            icicle_g2_generator()
        }

        fn alpha_g2(&self, _: usize) -> G2serde {
            self.g2()
        }

        fn x_g2(&self, _: usize) -> G2serde {
            self.g2()
        }

        fn x_g1_range(&self, exp_min: usize, exp_max: usize) -> Vec<G1Affine> {
            vec![self.g1().0; exp_max - exp_min + 1]
        }

        fn alphax_g1(&self, _: usize, _: usize) -> G1serde {
            self.g1()
        }
    }

    fn shape() -> SetupShape {
        SetupShape {
            l_free: 1,
            m_i: 2,
            n: 2,
            s_max: 2,
        }
    }

    #[test]
    fn layout_derivation_uses_the_contract_bounds_and_checked_shapes() {
        let layout = MonomialLayout::derive(&shape()).unwrap();
        assert_eq!(layout.x_grid_len, 4);
        assert_eq!(layout.y_grid_len, 4);
        assert_eq!(layout.alpha_x_max, 4);
        assert_eq!(layout.alpha_y_max, 4);
        assert_eq!(layout.alpha_max, 4);
        assert!(MonomialLayout::derive(&SetupShape {
            l_free: 1,
            m_i: 3,
            n: 2,
            s_max: 2,
        })
        .is_err());
    }

    #[test]
    fn native_genesis_has_the_complete_shape_and_is_not_selectable() {
        let artifact = UniversalTauArtifact::initialize_native("ceremony", &shape()).unwrap();
        assert_eq!(artifact.state.status, StateStatus::Genesis);
        assert!(artifact
            .points
            .validate_native_genesis(&artifact.layout)
            .is_ok());
        assert!(validate_state_selection(&artifact.state, &[]).is_err());
        let chunks = match &artifact.state.payload {
            crate::protocol::PhasePayload::Phase1(payload) => &payload.chunks,
            _ => panic!("native genesis must contain a Phase 1 payload"),
        };
        assert!(!chunks.is_empty());
    }

    fn adapted_manifest(shape: &SetupShape) -> AdaptedTau {
        let layout = MonomialLayout::derive(shape).unwrap();
        let bytes = serialize_g1_affine(&icicle_g1_generator().0, Compress::Yes);
        let chunk =
            PointChunkDescriptor::from_bytes("alpha", CurveGroup::G1, vec![1], vec![0], &bytes)
                .unwrap();
        AdaptedTau::new(
            DuskSourceProvenance {
                source_url: "https://example.invalid/dusk".to_string(),
                source_size_bytes: 1,
                raw_encoding: "compressed-response".to_string(),
                pinned_contribution: "0015".to_string(),
                pinned_readme_url: "https://example.invalid/readme".to_string(),
                pinned_drive_file_id: "drive".to_string(),
                expected_source_sha256: "1".repeat(64),
                actual_source_sha256: "1".repeat(64),
                auto_downloaded: false,
                downloaded_contribution: None,
                downloaded_readme_url: None,
                downloaded_drive_file_id: None,
                max_g1_exp_used: 20,
                max_g2_exp_used: 16,
                transcript_consistency_verified: true,
            },
            MonomialLayout::capacity_digest(shape).unwrap(),
            layout.digest().unwrap(),
            DuskExponentMapping {
                mapping_version: 1,
                tokamak_n: 2,
                alpha_max: 4,
                x_max: 3,
                alpha_x_max: 4,
                omega_stride: 4,
                max_source_g1_exponent: 20,
                max_source_g2_exponent: 16,
            },
            vec![chunk],
        )
        .unwrap()
    }

    #[test]
    fn dusk_preparation_is_deterministic_preserves_b_zero_and_is_not_selectable() {
        let shape = shape();
        let manifest = adapted_manifest(&shape);
        let first = UniversalTauArtifact::prepare_from_adapted_basis(
            "ceremony",
            &shape,
            &manifest,
            &ConstantAlphaXBasis,
        )
        .unwrap();
        let second = UniversalTauArtifact::prepare_from_adapted_basis(
            "ceremony",
            &shape,
            &manifest,
            &ConstantAlphaXBasis,
        )
        .unwrap();
        assert_eq!(first.state.status, StateStatus::Prepared);
        assert_eq!(first.points, second.points);
        assert_eq!(
            first.state.digest().unwrap(),
            second.state.digest().unwrap()
        );
        assert!(first.points.validate_dusk_prepared(&first.layout).is_ok());
        assert!(validate_state_selection(&first.state, &[]).is_err());
    }

    #[test]
    fn dusk_preparation_rejects_capacity_and_mapping_mismatches() {
        let shape = shape();
        let mut manifest = adapted_manifest(&shape);
        manifest.capacity_digest = Sha256Digest::from_bytes(b"wrong");
        assert!(UniversalTauArtifact::prepare_from_adapted_basis(
            "ceremony",
            &shape,
            &manifest,
            &ConstantAlphaXBasis,
        )
        .is_err());

        let mut manifest = adapted_manifest(&shape);
        manifest.mapping.x_max = 4;
        manifest.mapping.max_source_g1_exponent = 20;
        assert!(UniversalTauArtifact::prepare_from_adapted_basis(
            "ceremony",
            &shape,
            &manifest,
            &ConstantAlphaXBasis,
        )
        .is_err());
    }
}
