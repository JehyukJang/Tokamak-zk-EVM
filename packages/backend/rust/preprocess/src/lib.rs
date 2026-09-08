// Preprocess expressions retain the proving protocol's mathematical notation.
#![allow(non_snake_case)]

use libs::cli::CliDiagnostic;
use libs::crs_artifacts::{ArchivedPartialSigma1RkyvExt, ArchivedSigmaPreprocessRkyv};
use libs::errors::{ArtifactError, CrsError, DeviceError};
use libs::frontend_artifacts::{Instance, Permutation, SetupParams};
use libs::proof_protocol::Preprocess;
use libs::univariate_crs::{UnivariateCrs, UnivariateCrsError, UnivariateCrsShape};
use libs::univariate_preprocess::UnivariatePreprocess;
use libs::univariate_relation::{
    connection_permutation_polynomial, placement_selector_polynomial, UnivariateRelationError,
};
use libs::utils::{
    init_ntt_domain, prover_verifier_ntt_domain_size, setup_shape, validate_setup_shape,
};
use std::path::PathBuf;
use thiserror::Error;

pub struct PreprocessInputPaths<'a> {
    pub qap_path: &'a str,
    pub synthesizer_path: &'a str,
    pub setup_path: &'a str,
    pub output_path: &'a str,
}

#[derive(Debug, Error)]
pub enum PreprocessError {
    #[error(transparent)]
    Artifact(#[from] ArtifactError),
    #[error(transparent)]
    Crs(#[from] CrsError),
    #[error(transparent)]
    Device(#[from] DeviceError),
    #[error(transparent)]
    UnivariateCrs(#[from] UnivariateCrsError),
    #[error(transparent)]
    UnivariateRelation(#[from] UnivariateRelationError),
    #[error("univariate CRS schema or shape does not match the selected subcircuit library")]
    UnivariateCrsMismatch,
    #[error("failed to write preprocess output at {}: {source}", path.display())]
    WriteOutput {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Computes U21c's two circuit-specific commitments directly from the
/// selector and connection permutation.  No legacy bivariate polynomial,
/// public-instance commitment, or preprocessing digest is involved.
pub fn generate_univariate_preprocess(
    crs: &UnivariateCrs,
    selector: &[Option<usize>],
    permutation: &[Permutation],
    setup_params: &SetupParams,
) -> Result<UnivariatePreprocess, PreprocessError> {
    let expected_shape = UnivariateCrsShape::from_setup_params(setup_params)?;
    if crs.foundation.schema_id != libs::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID
        || !crs.foundation.shape.admits_setup(&expected_shape)
    {
        return Err(PreprocessError::UnivariateCrsMismatch);
    }

    let s_kappa = placement_selector_polynomial(&expected_shape, setup_params, selector)?;
    let s_c = connection_permutation_polynomial(&expected_shape, setup_params, permutation)?;
    Ok(UnivariatePreprocess::new(
        crs.commit_strided_polynomial(&s_kappa)?,
        crs.commit_dense_polynomial(&s_c.coefficients)?,
    ))
}

impl CliDiagnostic for PreprocessError {
    fn hint(&self) -> &'static str {
        match self {
            Self::Artifact(_) => {
                "Regenerate the frontend artifacts and provide the matching synthesizer directory."
            }
            Self::Crs(_) => {
                "Use a CRS whose compatible backend version matches the selected subcircuit library, or use the explicit local development bypass only for local testing."
            }
            Self::Device(_) => "Check the ICICLE backend installation and the selected device.",
            Self::UnivariateCrs(_) | Self::UnivariateCrsMismatch => {
                "Use a complete univariate CRS generated for the selected subcircuit library."
            }
            Self::UnivariateRelation(_) => {
                "Regenerate selector and permutation artifacts for the selected subcircuit library."
            }
            Self::WriteOutput { .. } => {
                "Create or grant write access to the requested output directory, then retry."
            }
        }
    }
}

pub fn generate_preprocess(
    sigma: &ArchivedSigmaPreprocessRkyv,
    permutation_raw: &[Permutation],
    instance: &Instance,
    setup_params: &SetupParams,
) -> Result<Preprocess, String> {
    let shape = setup_shape(setup_params);
    validate_setup_shape(&shape);
    let m_i = shape.m_i;
    let s_max = shape.s_max;
    let ntt_domain_size = prover_verifier_ntt_domain_size(&shape);
    init_ntt_domain(ntt_domain_size);
    println!("Converting the permutation matrices into polynomials s^0 and s^1...");
    let (mut s0XY, mut s1XY) = Permutation::to_poly(permutation_raw, m_i, s_max)?;
    let s0 = sigma.sigma_1.encode_poly(&mut s0XY, setup_params);
    let s1 = sigma.sigma_1.encode_poly(&mut s1XY, setup_params);
    let O_pub_fix = sigma
        .sigma_1
        .encode_O_pub_fix(&instance.a_pub_function, setup_params)?;
    Ok(Preprocess { s0, s1, O_pub_fix })
}

#[cfg(test)]
mod tests {
    use super::generate_univariate_preprocess;
    use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg, ScalarField};
    use icicle_core::curve::Curve;
    use icicle_core::traits::{Arithmetic, FieldImpl};
    use libs::frontend_artifacts::SetupParams;
    use libs::group_structures::G1serde;
    use libs::univariate_crs::{
        UnivariateCrs, UnivariateCrsFoundation, UnivariateCrsShape, UnivariateTrapdoor,
    };
    use libs::univariate_preprocess::UnivariatePreprocess;
    use libs::univariate_relation::{
        connection_permutation_polynomial, placement_selector_polynomial,
    };

    #[test]
    fn commits_only_u21c_selector_and_permutation_polynomials() {
        let setup = SetupParams {
            l_free: 0,
            l: 1,
            l_user_out: 0,
            l_user: 0,
            l_D: 3,
            m_D: 3,
            n: 2,
            s_D: 1,
            s_max: 2,
        };
        let shape = UnivariateCrsShape::from_setup_params(&setup).unwrap();
        let mut tau = ScalarField::from_u32(2);
        while tau.pow(shape.arithmetic_domain_size) == ScalarField::one()
            || tau.pow(shape.connection_domain_size) == ScalarField::one()
        {
            tau = tau + ScalarField::one();
        }
        let trapdoor = UnivariateTrapdoor::new(
            &shape,
            tau,
            ScalarField::from_u32(3),
            ScalarField::from_u32(5),
            ScalarField::from_u32(7),
            ScalarField::from_u32(11),
            ScalarField::from_u32(13),
        )
        .unwrap();
        let foundation = UnivariateCrsFoundation::generate(
            shape.clone(),
            &trapdoor,
            CurveCfg::generate_random_affine_points(1)[0],
            G2CurveCfg::generate_random_affine_points(1)[0],
        )
        .unwrap();
        let crs = UnivariateCrs {
            foundation,
            gamma_inv_public_queries: Box::new([]),
            eta_inv_interface_queries: Box::new([]),
            delta_inv_internal_queries: Box::new([]),
            delta_inv_u_masking_queries: Box::new([]),
            delta_inv_v_masking_queries: Box::new([]),
            delta_inv_w_masking_queries: Box::new([]),
            delta_inv_b_masking_queries: Box::new([]),
            delta_g1: G1serde::zero(),
            eta_g1: G1serde::zero(),
        };
        let selector = [Some(0), None];
        let permutation = [];
        let actual = generate_univariate_preprocess(&crs, &selector, &permutation, &setup).unwrap();
        let expected = UnivariatePreprocess::new(
            crs.commit_strided_polynomial(
                &placement_selector_polynomial(&shape, &setup, &selector).unwrap(),
            )
            .unwrap(),
            crs.commit_dense_polynomial(
                &connection_permutation_polynomial(&shape, &setup, &permutation)
                    .unwrap()
                    .coefficients,
            )
            .unwrap(),
        );
        assert_eq!(actual, expected);
        assert!(actual.validates_protocol_schema());
    }
}
