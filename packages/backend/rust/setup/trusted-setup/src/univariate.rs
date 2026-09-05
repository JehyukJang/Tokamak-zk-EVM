//! Private U18 construction entry point for the migrated trusted setup.
//!
//! This intentionally has no artifact writer. PM0-B is responsible for adding
//! the U20/U21 queries and the only serializable new-protocol CRS format.

use icicle_bls12_381::curve::{G1Affine, G2Affine};
use libs::frontend_artifacts::SetupParams;
use libs::univariate_crs::{
    UnivariateCrsError, UnivariateCrsFoundation, UnivariateCrsShape, UnivariateTrapdoor,
};

pub(crate) fn build_u18_foundation(
    setup_params: &SetupParams,
    trapdoor: &UnivariateTrapdoor,
    g1: G1Affine,
    g2: G2Affine,
) -> Result<UnivariateCrsFoundation, UnivariateCrsError> {
    let shape = UnivariateCrsShape::from_setup_params(setup_params)?;
    UnivariateCrsFoundation::generate(shape, trapdoor, g1, g2)
}

#[cfg(test)]
mod tests {
    use super::build_u18_foundation;
    use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg};
    use icicle_core::curve::Curve;
    use libs::frontend_artifacts::SetupParams;
    use libs::univariate_crs::{UnivariateCrsShape, UnivariateTrapdoor};

    fn small_setup_params() -> SetupParams {
        SetupParams {
            l_free: 0,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 4,
            n: 2,
            s_D: 2,
            s_max: 2,
        }
    }

    #[test]
    fn trusted_setup_private_path_constructs_u18_only() {
        let params = small_setup_params();
        let shape = UnivariateCrsShape::from_setup_params(&params)
            .expect("small setup parameters must define a univariate CRS shape");
        let trapdoor = UnivariateTrapdoor::sample(&shape)
            .expect("a valid univariate trapdoor must be sampleable");
        let foundation = build_u18_foundation(
            &params,
            &trapdoor,
            CurveCfg::generate_random_affine_points(1)[0],
            G2CurveCfg::generate_random_affine_points(1)[0],
        )
        .expect("trusted setup must construct the private U18 foundation");

        assert_eq!(foundation.tau_powers_g1.len(), shape.degree_bound + 1);
    }
}
