// These data models mirror the frontend artifact field names exactly.
#![allow(non_snake_case)]

use crate::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use crate::group_structures::SigmaVerify;
use crate::{impl_read_box_from_json, impl_read_from_json};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt;
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::HostSlice;
use serde::de::{Deserializer, Error};
use serde::Deserialize;
use std::fs::File;
use std::io::{self, BufReader};
use std::ops::Deref;
use std::path::PathBuf;

pub mod public_wire_layout;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HexString(pub String);
impl<'de> Deserialize<'de> for HexString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut s = String::deserialize(deserializer)?;

        if let Some(hex) = s.strip_prefix("0x") {
            if hex.len() % 2 == 1 {
                s = format!("0x0{}", hex);
            }
        } else if s.len() % 2 == 1 {
            s = format!("0{}", s);
        }

        crate::serialization::try_scalar_from_hex(&s).map_err(D::Error::custom)?;

        Ok(HexString(s))
    }
}
impl Deref for HexString {
    type Target = str;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AsRef<str> for HexString {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Deserialize)]
pub struct PublicWireInfo {
    pub subcircuitId: usize,
    pub numPubWires: usize,
}

#[derive(Debug, Deserialize)]
pub struct SetupParams {
    pub l_free: usize,
    pub l: usize,
    pub l_user_out: usize,
    pub l_user: usize,
    pub l_D: usize, //m_I = l_D - 1
    pub m_D: usize,
    pub n: usize,
    pub s_D: usize,
    pub s_max: usize,
}

impl_read_from_json!(SetupParams);
impl_read_from_json!(SigmaVerify);

#[derive(Debug, Deserialize, Clone)]
pub struct PlacementVariables {
    pub subcircuitId: usize,
    pub variables: Box<[HexString]>,
}

impl_read_box_from_json!(PlacementVariables);

#[derive(Debug, Deserialize)]
pub struct OutPts {
    pub extDest: String,
    pub key: String,
    pub offset: usize,
    pub valueHex: String,
}

#[derive(Debug, Deserialize)]
pub struct PublicOutputBuffer {
    pub outPts: Box<[OutPts]>,
}

#[derive(Debug, Deserialize)]
pub struct InPts {
    pub extSource: String,
    pub key: String,
    pub valueHex: String,
}

#[derive(Debug, Deserialize)]
pub struct PublicInputBuffer {
    pub inPts: Box<[InPts]>,
}

#[derive(Debug, Deserialize)]
pub struct Instance {
    pub a_pub_user: Box<[HexString]>,
    pub a_pub_block: Box<[HexString]>,
    pub a_pub_function: Box<[HexString]>,
}

impl_read_from_json!(Instance);

#[derive(Debug, Deserialize)]
pub struct Permutation {
    pub row: usize,
    pub col: usize,
    pub X: usize,
    pub Y: usize,
}

impl_read_box_from_json!(Permutation);

impl Permutation {
    pub fn to_poly(
        perm_raw: &[Self],
        m_i: usize,
        s_max: usize,
    ) -> Result<(DensePolynomialExt, DensePolynomialExt), String> {
        let omega_m_i = ntt::get_root_of_unity::<ScalarField>(m_i as u64);
        let omega_s_max = ntt::get_root_of_unity::<ScalarField>(s_max as u64);
        let mut x_powers = vec![ScalarField::one(); m_i];
        for row_idx in 1..m_i {
            x_powers[row_idx] = x_powers[row_idx - 1] * omega_m_i;
        }
        let mut y_powers = vec![ScalarField::one(); s_max];
        for col_idx in 1..s_max {
            y_powers[col_idx] = y_powers[col_idx - 1] * omega_s_max;
        }

        let mut s0_evals_vec = vec![ScalarField::zero(); m_i * s_max];
        let mut s1_evals_vec = vec![ScalarField::zero(); m_i * s_max];
        for row_idx in 0..m_i {
            let row_start = row_idx * s_max;
            for col_idx in 0..s_max {
                s0_evals_vec[row_start + col_idx] = x_powers[row_idx];
                s1_evals_vec[row_start + col_idx] = y_powers[col_idx];
            }
        }
        for perm in perm_raw.iter() {
            let idx = perm
                .row
                .checked_mul(s_max)
                .and_then(|row_start| row_start.checked_add(perm.col))
                .filter(|idx| *idx < s0_evals_vec.len())
                .ok_or_else(|| {
                    format!(
                        "permutation source ({}, {}) is outside the {} by {} placement domain",
                        perm.row, perm.col, m_i, s_max
                    )
                })?;
            let x = x_powers.get(perm.X).ok_or_else(|| {
                format!(
                    "permutation X coordinate {} is outside the {}-element row domain",
                    perm.X, m_i
                )
            })?;
            let y = y_powers.get(perm.Y).ok_or_else(|| {
                format!(
                    "permutation Y coordinate {} is outside the {}-element placement domain",
                    perm.Y, s_max
                )
            })?;
            s0_evals_vec[idx] = *x;
            s1_evals_vec[idx] = *y;
        }
        let s0_evals = HostSlice::from_slice(&s0_evals_vec);
        let s1_evals = HostSlice::from_slice(&s1_evals_vec);
        Ok((
            DensePolynomialExt::from_rou_evals(s0_evals, m_i, s_max, None, None),
            DensePolynomialExt::from_rou_evals(s1_evals, m_i, s_max, None, None),
        ))
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BufferDirection {
    In,
    Out,
}

#[derive(Debug, Deserialize)]
pub struct SubcircuitInfo {
    pub id: usize,
    pub name: String,
    pub Nwires: usize,
    pub Nconsts: usize,
    pub Out_idx: Box<[usize]>,
    pub In_idx: Box<[usize]>,
    pub flattenMap: Box<[usize]>,
    #[serde(default)]
    pub bufferDirection: Option<BufferDirection>,
}

impl_read_box_from_json!(SubcircuitInfo);

pub fn read_global_wire_list_as_boxed_boxed_numbers(
    path: PathBuf,
) -> io::Result<Box<[Box<[usize]>]>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);

    let vec_of_vecs: Vec<Vec<i32>> = serde_json::from_reader(reader)?;
    let boxed_matrix: Box<[Box<[usize]>]> = vec_of_vecs
        .into_iter()
        .map(|row| {
            row.into_iter()
                .map(|x| x as usize)
                .collect::<Vec<_>>()
                .into_boxed_slice()
        })
        .collect::<Vec<_>>()
        .into_boxed_slice();
    Ok(boxed_matrix)
}

#[cfg(test)]
mod tests {
    use super::{Instance, Permutation, PlacementVariables};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_FIXTURE_ID: AtomicUsize = AtomicUsize::new(0);

    fn write_json_fixture(name: &str, contents: &str) -> PathBuf {
        let fixture_id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tokamak-zk-evm-{name}-{}-{fixture_id}.json",
            std::process::id()
        ));
        fs::write(&path, contents).expect("must write JSON fixture");
        path
    }

    #[test]
    fn rejects_out_of_domain_source_before_polynomial_conversion() {
        let result = Permutation::to_poly(
            &[Permutation {
                row: 2,
                col: 0,
                X: 0,
                Y: 0,
            }],
            2,
            2,
        );

        assert!(matches!(result, Err(error) if error.contains("source (2, 0)")));
    }

    #[test]
    fn rejects_out_of_domain_target_coordinates_before_polynomial_conversion() {
        let result = Permutation::to_poly(
            &[Permutation {
                row: 0,
                col: 0,
                X: 2,
                Y: 0,
            }],
            2,
            2,
        );

        assert!(matches!(result, Err(error) if error.contains("X coordinate 2")));
    }

    #[test]
    fn instance_reader_preserves_odd_width_scalar_normalization() {
        let path = write_json_fixture(
            "instance-odd-width-scalar",
            r#"{
                "a_pub_user": ["0x1"],
                "a_pub_block": [],
                "a_pub_function": []
            }"#,
        );

        let instance = Instance::read_from_json(&path).expect("must read valid instance");
        fs::remove_file(&path).expect("must remove JSON fixture");

        assert_eq!(instance.a_pub_user[0].as_ref(), "0x01");
    }

    #[test]
    fn instance_reader_rejects_non_hex_scalar() {
        let path = write_json_fixture(
            "instance-non-hex-scalar",
            r#"{
                "a_pub_user": ["0xnot-hex"],
                "a_pub_block": [],
                "a_pub_function": []
            }"#,
        );

        let result = Instance::read_from_json(&path);
        fs::remove_file(&path).expect("must remove JSON fixture");

        assert!(result.is_err());
    }

    #[test]
    fn placement_variable_reader_rejects_non_canonical_scalar() {
        let path = write_json_fixture(
            "placement-non-canonical-scalar",
            r#"[
                {
                    "subcircuitId": 0,
                    "variables": ["0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001"]
                }
            ]"#,
        );

        let result = PlacementVariables::read_box_from_json(&path);
        fs::remove_file(&path).expect("must remove JSON fixture");

        assert!(result.is_err());
    }
}
