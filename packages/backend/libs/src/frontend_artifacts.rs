// These data models mirror the frontend artifact field names exactly.
#![allow(non_snake_case)]

use crate::bivariate_polynomial::{BivariatePolynomial, DensePolynomialExt};
use crate::group_structures::SigmaVerify;
use crate::{impl_read_box_from_json, impl_read_from_json};
use icicle_bls12_381::curve::ScalarField;
use icicle_core::ntt;
use icicle_core::traits::FieldImpl;
use icicle_runtime::memory::HostSlice;
use serde::de::Deserializer;
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
    ) -> (DensePolynomialExt, DensePolynomialExt) {
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
            let idx = perm.row * s_max + perm.col;
            s0_evals_vec[idx] = x_powers[perm.X];
            s1_evals_vec[idx] = y_powers[perm.Y];
        }
        let s0_evals = HostSlice::from_slice(&s0_evals_vec);
        let s1_evals = HostSlice::from_slice(&s1_evals_vec);
        return (
            DensePolynomialExt::from_rou_evals(s0_evals, m_i, s_max, None, None),
            DensePolynomialExt::from_rou_evals(s1_evals, m_i, s_max, None, None),
        );
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
