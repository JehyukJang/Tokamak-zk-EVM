use crate::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use crate::frontend_artifacts::public_wire_layout::PublicWireLayout;
use crate::frontend_artifacts::{HexString, PlacementVariables, SetupParams, SubcircuitInfo};
use crate::group_structures::{
    count_statement_nvar, encode_o_pub_fix_common, encode_o_pub_free_common,
    encode_statement_common, G1serde, G2serde, PartialSigma1, PartialSigma1Verify, Sigma, Sigma2,
    SigmaPreprocess, SigmaVerify,
};
#[cfg(feature = "timing")]
use crate::timing::{record as record_timing, SizeInfo};
use crate::vector_operations::resize;
use icicle_bls12_381::curve::{
    BaseField, G1Affine, G1Projective, G2Affine, G2BaseField, ScalarField,
};
use icicle_core::msm::{self, MSMConfig};
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::HostSlice;
use serde_json::to_writer_pretty;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, BufWriter};
use std::path::PathBuf;
#[cfg(feature = "timing")]
use std::time::Instant;

impl Sigma {
    pub fn sigma_verify(&self) -> SigmaVerify {
        let partial_sigma1_verify: PartialSigma1Verify = PartialSigma1Verify {
            x: self.sigma_1.x,
            y: self.sigma_1.y,
        };
        SigmaVerify {
            G: self.G,
            H: self.H,
            sigma_1: partial_sigma1_verify,
            sigma_2: self.sigma_2,
            lagrange_KL: self.lagrange_KL,
        }
    }

    pub fn sigma_preprocess(&self) -> SigmaPreprocess {
        let partial_sigma_1: PartialSigma1 = PartialSigma1 {
            xy_powers: self.sigma_1.xy_powers.clone(),
            gamma_inv_o_inst: self.sigma_1.gamma_inv_o_inst.clone(),
        };
        SigmaPreprocess {
            sigma_1: partial_sigma_1,
        }
    }

    /// Write verifier CRS into JSON
    pub fn write_into_json_for_verify(&self, abs_path: PathBuf) -> io::Result<()> {
        if let Some(parent) = abs_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = File::create(&abs_path)?;
        let writer = BufWriter::new(file);
        to_writer_pretty(writer, &self.sigma_verify())?;
        Ok(())
    }

    /// Write preprocess CRS into JSON
    pub fn write_into_json_for_preprocess(&self, abs_path: PathBuf) -> io::Result<()> {
        if let Some(parent) = abs_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = File::create(&abs_path)?;
        let writer = BufWriter::new(file);
        to_writer_pretty(writer, &self.sigma_preprocess())?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct FinalCrsDigests {
    pub combined_sigma_sha256: String,
    pub sigma_preprocess_sha256: String,
    pub sigma_verify_sha256: String,
}

pub fn write_final_crs_artifacts(
    output_dir: &PathBuf,
    sigma: &Sigma,
) -> io::Result<FinalCrsDigests> {
    fs::create_dir_all(output_dir)?;

    let sigma_rkyv = SigmaRkyv::from_sigma(sigma);
    let combined_sigma_bytes = rkyv::to_bytes::<_, 256>(&sigma_rkyv).map_err(io::Error::other)?;
    fs::write(
        output_dir.join("combined_sigma.rkyv"),
        combined_sigma_bytes.as_ref(),
    )?;

    let sigma_preprocess_rkyv = SigmaPreprocessRkyv::from_sigma(sigma);
    let sigma_preprocess_bytes =
        rkyv::to_bytes::<_, 256>(&sigma_preprocess_rkyv).map_err(io::Error::other)?;
    fs::write(
        output_dir.join("sigma_preprocess.rkyv"),
        sigma_preprocess_bytes.as_ref(),
    )?;

    let sigma_verify = sigma.sigma_verify();
    let sigma_verify_bytes = serde_json::to_vec_pretty(&sigma_verify).map_err(io::Error::other)?;
    fs::write(output_dir.join("sigma_verify.json"), &sigma_verify_bytes)?;

    Ok(FinalCrsDigests {
        combined_sigma_sha256: sha256_hex(combined_sigma_bytes.as_ref()),
        sigma_preprocess_sha256: sha256_hex(sigma_preprocess_bytes.as_ref()),
        sigma_verify_sha256: sha256_hex(&sigma_verify_bytes),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct G1SerdeRkyv {
    pub x: [u8; 48],
    pub y: [u8; 48],
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct G2SerdeRkyv {
    pub x: [u8; 96],
    pub y: [u8; 96],
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct SigmaRkyv {
    pub G: G1SerdeRkyv,
    pub H: G2SerdeRkyv,
    pub sigma_1: Sigma1Rkyv,
    pub sigma_2: Sigma2Rkyv,
    pub lagrange_KL: G1SerdeRkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct Sigma1Rkyv {
    pub xy_powers: Vec<G1SerdeRkyv>,
    pub x: G1SerdeRkyv,
    pub y: G1SerdeRkyv,
    pub delta: G1SerdeRkyv,
    pub eta: G1SerdeRkyv,
    pub gamma_inv_o_inst: Vec<G1SerdeRkyv>,
    pub eta_inv_li_o_inter_alpha4_kj: Vec<Vec<G1SerdeRkyv>>,
    pub delta_inv_li_o_prv: Vec<Vec<G1SerdeRkyv>>,
    pub delta_inv_alphak_xh_tx: Vec<Vec<G1SerdeRkyv>>,
    pub delta_inv_alpha4_xj_tx: Vec<G1SerdeRkyv>,
    pub delta_inv_alphak_yi_ty: Vec<Vec<G1SerdeRkyv>>,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct PartialSigma1Rkyv {
    pub xy_powers: Vec<G1SerdeRkyv>,
    pub gamma_inv_o_inst: Vec<G1SerdeRkyv>,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct SigmaPreprocessRkyv {
    pub sigma_1: PartialSigma1Rkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct PartialSigma1VerifyRkyv {
    pub x: G1SerdeRkyv,
    pub y: G1SerdeRkyv,
}

#[derive(Debug, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct SigmaVerifyRkyv {
    pub G: G1SerdeRkyv,
    pub H: G2SerdeRkyv,
    pub sigma_1: PartialSigma1VerifyRkyv,
    pub sigma_2: Sigma2Rkyv,
    pub lagrange_KL: G1SerdeRkyv,
}

#[derive(Debug, Clone, Copy, rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
#[archive(check_bytes)]
pub struct Sigma2Rkyv {
    pub alpha: G2SerdeRkyv,
    pub alpha2: G2SerdeRkyv,
    pub alpha3: G2SerdeRkyv,
    pub alpha4: G2SerdeRkyv,
    pub gamma: G2SerdeRkyv,
    pub delta: G2SerdeRkyv,
    pub eta: G2SerdeRkyv,
    pub x: G2SerdeRkyv,
    pub y: G2SerdeRkyv,
}

impl G1SerdeRkyv {
    pub fn from_g1serde(value: &G1serde) -> Self {
        let x_bytes: [u8; 48] = value
            .0
            .x
            .to_bytes_le()
            .try_into()
            .expect("G1 x bytes length");
        let y_bytes: [u8; 48] = value
            .0
            .y
            .to_bytes_le()
            .try_into()
            .expect("G1 y bytes length");
        Self {
            x: x_bytes,
            y: y_bytes,
        }
    }

    pub fn to_g1serde(&self) -> G1serde {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1serde(G1Affine::from_limbs(x_field, y_field))
    }

    pub fn to_g1_affine(&self) -> G1Affine {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1Affine::from_limbs(x_field, y_field)
    }
}

impl G2SerdeRkyv {
    pub fn from_g2serde(value: &G2serde) -> Self {
        let x_bytes: [u8; 96] = value
            .0
            .x
            .to_bytes_le()
            .try_into()
            .expect("G2 x bytes length");
        let y_bytes: [u8; 96] = value
            .0
            .y
            .to_bytes_le()
            .try_into()
            .expect("G2 y bytes length");
        Self {
            x: x_bytes,
            y: y_bytes,
        }
    }

    pub fn to_g2serde(&self) -> G2serde {
        let x_field = G2BaseField::from_bytes_le(&self.x).into();
        let y_field = G2BaseField::from_bytes_le(&self.y).into();
        G2serde(G2Affine::from_limbs(x_field, y_field))
    }
}

impl SigmaRkyv {
    pub fn from_sigma(sigma: &Sigma) -> Self {
        Self {
            G: G1SerdeRkyv::from_g1serde(&sigma.G),
            H: G2SerdeRkyv::from_g2serde(&sigma.H),
            sigma_1: Sigma1Rkyv::from_sigma(&sigma.sigma_1),
            sigma_2: Sigma2Rkyv::from_sigma(&sigma.sigma_2),
            lagrange_KL: G1SerdeRkyv::from_g1serde(&sigma.lagrange_KL),
        }
    }
}

impl SigmaVerifyRkyv {
    pub fn from_sigma(sigma: &Sigma) -> Self {
        Self {
            G: G1SerdeRkyv::from_g1serde(&sigma.G),
            H: G2SerdeRkyv::from_g2serde(&sigma.H),
            sigma_1: PartialSigma1VerifyRkyv {
                x: G1SerdeRkyv::from_g1serde(&sigma.sigma_1.x),
                y: G1SerdeRkyv::from_g1serde(&sigma.sigma_1.y),
            },
            sigma_2: Sigma2Rkyv::from_sigma(&sigma.sigma_2),
            lagrange_KL: G1SerdeRkyv::from_g1serde(&sigma.lagrange_KL),
        }
    }
}

impl SigmaPreprocessRkyv {
    pub fn from_sigma(sigma: &Sigma) -> Self {
        Self {
            sigma_1: PartialSigma1Rkyv::from_sigma(&sigma.sigma_1),
        }
    }
}

impl Sigma1Rkyv {
    fn from_sigma(sigma: &crate::group_structures::Sigma1) -> Self {
        let xy_powers = sigma
            .xy_powers
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let gamma_inv_o_inst = sigma
            .gamma_inv_o_inst
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let eta_inv_li_o_inter_alpha4_kj = sigma
            .eta_inv_li_o_inter_alpha4_kj
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();
        let delta_inv_li_o_prv = sigma
            .delta_inv_li_o_prv
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();
        let delta_inv_alphak_xh_tx = sigma
            .delta_inv_alphak_xh_tx
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();
        let delta_inv_alpha4_xj_tx = sigma
            .delta_inv_alpha4_xj_tx
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let delta_inv_alphak_yi_ty = sigma
            .delta_inv_alphak_yi_ty
            .iter()
            .map(|row| row.iter().map(G1SerdeRkyv::from_g1serde).collect())
            .collect();

        Self {
            xy_powers,
            x: G1SerdeRkyv::from_g1serde(&sigma.x),
            y: G1SerdeRkyv::from_g1serde(&sigma.y),
            delta: G1SerdeRkyv::from_g1serde(&sigma.delta),
            eta: G1SerdeRkyv::from_g1serde(&sigma.eta),
            gamma_inv_o_inst,
            eta_inv_li_o_inter_alpha4_kj,
            delta_inv_li_o_prv,
            delta_inv_alphak_xh_tx,
            delta_inv_alpha4_xj_tx,
            delta_inv_alphak_yi_ty,
        }
    }
}

impl PartialSigma1Rkyv {
    fn from_sigma(sigma: &crate::group_structures::Sigma1) -> Self {
        let xy_powers = sigma
            .xy_powers
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        let gamma_inv_o_inst = sigma
            .gamma_inv_o_inst
            .iter()
            .map(G1SerdeRkyv::from_g1serde)
            .collect();
        Self {
            xy_powers,
            gamma_inv_o_inst,
        }
    }
}

impl Sigma2Rkyv {
    fn from_sigma(sigma: &crate::group_structures::Sigma2) -> Self {
        Self {
            alpha: G2SerdeRkyv::from_g2serde(&sigma.alpha),
            alpha2: G2SerdeRkyv::from_g2serde(&sigma.alpha2),
            alpha3: G2SerdeRkyv::from_g2serde(&sigma.alpha3),
            alpha4: G2SerdeRkyv::from_g2serde(&sigma.alpha4),
            gamma: G2SerdeRkyv::from_g2serde(&sigma.gamma),
            delta: G2SerdeRkyv::from_g2serde(&sigma.delta),
            eta: G2SerdeRkyv::from_g2serde(&sigma.eta),
            x: G2SerdeRkyv::from_g2serde(&sigma.x),
            y: G2SerdeRkyv::from_g2serde(&sigma.y),
        }
    }
}

impl ArchivedG1SerdeRkyv {
    pub fn to_g1serde(&self) -> G1serde {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1serde(G1Affine::from_limbs(x_field, y_field))
    }

    pub fn to_g1_affine(&self) -> G1Affine {
        let x_field = BaseField::from_bytes_le(&self.x).into();
        let y_field = BaseField::from_bytes_le(&self.y).into();
        G1Affine::from_limbs(x_field, y_field)
    }
}

impl ArchivedG2SerdeRkyv {
    pub fn to_g2serde(&self) -> G2serde {
        let x_field = G2BaseField::from_bytes_le(&self.x).into();
        let y_field = G2BaseField::from_bytes_le(&self.y).into();
        G2serde(G2Affine::from_limbs(x_field, y_field))
    }
}

impl ArchivedSigma2Rkyv {
    pub fn to_sigma2(&self) -> Sigma2 {
        Sigma2 {
            alpha: self.alpha.to_g2serde(),
            alpha2: self.alpha2.to_g2serde(),
            alpha3: self.alpha3.to_g2serde(),
            alpha4: self.alpha4.to_g2serde(),
            gamma: self.gamma.to_g2serde(),
            delta: self.delta.to_g2serde(),
            eta: self.eta.to_g2serde(),
            x: self.x.to_g2serde(),
            y: self.y.to_g2serde(),
        }
    }
}

impl ArchivedSigmaVerifyRkyv {
    pub fn g(&self) -> G1serde {
        self.G.to_g1serde()
    }

    pub fn h(&self) -> G2serde {
        self.H.to_g2serde()
    }

    pub fn sigma1_x(&self) -> G1serde {
        self.sigma_1.x.to_g1serde()
    }

    pub fn sigma1_y(&self) -> G1serde {
        self.sigma_1.y.to_g1serde()
    }

    pub fn sigma2(&self) -> Sigma2 {
        self.sigma_2.to_sigma2()
    }

    pub fn lagrange_kl(&self) -> G1serde {
        self.lagrange_KL.to_g1serde()
    }
}

fn encode_poly_from_xy_powers(
    poly: &mut DensePolynomialExt,
    params: &SetupParams,
    xy_powers: &[ArchivedG1SerdeRkyv],
) -> G1serde {
    encode_poly_from_xy_powers_with_timing(poly, params, xy_powers, None, None)
}

fn encode_poly_from_xy_powers_with_timing(
    poly: &mut DensePolynomialExt,
    params: &SetupParams,
    xy_powers: &[ArchivedG1SerdeRkyv],
    decoded_xy_powers: Option<&[G1Affine]>,
    _timing_name: Option<&'static str>,
) -> G1serde {
    poly.optimize_size();
    let x_size = poly.x_size;
    let y_size = poly.y_size;
    let rs_x_size = std::cmp::max(2 * params.n, 2 * (params.l_D - params.l));
    let rs_y_size = params.s_max * 2;
    let target_x_size = (poly.x_degree + 1) as usize;
    let target_y_size = (poly.y_degree + 1) as usize;
    if target_x_size > rs_x_size || target_y_size > rs_y_size {
        panic!("Insufficient length of sigma.sigma_1.xy_powers");
    }
    if let Some(decoded) = decoded_xy_powers {
        if decoded.len() != xy_powers.len() {
            panic!("Decoded CRS grid length does not match archived xy_powers");
        }
    }
    if target_x_size * target_y_size == 0 {
        return G1serde::zero();
    }

    let poly_coeffs_vec_compact = {
        let mut poly_coeffs_vec = vec![ScalarField::zero(); x_size * y_size];
        let poly_coeffs = HostSlice::from_mut_slice(&mut poly_coeffs_vec);
        poly.copy_coeffs(0, poly_coeffs);
        resize(
            &poly_coeffs_vec,
            x_size,
            y_size,
            target_x_size,
            target_y_size,
            ScalarField::zero(),
        )
    };

    #[cfg(feature = "timing")]
    let crs_prepare_start = Instant::now();
    let rs_unpacked: Vec<G1Affine> = {
        let mut res = Vec::with_capacity(target_x_size * target_y_size);
        for i in 0..target_x_size {
            for j in 0..target_y_size {
                if i < rs_x_size && j < rs_y_size {
                    let idx = rs_y_size * i + j;
                    res.push(match decoded_xy_powers {
                        Some(decoded) => decoded[idx],
                        None => xy_powers[idx].to_g1_affine(),
                    });
                } else {
                    res.push(G1Affine::zero());
                }
            }
        }
        res
    };
    #[cfg(feature = "timing")]
    if let (Some(name), Some(_)) = (_timing_name, decoded_xy_powers) {
        record_timing(
            name,
            "encode_crs_gather",
            crs_prepare_start.elapsed(),
            vec![SizeInfo {
                label: "active",
                dims: vec![target_x_size, target_y_size],
            }],
        );
    }

    let mut msm_res = vec![G1Projective::zero(); 1];
    #[cfg(feature = "timing")]
    let msm_start = Instant::now();
    msm::msm(
        HostSlice::from_slice(&poly_coeffs_vec_compact),
        HostSlice::from_slice(&rs_unpacked),
        &MSMConfig::default(),
        HostSlice::from_mut_slice(&mut msm_res),
    )
    .unwrap();
    #[cfg(feature = "timing")]
    if let Some(name) = _timing_name {
        record_timing(
            name,
            "encode",
            msm_start.elapsed(),
            vec![SizeInfo {
                label: "msm",
                dims: vec![target_x_size, target_y_size],
            }],
        );
    }
    G1serde(G1Affine::from(msm_res[0]))
}

impl ArchivedSigma1Rkyv {
    pub fn decode_xy_powers(&self) -> Box<[G1Affine]> {
        self.xy_powers
            .iter()
            .map(ArchivedG1SerdeRkyv::to_g1_affine)
            .collect()
    }

    pub fn encode_poly(&self, poly: &mut DensePolynomialExt, params: &SetupParams) -> G1serde {
        encode_poly_from_xy_powers(poly, params, self.xy_powers.as_slice())
    }

    pub fn encode_poly_timed(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        timing_name: &'static str,
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            None,
            Some(timing_name),
        )
    }

    pub fn encode_poly_with_decoded_xy_powers(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        decoded_xy_powers: &[G1Affine],
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            Some(decoded_xy_powers),
            None,
        )
    }

    pub fn encode_poly_timed_with_decoded_xy_powers(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        decoded_xy_powers: &[G1Affine],
        timing_name: &'static str,
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            Some(decoded_xy_powers),
            Some(timing_name),
        )
    }

    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        encode_o_pub_fix_common(
            a_pub_function,
            setup_params,
            self.gamma_inv_o_inst.len(),
            |idx| self.gamma_inv_o_inst[idx].to_g1_affine(),
        )
    }

    pub fn encode_O_pub_free(
        &self,
        placement_variables: &[PlacementVariables],
        public_wire_layout: &PublicWireLayout,
    ) -> G1serde {
        encode_o_pub_free_common(placement_variables, public_wire_layout, |global_idx| {
            self.gamma_inv_o_inst[global_idx].to_g1_affine()
        })
    }

    pub fn encode_O_mid_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        let nVar = count_statement_nvar(
            setup_params.l,
            setup_params.l_D,
            placement_variables,
            subcircuit_infos,
        );
        encode_statement_common(
            setup_params.l,
            setup_params.l_D,
            nVar,
            placement_variables,
            subcircuit_infos,
            |global_idx, i| self.eta_inv_li_o_inter_alpha4_kj[global_idx][i].to_g1_affine(),
        )
    }

    pub fn encode_O_prv_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        let nVar = count_statement_nvar(
            setup_params.l_D,
            setup_params.m_D,
            placement_variables,
            subcircuit_infos,
        );
        encode_statement_common(
            setup_params.l_D,
            setup_params.m_D,
            nVar,
            placement_variables,
            subcircuit_infos,
            |global_idx, i| self.delta_inv_li_o_prv[global_idx][i].to_g1_affine(),
        )
    }

    pub fn delta(&self) -> G1serde {
        self.delta.to_g1serde()
    }

    pub fn eta(&self) -> G1serde {
        self.eta.to_g1serde()
    }

    pub fn delta_inv_alphak_xh_tx(&self, k: usize, h: usize) -> G1serde {
        self.delta_inv_alphak_xh_tx[k][h].to_g1serde()
    }

    pub fn delta_inv_alpha4_xj_tx(&self, j: usize) -> G1serde {
        self.delta_inv_alpha4_xj_tx[j].to_g1serde()
    }

    pub fn delta_inv_alphak_yi_ty(&self, k: usize, i: usize) -> G1serde {
        self.delta_inv_alphak_yi_ty[k][i].to_g1serde()
    }
}

impl ArchivedPartialSigma1Rkyv {
    pub fn encode_poly(&self, poly: &mut DensePolynomialExt, params: &SetupParams) -> G1serde {
        encode_poly_from_xy_powers(poly, params, self.xy_powers.as_slice())
    }

    pub fn encode_poly_timed(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        timing_name: &'static str,
    ) -> G1serde {
        encode_poly_from_xy_powers_with_timing(
            poly,
            params,
            self.xy_powers.as_slice(),
            None,
            Some(timing_name),
        )
    }

    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        encode_o_pub_fix_common(
            a_pub_function,
            setup_params,
            self.gamma_inv_o_inst.len(),
            |idx| self.gamma_inv_o_inst[idx].to_g1_affine(),
        )
    }
}

#[cfg(test)]
mod decoded_xy_powers_tests {
    use super::*;
    use crate::utils::check_device;
    use icicle_bls12_381::curve::{CurveCfg, ScalarCfg};
    use icicle_core::curve::Curve;
    use icicle_core::traits::GenerateRandom;

    #[test]
    fn cached_xy_powers_match_archived_commitments() {
        check_device();
        let params = SetupParams {
            l_free: 1,
            l: 2,
            l_user_out: 0,
            l_user: 0,
            l_D: 4,
            m_D: 8,
            n: 4,
            s_D: 4,
            s_max: 4,
        };
        let points = CurveCfg::generate_random_affine_points(8 * 8);
        let archive_source = PartialSigma1Rkyv {
            xy_powers: points
                .iter()
                .map(|point| G1SerdeRkyv::from_g1serde(&G1serde(*point)))
                .collect(),
            gamma_inv_o_inst: Vec::new(),
        };
        let archive_bytes = rkyv::to_bytes::<_, 256>(&archive_source).unwrap();
        let archived = rkyv::check_archived_root::<PartialSigma1Rkyv>(&archive_bytes).unwrap();
        let decoded_xy_powers: Box<[G1Affine]> = archived
            .xy_powers
            .iter()
            .map(ArchivedG1SerdeRkyv::to_g1_affine)
            .collect();

        let mut sparse_coefficients = vec![ScalarField::zero(); 8 * 8];
        sparse_coefficients[0] = ScalarField::one();
        sparse_coefficients[2] = ScalarField::from_u32(3);
        sparse_coefficients[2 * 8 + 4] = ScalarField::from_u32(7);
        let polynomials = vec![
            DensePolynomialExt::zero(),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&[ScalarField::from_u32(11)]),
                1,
                1,
            ),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&ScalarCfg::generate_random(8)),
                8,
                1,
            ),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&ScalarCfg::generate_random(8)),
                1,
                8,
            ),
            DensePolynomialExt::from_coeffs(HostSlice::from_slice(&sparse_coefficients), 8, 8),
            DensePolynomialExt::from_coeffs(
                HostSlice::from_slice(&ScalarCfg::generate_random(8 * 8)),
                8,
                8,
            ),
        ];

        for polynomial in polynomials {
            let mut archived_polynomial = polynomial.clone();
            let archived_commitment = encode_poly_from_xy_powers_with_timing(
                &mut archived_polynomial,
                &params,
                archived.xy_powers.as_slice(),
                None,
                None,
            );
            let mut cached_polynomial = polynomial;
            let cached_commitment = encode_poly_from_xy_powers_with_timing(
                &mut cached_polynomial,
                &params,
                archived.xy_powers.as_slice(),
                Some(&decoded_xy_powers),
                None,
            );

            assert_eq!(cached_commitment, archived_commitment);
            assert_eq!(cached_polynomial.x_size, archived_polynomial.x_size);
            assert_eq!(cached_polynomial.y_size, archived_polynomial.y_size);
            assert_eq!(cached_polynomial.x_degree, archived_polynomial.x_degree);
            assert_eq!(cached_polynomial.y_degree, archived_polynomial.y_degree);
        }
    }
}
