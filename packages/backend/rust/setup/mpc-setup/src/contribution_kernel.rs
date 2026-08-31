use crate::conversions::{icicle_g1_generator, icicle_g2_generator};
use crate::protocol::{ContributionProfile, Sha256Digest, TrapdoorParameter};
use crate::utils::{check_pok, pok, same_ratio, RandomGenerator};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::traits::{Arithmetic, FieldImpl};
use libs::group_structures::{G1serde, G2serde};
use rayon::prelude::*;
use sha2::{Digest as _, Sha256};
use std::fmt;
use thiserror::Error;

const MAX_ZERO_SHARE_RETRIES: usize = 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum KernelError {
    #[error("missing share for {0:?}")]
    MissingShare(TrapdoorParameter),
    #[error("unexpected, duplicate, or reordered share for contribution profile")]
    InvalidShareSet,
    #[error("share for {0:?} must be nonzero")]
    ZeroShare(TrapdoorParameter),
    #[error("random source produced zero {MAX_ZERO_SHARE_RETRIES} consecutive times")]
    RandomSourceStuckAtZero,
    #[error("component {0:?} does not belong to the contribution profile")]
    ComponentOutsideProfile(FamilyComponent),
    #[error("family shape is empty, contains zero, overflows, or differs from point count")]
    InvalidFamilyShape,
    #[error("family exponent origins must have the same rank as its dimensions")]
    InvalidExponentOrigins,
    #[error("axis {axis} is outside family rank {rank}")]
    InvalidExponentAxis { axis: usize, rank: usize },
    #[error("secret exponent does not fit the supported u32 range")]
    ExponentOverflow,
    #[error("proof parameters or order do not match the contribution profile")]
    InvalidProofSet,
    #[error("proof of knowledge failed for {0:?}")]
    InvalidProof(TrapdoorParameter),
    #[error("G1/G2 contribution encodings disagree for {0:?}")]
    InconsistentContribution(TrapdoorParameter),
    #[error("candidate transition failed self-verification")]
    SelfVerificationFailed,
}

pub struct SecretShares {
    values: Vec<(TrapdoorParameter, ScalarField)>,
}

impl fmt::Debug for SecretShares {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecretShares")
            .field(
                "parameters",
                &self
                    .values
                    .iter()
                    .map(|(parameter, _)| parameter)
                    .collect::<Vec<_>>(),
            )
            .field("values", &"[REDACTED]")
            .finish()
    }
}

impl Drop for SecretShares {
    fn drop(&mut self) {
        for (_, value) in &mut self.values {
            *value = ScalarField::zero();
        }
    }
}

impl SecretShares {
    pub fn sample(
        profile: ContributionProfile,
        random: &mut RandomGenerator,
    ) -> Result<Self, KernelError> {
        let mut values = Vec::with_capacity(profile.parameters().len());
        for parameter in profile.parameters() {
            let mut selected = None;
            for _ in 0..MAX_ZERO_SHARE_RETRIES {
                let candidate = random.next_random();
                if candidate != ScalarField::zero() {
                    selected = Some(candidate);
                    break;
                }
            }
            let value = selected.ok_or(KernelError::RandomSourceStuckAtZero)?;
            values.push((*parameter, value));
        }
        Self::new(profile, values)
    }

    pub fn new(
        profile: ContributionProfile,
        values: Vec<(TrapdoorParameter, ScalarField)>,
    ) -> Result<Self, KernelError> {
        if values.len() != profile.parameters().len()
            || values
                .iter()
                .map(|(parameter, _)| parameter)
                .ne(profile.parameters().iter())
        {
            return Err(KernelError::InvalidShareSet);
        }
        for (parameter, value) in &values {
            if *value == ScalarField::zero() {
                return Err(KernelError::ZeroShare(*parameter));
            }
        }
        Ok(Self { values })
    }

    fn get(&self, parameter: TrapdoorParameter) -> Result<ScalarField, KernelError> {
        self.values
            .iter()
            .find_map(|(candidate, value)| (*candidate == parameter).then_some(*value))
            .ok_or(KernelError::MissingShare(parameter))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FamilyComponent {
    Alpha,
    X,
    Y,
    AlphaX,
    AlphaY,
    XY,
    AlphaXYAbc,
    Alpha4XYK,
    GammaDirect,
    GammaInverse,
    DeltaDirect,
    DeltaInverse,
    EtaDirect,
    EtaInverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExponentDirection {
    Positive,
    Inverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExponentSource {
    Fixed(u32),
    Axis(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretExponentRule {
    pub parameter: TrapdoorParameter,
    pub source: ExponentSource,
    pub direction: ExponentDirection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyUpdateRule {
    pub component: FamilyComponent,
    pub factors: Vec<SecretExponentRule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FamilyShape {
    pub dimensions: Vec<usize>,
    pub exponent_origins: Vec<u32>,
}

impl FamilyShape {
    pub fn new(dimensions: Vec<usize>, exponent_origins: Vec<u32>) -> Self {
        Self {
            dimensions,
            exponent_origins,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributionSpec {
    pub profile: ContributionProfile,
    pub families: Vec<FamilyUpdateRule>,
}

impl ContributionSpec {
    pub fn for_profile(profile: ContributionProfile) -> Self {
        use ExponentDirection::{Inverse, Positive};
        use ExponentSource::{Axis, Fixed};
        use FamilyComponent as FC;
        use TrapdoorParameter as TP;

        let factor = |parameter, source, direction| SecretExponentRule {
            parameter,
            source,
            direction,
        };
        let rule = |component, factors| FamilyUpdateRule { component, factors };

        let families = match profile {
            ContributionProfile::NativeAlphaXY => vec![
                rule(FC::Alpha, vec![factor(TP::Alpha, Axis(0), Positive)]),
                rule(FC::X, vec![factor(TP::X, Axis(0), Positive)]),
                rule(FC::Y, vec![factor(TP::Y, Axis(0), Positive)]),
                rule(
                    FC::AlphaX,
                    vec![
                        factor(TP::Alpha, Axis(0), Positive),
                        factor(TP::X, Axis(1), Positive),
                    ],
                ),
                rule(
                    FC::AlphaY,
                    vec![
                        factor(TP::Alpha, Axis(0), Positive),
                        factor(TP::Y, Axis(1), Positive),
                    ],
                ),
                rule(
                    FC::XY,
                    vec![
                        factor(TP::X, Axis(0), Positive),
                        factor(TP::Y, Axis(1), Positive),
                    ],
                ),
                rule(
                    FC::AlphaXYAbc,
                    vec![
                        factor(TP::Alpha, Axis(0), Positive),
                        factor(TP::X, Axis(1), Positive),
                        factor(TP::Y, Axis(2), Positive),
                    ],
                ),
                rule(
                    FC::Alpha4XYK,
                    vec![
                        factor(TP::Alpha, Fixed(4), Positive),
                        factor(TP::X, Axis(0), Positive),
                        factor(TP::Y, Axis(1), Positive),
                    ],
                ),
            ],
            ContributionProfile::DuskY => vec![
                rule(FC::Y, vec![factor(TP::Y, Axis(0), Positive)]),
                rule(FC::AlphaY, vec![factor(TP::Y, Axis(1), Positive)]),
                rule(FC::XY, vec![factor(TP::Y, Axis(1), Positive)]),
                rule(FC::AlphaXYAbc, vec![factor(TP::Y, Axis(2), Positive)]),
                rule(FC::Alpha4XYK, vec![factor(TP::Y, Axis(1), Positive)]),
            ],
            ContributionProfile::CircuitGammaDeltaEta => vec![
                rule(FC::GammaDirect, vec![factor(TP::Gamma, Fixed(1), Positive)]),
                rule(FC::GammaInverse, vec![factor(TP::Gamma, Fixed(1), Inverse)]),
                rule(FC::DeltaDirect, vec![factor(TP::Delta, Fixed(1), Positive)]),
                rule(FC::DeltaInverse, vec![factor(TP::Delta, Fixed(1), Inverse)]),
                rule(FC::EtaDirect, vec![factor(TP::Eta, Fixed(1), Positive)]),
                rule(FC::EtaInverse, vec![factor(TP::Eta, Fixed(1), Inverse)]),
            ],
        };
        Self { profile, families }
    }

    fn rule(&self, component: FamilyComponent) -> Result<&FamilyUpdateRule, KernelError> {
        self.families
            .iter()
            .find(|rule| rule.component == component)
            .ok_or(KernelError::ComponentOutsideProfile(component))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct KernelProof {
    pub parameter: TrapdoorParameter,
    pub contribution_g1: G1serde,
    pub contribution_g2: G2serde,
    pub proof_of_knowledge_g2: G2serde,
}

pub fn create_proofs(shares: &SecretShares, transcript: &[u8]) -> Vec<KernelProof> {
    let g1 = icicle_g1_generator();
    let g2 = icicle_g2_generator();
    shares
        .values
        .iter()
        .map(|(parameter, share)| {
            let parameter_transcript = proof_transcript(transcript, *parameter);
            KernelProof {
                parameter: *parameter,
                contribution_g1: g1 * *share,
                contribution_g2: g2 * *share,
                proof_of_knowledge_g2: pok(&g1, *share, &parameter_transcript),
            }
        })
        .collect()
}

pub fn verify_proofs(
    profile: ContributionProfile,
    proofs: &[KernelProof],
    transcript: &[u8],
) -> Result<(), KernelError> {
    if proofs.len() != profile.parameters().len()
        || proofs
            .iter()
            .map(|proof| &proof.parameter)
            .ne(profile.parameters().iter())
    {
        return Err(KernelError::InvalidProofSet);
    }
    let g1 = icicle_g1_generator();
    let g2 = icicle_g2_generator();
    for proof in proofs {
        let parameter_transcript = proof_transcript(transcript, proof.parameter);
        if !check_pok(
            &proof.contribution_g1,
            &g1,
            proof.proof_of_knowledge_g2,
            &parameter_transcript,
        ) {
            return Err(KernelError::InvalidProof(proof.parameter));
        }
        if !same_ratio(g1, proof.contribution_g1, g2, proof.contribution_g2) {
            return Err(KernelError::InconsistentContribution(proof.parameter));
        }
    }
    Ok(())
}

fn proof_transcript(base: &[u8], parameter: TrapdoorParameter) -> Vec<u8> {
    let label = match parameter {
        TrapdoorParameter::Alpha => b"alpha".as_slice(),
        TrapdoorParameter::X => b"x".as_slice(),
        TrapdoorParameter::Y => b"y".as_slice(),
        TrapdoorParameter::Gamma => b"gamma".as_slice(),
        TrapdoorParameter::Delta => b"delta".as_slice(),
        TrapdoorParameter::Eta => b"eta".as_slice(),
    };
    let mut transcript = Vec::with_capacity(base.len() + label.len() + 24);
    transcript.extend_from_slice(b"tokamak-mpc-proof-label-v1");
    transcript.extend_from_slice(&(base.len() as u64).to_le_bytes());
    transcript.extend_from_slice(base);
    transcript.extend_from_slice(&(label.len() as u64).to_le_bytes());
    transcript.extend_from_slice(label);
    transcript
}

pub fn scale_g1_family(
    spec: &ContributionSpec,
    component: FamilyComponent,
    shape: &FamilyShape,
    previous: &[G1serde],
    shares: &SecretShares,
) -> Result<Vec<G1serde>, KernelError> {
    let mut factors = family_factors(spec.rule(component)?, shape, previous.len(), shares)?;
    let current = previous
        .par_iter()
        .zip(factors.par_iter())
        .map(|(point, factor)| *point * *factor)
        .collect();
    factors.fill(ScalarField::zero());
    Ok(current)
}

pub fn scale_g2_family(
    spec: &ContributionSpec,
    component: FamilyComponent,
    shape: &FamilyShape,
    previous: &[G2serde],
    shares: &SecretShares,
) -> Result<Vec<G2serde>, KernelError> {
    let mut factors = family_factors(spec.rule(component)?, shape, previous.len(), shares)?;
    let current = previous
        .par_iter()
        .zip(factors.par_iter())
        .map(|(point, factor)| *point * *factor)
        .collect();
    factors.fill(ScalarField::zero());
    Ok(current)
}

#[derive(Debug)]
pub struct VerifiedTransition<T>(T);

impl<T> VerifiedTransition<T> {
    pub fn into_inner(self) -> T {
        self.0
    }
}

pub fn apply_and_self_verify<T>(
    build: impl FnOnce() -> Result<T, KernelError>,
    verify: impl FnOnce(&T) -> bool,
) -> Result<VerifiedTransition<T>, KernelError> {
    let candidate = build()?;
    if !verify(&candidate) {
        return Err(KernelError::SelfVerificationFailed);
    }
    Ok(VerifiedTransition(candidate))
}

pub fn verify_immutable_g1(previous: &[G1serde], current: &[G1serde]) -> bool {
    previous == current
}

pub fn verify_immutable_g2(previous: &[G2serde], current: &[G2serde]) -> bool {
    previous == current
}

pub fn batch_challenge(
    previous_state_digest: &Sha256Digest,
    current_state_digest: &Sha256Digest,
    receipt_domain: &[u8],
) -> ScalarField {
    let mut counter = 0u32;
    loop {
        let mut hasher = Sha256::new();
        hasher.update(b"tokamak-mpc-batch-challenge-v1");
        hasher.update(previous_state_digest.as_str().as_bytes());
        hasher.update(current_state_digest.as_str().as_bytes());
        hasher.update((receipt_domain.len() as u64).to_le_bytes());
        hasher.update(receipt_domain);
        hasher.update(counter.to_le_bytes());
        let candidate = ScalarField::from_bytes_le(&hasher.finalize());
        if candidate != ScalarField::zero() {
            return candidate;
        }
        counter = counter
            .checked_add(1)
            .expect("SHA-256 batch challenge counter cannot exhaust u32");
    }
}

fn family_factors(
    rule: &FamilyUpdateRule,
    shape: &FamilyShape,
    point_count: usize,
    shares: &SecretShares,
) -> Result<Vec<ScalarField>, KernelError> {
    if shape.dimensions.len() != shape.exponent_origins.len() {
        return Err(KernelError::InvalidExponentOrigins);
    }
    let expected_count = shape
        .dimensions
        .iter()
        .try_fold(1usize, |count, dimension| {
            if *dimension == 0 {
                return None;
            }
            count.checked_mul(*dimension)
        });
    if shape.dimensions.is_empty() || expected_count != Some(point_count) {
        return Err(KernelError::InvalidFamilyShape);
    }
    for factor in &rule.factors {
        if let ExponentSource::Axis(axis) = factor.source {
            if axis >= shape.dimensions.len() {
                return Err(KernelError::InvalidExponentAxis {
                    axis,
                    rank: shape.dimensions.len(),
                });
            }
        }
    }

    (0..point_count)
        .into_par_iter()
        .map(|flat_index| {
            let coordinates = coordinates(flat_index, &shape.dimensions);
            rule.factors
                .iter()
                .try_fold(ScalarField::one(), |combined, factor_rule| {
                    let exponent = match factor_rule.source {
                        ExponentSource::Fixed(exponent) => exponent,
                        ExponentSource::Axis(axis) => u32::try_from(coordinates[axis])
                            .ok()
                            .and_then(|coordinate| {
                                coordinate.checked_add(shape.exponent_origins[axis])
                            })
                            .ok_or(KernelError::ExponentOverflow)?,
                    };
                    let share = shares.get(factor_rule.parameter)?;
                    let base = match factor_rule.direction {
                        ExponentDirection::Positive => share,
                        ExponentDirection::Inverse => share.inv(),
                    };
                    Ok(combined * base.pow(exponent as usize))
                })
        })
        .collect()
}

fn coordinates(mut flat_index: usize, shape: &[usize]) -> Vec<usize> {
    let mut coordinates = vec![0; shape.len()];
    for axis in (0..shape.len()).rev() {
        coordinates[axis] = flat_index % shape[axis];
        flat_index /= shape[axis];
    }
    coordinates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shares(profile: ContributionProfile, values: &[u32]) -> Result<SecretShares, KernelError> {
        SecretShares::new(
            profile,
            profile
                .parameters()
                .iter()
                .zip(values.iter())
                .map(|(parameter, value)| (*parameter, ScalarField::from_u32(*value)))
                .collect(),
        )
    }

    fn shape(dimensions: &[usize], origins: &[u32]) -> FamilyShape {
        FamilyShape::new(dimensions.to_vec(), origins.to_vec())
    }

    #[test]
    fn native_profile_scales_three_axis_family() {
        let spec = ContributionSpec::for_profile(ContributionProfile::NativeAlphaXY);
        let shares = shares(ContributionProfile::NativeAlphaXY, &[2, 3, 5]).unwrap();
        let generator = icicle_g1_generator();
        let previous = vec![generator; 2 * 2 * 2];
        let current = scale_g1_family(
            &spec,
            FamilyComponent::AlphaXYAbc,
            &shape(&[2, 2, 2], &[1, 0, 0]),
            &previous,
            &shares,
        )
        .unwrap();
        assert_eq!(current[0], generator * ScalarField::from_u32(2));
        assert_eq!(
            current[7],
            generator * (ScalarField::from_u32(2).pow(2) * ScalarField::from_u32(3 * 5))
        );
    }

    #[test]
    fn dusk_profile_updates_y_axis_and_rejects_alpha_component() {
        let spec = ContributionSpec::for_profile(ContributionProfile::DuskY);
        let shares = shares(ContributionProfile::DuskY, &[7]).unwrap();
        let generator = icicle_g1_generator();
        let previous = vec![generator; 4];
        let current = scale_g1_family(
            &spec,
            FamilyComponent::XY,
            &shape(&[2, 2], &[0, 0]),
            &previous,
            &shares,
        )
        .unwrap();
        assert_eq!(current[0], generator);
        assert_eq!(current[1], generator * ScalarField::from_u32(7));
        assert_eq!(current[2], generator);
        assert_eq!(current[3], generator * ScalarField::from_u32(7));
        assert_eq!(
            scale_g1_family(
                &spec,
                FamilyComponent::Alpha,
                &shape(&[1], &[0]),
                &[generator],
                &shares,
            )
            .unwrap_err(),
            KernelError::ComponentOutsideProfile(FamilyComponent::Alpha)
        );
    }

    #[test]
    fn circuit_profile_applies_positive_and_inverse_shares() {
        let spec = ContributionSpec::for_profile(ContributionProfile::CircuitGammaDeltaEta);
        let shares = shares(ContributionProfile::CircuitGammaDeltaEta, &[2, 3, 5]).unwrap();
        let generator = icicle_g1_generator();
        let direct = scale_g1_family(
            &spec,
            FamilyComponent::DeltaDirect,
            &shape(&[1], &[0]),
            &[generator],
            &shares,
        )
        .unwrap();
        let inverse = scale_g1_family(
            &spec,
            FamilyComponent::DeltaInverse,
            &shape(&[1], &[0]),
            &[generator],
            &shares,
        )
        .unwrap();
        assert_eq!(direct[0], generator * ScalarField::from_u32(3));
        assert_eq!(inverse[0], generator * ScalarField::from_u32(3).inv());
    }

    #[test]
    fn rejects_zero_wrong_order_and_invalid_shapes() {
        assert_eq!(
            shares(ContributionProfile::DuskY, &[0]).unwrap_err(),
            KernelError::ZeroShare(TrapdoorParameter::Y)
        );
        assert_eq!(
            SecretShares::new(
                ContributionProfile::NativeAlphaXY,
                vec![
                    (TrapdoorParameter::X, ScalarField::one()),
                    (TrapdoorParameter::Alpha, ScalarField::one()),
                    (TrapdoorParameter::Y, ScalarField::one()),
                ],
            )
            .unwrap_err(),
            KernelError::InvalidShareSet
        );
        let spec = ContributionSpec::for_profile(ContributionProfile::DuskY);
        let shares = shares(ContributionProfile::DuskY, &[2]).unwrap();
        assert_eq!(
            scale_g1_family(
                &spec,
                FamilyComponent::Y,
                &shape(&[2], &[0]),
                &[icicle_g1_generator()],
                &shares,
            )
            .unwrap_err(),
            KernelError::InvalidFamilyShape
        );
    }

    #[test]
    fn profile_proofs_bind_transcript_and_both_groups() {
        let shares = shares(ContributionProfile::NativeAlphaXY, &[2, 3, 5]).unwrap();
        let proofs = create_proofs(&shares, b"previous/current state digests");
        verify_proofs(
            ContributionProfile::NativeAlphaXY,
            &proofs,
            b"previous/current state digests",
        )
        .unwrap();
        assert!(matches!(
            verify_proofs(
                ContributionProfile::NativeAlphaXY,
                &proofs,
                b"replayed against another state"
            ),
            Err(KernelError::InvalidProof(_))
        ));

        let mut inconsistent = proofs;
        inconsistent[0].contribution_g2 = icicle_g2_generator();
        assert_eq!(
            verify_proofs(
                ContributionProfile::NativeAlphaXY,
                &inconsistent,
                b"previous/current state digests"
            )
            .unwrap_err(),
            KernelError::InconsistentContribution(TrapdoorParameter::Alpha)
        );
    }

    #[test]
    fn batch_challenge_binds_both_states_and_receipt_domain() {
        let previous = Sha256Digest::from_bytes(b"previous");
        let current = Sha256Digest::from_bytes(b"current");
        let base = batch_challenge(&previous, &current, b"receipt");
        assert_ne!(
            base,
            batch_challenge(&Sha256Digest::from_bytes(b"other"), &current, b"receipt")
        );
        assert_ne!(
            base,
            batch_challenge(&previous, &Sha256Digest::from_bytes(b"other"), b"receipt")
        );
        assert_ne!(base, batch_challenge(&previous, &current, b"other receipt"));
    }

    #[test]
    fn immutable_verification_is_exact() {
        let point = icicle_g1_generator();
        assert!(verify_immutable_g1(&[point], &[point]));
        assert!(!verify_immutable_g1(
            &[point],
            &[point * ScalarField::from_u32(2)]
        ));
    }

    #[test]
    fn rejects_missing_exponent_origins_and_failed_self_verification() {
        let spec = ContributionSpec::for_profile(ContributionProfile::DuskY);
        let shares = shares(ContributionProfile::DuskY, &[2]).unwrap();
        assert_eq!(
            scale_g1_family(
                &spec,
                FamilyComponent::Y,
                &shape(&[1], &[]),
                &[icicle_g1_generator()],
                &shares,
            )
            .unwrap_err(),
            KernelError::InvalidExponentOrigins
        );
        assert_eq!(
            apply_and_self_verify(|| Ok(vec![1u8, 2]), |_| false).unwrap_err(),
            KernelError::SelfVerificationFailed
        );
        assert_eq!(
            apply_and_self_verify(|| Ok(vec![1u8, 2]), |value| value.len() == 2)
                .unwrap()
                .into_inner(),
            vec![1u8, 2]
        );
    }
}
