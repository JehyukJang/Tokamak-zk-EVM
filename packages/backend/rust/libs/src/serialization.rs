use crate::field_structures::FieldSerde;
use crate::group_structures::{G1serde, G2serde};
use hex::decode_to_slice;
use icicle_bls12_381::curve::{BaseField, G1Affine, G2Affine, G2BaseField, ScalarField};
use icicle_core::traits::FieldImpl;
use serde::de::{Deserializer, Error, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use std::fmt;

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
                let scalar = ScalarField::from_hex(v);
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
        let x_field = BaseField::from_hex(&x).into();
        let y_field = BaseField::from_hex(&y).into();
        let point = G1Affine::from_limbs(x_field, y_field);
        Ok(G1serde(point))
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
        let x_field = G2BaseField::from_hex(&x).into();
        let y_field = G2BaseField::from_hex(&y).into();
        let point = G2Affine::from_limbs(x_field, y_field);
        Ok(G2serde(point))
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
fn try_recover_basefield(part1: &str, part2: &str) -> Result<BaseField, String> {
    let mut bytes = [0u8; 48];

    decode_to_slice(part1.trim_start_matches("0x"), &mut bytes[0..16])
        .map_err(|error| format!("invalid G1 coordinate prefix: {error}"))?;

    decode_to_slice(part2.trim_start_matches("0x"), &mut bytes[16..48])
        .map_err(|error| format!("invalid G1 coordinate suffix: {error}"))?;
    bytes.reverse(); // to little Edian

    Ok(BaseField::from_bytes_le(&bytes))
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
    let bx = try_recover_basefield(x_prefix, x_suffix)
        .map_err(|error| format!("invalid G1 x coordinate at entry {idx}: {error}"))?;
    let by = try_recover_basefield(y_prefix, y_suffix)
        .map_err(|error| format!("invalid G1 y coordinate at entry {}: {error}", idx + 1))?;

    Ok(G1serde(G1Affine { x: bx, y: by }))
}
