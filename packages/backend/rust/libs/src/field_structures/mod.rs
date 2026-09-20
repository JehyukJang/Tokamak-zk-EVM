//! Scalar wrappers retained by the current binary proof/transcript boundary.

use icicle_bls12_381::curve::{ScalarCfg, ScalarField};
use icicle_core::traits::{FieldImpl, GenerateRandom};

/// Setup-only trapdoors. The current trusted setup consumes `x` and `alpha`;
/// the other independently sampled scalars remain part of the established
/// setup sampler interface until its callers are simplified together.
pub struct Tau {
    pub x: ScalarField,
    pub y: ScalarField,
    pub alpha: ScalarField,
    pub gamma: ScalarField,
    pub delta: ScalarField,
    pub eta: ScalarField,
}

impl Tau {
    pub fn gen() -> Self {
        let sample = || ScalarCfg::generate_random(1)[0];
        Self { x: sample(), y: sample(), alpha: sample(), gamma: sample(), delta: sample(), eta: sample() }
    }

    pub fn gen_fixed() -> Self {
        Self {
            x: ScalarField::from_hex("0x7234cd9b97845e0125e84ae3ae81354e004558d8c82a83425652bc7b9ed49f7d"),
            y: ScalarField::from_hex("0x6ed0eea55cbeeebdc7a41033ebd196ffecc1806fdbc13a8d41b8f1aa273a4037"),
            alpha: ScalarField::from_hex("0x7234cd9b97845e0125e84ae3ae81354e004558d8c82a83425652bc7b9ed49f7d"),
            gamma: ScalarField::from_hex("0x088dfe3d1b76775ec267d6d0e27b753ec904c76e0bc32ca8223dc2ae1a0ac6b4"),
            delta: ScalarField::from_hex("0x04b8ce26374c547d8722ac51f5ed1e0f9cb891c332c69c865d96af150189a818"),
            eta: ScalarField::from_hex("0x52eb2aeb35b72b94a19ea232e984850f2cda5542fdc10368955d8ac6274f8579"),
        }
    }
}

#[derive(Clone, Debug, Copy, PartialEq)]
pub struct FieldSerde(pub ScalarField);
