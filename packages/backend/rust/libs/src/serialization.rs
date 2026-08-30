use crate::field_structures::FieldSerde;
use crate::group_structures::{G1serde, G2serde};
use ark_bls12_381::{Fq, Fq2, Fr, G1Affine as ArkG1Affine, G2Affine as ArkG2Affine};
use ark_ff::{BigInteger, PrimeField, Zero};
use hex::decode_to_slice;
use icicle_bls12_381::curve::{BaseField, G1Affine, G2Affine, G2BaseField, ScalarField};
use icicle_core::traits::FieldImpl;
use serde::de::{Deserializer, Error, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use std::fmt;

fn decode_hex(value: &str, label: &str, max_bytes: usize) -> Result<Vec<u8>, String> {
    let encoded = value.strip_prefix("0x").unwrap_or(value);
    let bytes = hex::decode(encoded).map_err(|error| format!("invalid {label} hex: {error}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "{label} is {} bytes, exceeding the {max_bytes}-byte field encoding",
            bytes.len()
        ));
    }
    Ok(bytes)
}

fn trim_leading_zeroes(bytes: &[u8]) -> &[u8] {
    bytes
        .iter()
        .position(|byte| *byte != 0)
        .map(|first_nonzero| &bytes[first_nonzero..])
        .unwrap_or(&[])
}

fn parse_prime_field<F: PrimeField>(
    value: &str,
    label: &str,
    max_bytes: usize,
) -> Result<F, String> {
    let bytes = decode_hex(value, label, max_bytes)?;
    let field = F::from_be_bytes_mod_order(&bytes);
    let canonical = field.into_bigint().to_bytes_be();
    if trim_leading_zeroes(&bytes) != trim_leading_zeroes(&canonical) {
        return Err(format!("{label} is not a canonical field element"));
    }
    Ok(field)
}

pub fn try_scalar_from_hex(value: &str) -> Result<ScalarField, String> {
    let scalar = parse_prime_field::<Fr>(value, "scalar", 32)?;
    Ok(ScalarField::from_bytes_le(
        &scalar.into_bigint().to_bytes_le(),
    ))
}

fn try_g1_from_coordinates(x: &str, y: &str) -> Result<G1serde, String> {
    let x = parse_prime_field::<Fq>(x, "G1 x coordinate", 48)?;
    let y = parse_prime_field::<Fq>(y, "G1 y coordinate", 48)?;
    // The established ICICLE JSON representation uses (0, 0) for the
    // identity. Keep that wire-format spelling while rejecting every other
    // non-curve coordinate pair.
    if x.is_zero() && y.is_zero() {
        return Ok(G1serde::zero());
    }
    let point = ArkG1Affine::new_unchecked(x, y);
    if !point.is_on_curve() {
        return Err("G1 point is not on the curve".into());
    }
    if !point.is_in_correct_subgroup_assuming_on_curve() {
        return Err("G1 point is not in the correct subgroup".into());
    }
    Ok(G1serde(G1Affine::from_limbs(
        BaseField::from_bytes_le(&x.into_bigint().to_bytes_le()).into(),
        BaseField::from_bytes_le(&y.into_bigint().to_bytes_le()).into(),
    )))
}

fn try_g2_coordinate(value: &str, label: &str) -> Result<(G2BaseField, Fq2), String> {
    let bytes = decode_hex(value, label, 96)?;
    let mut padded = [0u8; 96];
    padded[96 - bytes.len()..].copy_from_slice(&bytes);
    let c1 = parse_prime_field::<Fq>(&hex::encode(&padded[..48]), label, 48)?;
    let c0 = parse_prime_field::<Fq>(&hex::encode(&padded[48..]), label, 48)?;
    let mut little_endian = padded;
    little_endian.reverse();
    Ok((G2BaseField::from_bytes_le(&little_endian), Fq2::new(c0, c1)))
}

fn try_g2_from_coordinates(x: &str, y: &str) -> Result<G2serde, String> {
    let (x_icicle, x_ark) = try_g2_coordinate(x, "G2 x coordinate")?;
    let (y_icicle, y_ark) = try_g2_coordinate(y, "G2 y coordinate")?;
    // See the G1 identity note above: ICICLE represents the identity with
    // zero coordinates in this JSON contract.
    if x_ark.is_zero() && y_ark.is_zero() {
        return Ok(G2serde::zero());
    }
    let point = ArkG2Affine::new_unchecked(x_ark, y_ark);
    if !point.is_on_curve() {
        return Err("G2 point is not on the curve".into());
    }
    if !point.is_in_correct_subgroup_assuming_on_curve() {
        return Err("G2 point is not in the correct subgroup".into());
    }
    Ok(G2serde(G2Affine::from_limbs(
        x_icicle.into(),
        y_icicle.into(),
    )))
}

#[macro_export]
macro_rules! impl_read_from_json {
    ($t:ty) => {
        impl $t {
            pub fn read_from_json(path: impl AsRef<std::path::Path>) -> std::io::Result<Self> {
                use serde_json::from_reader;
                use std::fs::File;
                use std::io::BufReader;
                let file = File::open(path.as_ref())?;
                let reader = BufReader::new(file);
                let res: Self = from_reader(reader)?;
                Ok(res)
            }
        }
    };
}

#[macro_export]
macro_rules! impl_read_box_from_json {
    ($t:ty) => {
        impl $t {
            pub fn read_box_from_json(
                path: impl AsRef<std::path::Path>,
            ) -> std::io::Result<Box<[Self]>> {
                use serde_json::from_reader;
                use std::fs::File;
                use std::io::BufReader;
                let file = File::open(path.as_ref())?;
                let reader = BufReader::new(file);
                let box_data: Box<[Self]> = from_reader(reader)?;
                Ok(box_data)
            }
        }
    };
}

#[macro_export]
macro_rules! impl_write_into_json {
    ($t:ty) => {
        impl $t {
            pub fn write_into_json(
                &self,
                path: impl AsRef<std::path::Path>,
            ) -> std::io::Result<()> {
                use serde_json::to_writer_pretty;
                use std::fs::{self, File};
                use std::io::BufWriter;
                let path = path.as_ref();
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let file = File::create(path)?;
                let writer = BufWriter::new(file);
                to_writer_pretty(writer, self)?;
                Ok(())
            }
        }
    };
}
impl Serialize for FieldSerde {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let string = self.0.to_string();
        serializer.serialize_str(&string)
    }
}

impl<'de> Deserialize<'de> for FieldSerde {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct FieldVisitor;

        impl<'de> Visitor<'de> for FieldVisitor {
            type Value = FieldSerde;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a hex string representing ScalarField")
            }

            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
            where
                E: Error,
            {
                let scalar = try_scalar_from_hex(v).map_err(E::custom)?;
                Ok(FieldSerde(scalar))
            }
        }

        deserializer.deserialize_str(FieldVisitor)
    }
}

impl Serialize for G1serde {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut s = serializer.serialize_struct("G1serde", 2)?;
        let x_coord = &self.0.x.to_string();
        let y_coord = &self.0.y.to_string();
        s.serialize_field("x", x_coord)?;
        s.serialize_field("y", y_coord)?;
        s.end()
    }
}
impl<'de> Deserialize<'de> for G1serde {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct G1Coords {
            x: String,
            y: String,
        }
        let G1Coords { x, y } = G1Coords::deserialize(deserializer)?;
        try_g1_from_coordinates(&x, &y).map_err(D::Error::custom)
    }
}
impl Serialize for G2serde {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut s = serializer.serialize_struct("G2", 2)?;
        let x_coord = &self.0.x.to_string();
        let y_coord = &self.0.y.to_string();
        s.serialize_field("x", x_coord)?;
        s.serialize_field("y", y_coord)?;
        s.end()
    }
}
impl<'de> Deserialize<'de> for G2serde {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct G2Coords {
            x: String,
            y: String,
        }
        let G2Coords { x, y } = G2Coords::deserialize(deserializer)?;
        try_g2_from_coordinates(&x, &y).map_err(D::Error::custom)
    }
}
// Helper function to encode bytes as hex string
pub fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>()
}

// Helper function to split a G1 point into part1 (16 bytes) and part2 (32 bytes)
pub fn split_g1(point: &G1serde) -> (String, String, String, String) {
    // Get X coordinate bytes in little-endian and convert to big-endian
    let mut x_bytes = point.0.x.to_bytes_le();
    x_bytes.reverse(); // Convert to big-endian

    // Get Y coordinate bytes in little-endian and convert to big-endian
    let mut y_bytes = point.0.y.to_bytes_le();
    y_bytes.reverse(); // Convert to big-endian

    // For BLS12-381 Fp elements, we have 48 bytes
    // For X: first 16 bytes go to part1, last 32 bytes to part2
    let x_part1 = format!("0x{}", hex_encode(&x_bytes[0..16]));
    let x_part2 = format!("0x{}", hex_encode(&x_bytes[16..48]));

    // For Y: first 16 bytes go to part1, last 32 bytes to part2
    let y_part1 = format!("0x{}", hex_encode(&y_bytes[0..16]));
    let y_part2 = format!("0x{}", hex_encode(&y_bytes[16..48]));

    (x_part1, x_part2, y_part1, y_part2)
}

// Helper function to format scalar field as 256-bit hex
pub fn scalar_to_hex(scalar: &ScalarField) -> String {
    let mut bytes = scalar.to_bytes_le();
    bytes.reverse(); // Convert to big-endian
                     // Pad to 32 bytes if necessary
    while bytes.len() < 32 {
        bytes.push(0);
    }
    format!("0x{}", hex_encode(&bytes))
}

#[macro_export]
macro_rules! split_push {
    ($part1: ident, $part2: ident, $( $point:expr ),+ $(,)?) => {
        $(
            {
                let (x_p1, x_p2, y_p1, y_p2) = split_g1($point);
                $part1.push(x_p1);
                $part2.push(x_p2);
                $part1.push(y_p1);
                $part2.push(y_p2);
            }
        )+
    };
}

// Helper function to recover a BaseField from part1 (16 bytes) and part2 (32 bytes)
fn try_recover_coordinate(part1: &str, part2: &str) -> Result<String, String> {
    let mut bytes = [0u8; 48];

    decode_to_slice(part1.trim_start_matches("0x"), &mut bytes[0..16])
        .map_err(|error| format!("invalid G1 coordinate prefix: {error}"))?;

    decode_to_slice(part2.trim_start_matches("0x"), &mut bytes[16..48])
        .map_err(|error| format!("invalid G1 coordinate suffix: {error}"))?;
    Ok(format!("0x{}", hex_encode(&bytes)))
}

pub fn try_next_point(idx: usize, part1: &[String], part2: &[String]) -> Result<G1serde, String> {
    let x_prefix = part1
        .get(idx)
        .ok_or_else(|| format!("missing G1 x prefix at entry {idx}"))?;
    let x_suffix = part2
        .get(idx)
        .ok_or_else(|| format!("missing G1 x suffix at entry {idx}"))?;
    let y_prefix = part1
        .get(idx + 1)
        .ok_or_else(|| format!("missing G1 y prefix at entry {}", idx + 1))?;
    let y_suffix = part2
        .get(idx + 1)
        .ok_or_else(|| format!("missing G1 y suffix at entry {}", idx + 1))?;
    let x = try_recover_coordinate(x_prefix, x_suffix)
        .map_err(|error| format!("invalid G1 x coordinate at entry {idx}: {error}"))?;
    let y = try_recover_coordinate(y_prefix, y_suffix)
        .map_err(|error| format!("invalid G1 y coordinate at entry {}: {error}", idx + 1))?;

    try_g1_from_coordinates(&x, &y)
        .map_err(|error| format!("invalid G1 point at entry {idx}: {error}"))
}

#[cfg(test)]
mod decoding_tests {
    use super::{try_next_point, FieldSerde, G1serde, G2serde};
    use icicle_bls12_381::curve::{CurveCfg, G2CurveCfg};
    use icicle_core::curve::Curve;

    #[test]
    fn rejects_noncanonical_scalar_json() {
        let result = serde_json::from_str::<FieldSerde>("\"not-hex\"");
        assert!(result.is_err());
    }

    #[test]
    fn rejects_off_curve_json_points() {
        let g1 = serde_json::from_str::<G1serde>(r#"{"x":"0x01","y":"0x01"}"#);
        let g2 = serde_json::from_str::<G2serde>(r#"{"x":"0x01","y":"0x01"}"#);
        assert!(g1.is_err());
        assert!(g2.is_err());
    }

    #[test]
    fn json_round_trips_valid_g1_and_g2_points() {
        let g1 = G1serde(CurveCfg::generate_random_affine_points(1)[0]);
        let g2 = G2serde(G2CurveCfg::generate_random_affine_points(1)[0]);

        let recovered_g1: G1serde =
            serde_json::from_str(&serde_json::to_string(&g1).unwrap()).unwrap();
        let recovered_g2: G2serde =
            serde_json::from_str(&serde_json::to_string(&g2).unwrap()).unwrap();
        assert_eq!(recovered_g1, g1);
        assert_eq!(recovered_g2, g2);
    }

    #[test]
    fn formatted_proof_recovery_rejects_invalid_coordinate_hex() {
        let error = try_next_point(
            0,
            &["0xzz".into(), "0x00".into()],
            &["0x00".into(), "0x00".into()],
        )
        .unwrap_err();
        assert!(error.contains("invalid G1 x coordinate"));
    }
}
