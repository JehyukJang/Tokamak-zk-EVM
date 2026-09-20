//! Runtime artifacts for the normalized local-grid protocol.
#![allow(non_snake_case)]

use crate::{impl_read_box_from_json, impl_read_from_json};
use serde::de::{Deserializer, Error};
use serde::Deserialize;
use std::fs::File;
use std::io::{self, BufReader};
use std::ops::Deref;

pub mod normalized_library;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HexString(pub String);

impl<'de> Deserialize<'de> for HexString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where D: Deserializer<'de> {
        let mut value = String::deserialize(deserializer)?;
        if let Some(hex) = value.strip_prefix("0x") {
            if hex.len() % 2 == 1 { value = format!("0x0{hex}"); }
        } else if value.len() % 2 == 1 {
            value = format!("0{value}");
        }
        crate::serialization::try_scalar_from_hex(&value).map_err(D::Error::custom)?;
        Ok(Self(value))
    }
}

impl Deref for HexString {
    type Target = str;
    fn deref(&self) -> &Self::Target { &self.0 }
}
impl AsRef<str> for HexString { fn as_ref(&self) -> &str { &self.0 } }

#[derive(Debug, Deserialize, Clone)]
pub struct PlacementVariables {
    pub subcircuitId: usize,
    pub variables: Box<[HexString]>,
}
impl_read_box_from_json!(PlacementVariables);

#[derive(Debug, Deserialize)]
pub struct Instance {
    pub a_pub_user: Box<[HexString]>,
    pub a_pub_block: Box<[HexString]>,
    pub a_pub_function: Box<[HexString]>,
}
impl_read_from_json!(Instance);

/// A non-identity edge in the sparse `m_b × s` connection permutation.
#[derive(Debug, Deserialize)]
pub struct Permutation {
    pub row: usize,
    pub col: usize,
    pub X: usize,
    pub Y: usize,
}
impl_read_box_from_json!(Permutation);

/// Reads the synthesizer-owned placement selector. `-1` is the sole inactive
/// sentinel; every other value must be a subcircuit catalog ID.
pub fn read_placement_selector(
    path: impl AsRef<std::path::Path>,
    placement_capacity: usize,
    subcircuit_count: usize,
) -> io::Result<Vec<Option<usize>>> {
    let values: Vec<i32> = serde_json::from_reader(BufReader::new(File::open(path)?))?;
    if values.len() != placement_capacity {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!(
            "selector has {} entries, expected placement capacity {placement_capacity}", values.len()
        )));
    }
    values.into_iter().map(|value| match value {
        -1 => Ok(None),
        value if value >= 0 && (value as usize) < subcircuit_count => Ok(Some(value as usize)),
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, format!(
            "selector entry {value} is outside the {subcircuit_count}-entry subcircuit catalog"
        ))),
    }).collect()
}

impl Permutation {
    pub fn validate_normalized_sparse(
        records: &[Self],
        wiring_width: usize,
        placement_capacity: usize,
    ) -> Result<(), String> {
        use std::collections::HashSet;
        let mut sources = HashSet::with_capacity(records.len());
        let mut targets = HashSet::with_capacity(records.len());
        for record in records {
            if record.row >= wiring_width || record.X >= wiring_width {
                return Err(format!("permutation row coordinate is outside normalized wiring width {wiring_width}"));
            }
            if record.col >= placement_capacity || record.Y >= placement_capacity {
                return Err(format!("permutation placement coordinate is outside placement capacity {placement_capacity}"));
            }
            let source = (record.row, record.col);
            let target = (record.X, record.Y);
            if source == target { return Err("sparse permutation contains an explicit identity record".into()); }
            if !sources.insert(source) { return Err(format!("sparse permutation contains duplicate source ({}, {})", record.row, record.col)); }
            if !targets.insert(target) { return Err(format!("sparse permutation contains duplicate target ({}, {})", record.X, record.Y)); }
        }
        if sources != targets { return Err("sparse permutation records do not form closed cycles".into()); }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{read_placement_selector, Permutation};
    use std::io::Write;

    #[test]
    fn selector_keeps_only_the_canonical_inactive_sentinel() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"[0,2,-1,-1]").unwrap();
        assert_eq!(read_placement_selector(file.path(), 4, 3).unwrap(), vec![Some(0), Some(2), None, None]);
        file.as_file_mut().set_len(0).unwrap();
        file.write_all(b"[4294967295]").unwrap();
        assert!(read_placement_selector(file.path(), 1, 3).is_err());
    }

    #[test]
    fn sparse_permutation_is_closed_and_excludes_identity() {
        let cycle = [Permutation { row: 0, col: 0, X: 1, Y: 1 }, Permutation { row: 1, col: 1, X: 0, Y: 0 }];
        Permutation::validate_normalized_sparse(&cycle, 2, 2).unwrap();
        let identity = [Permutation { row: 0, col: 0, X: 0, Y: 0 }];
        assert!(Permutation::validate_normalized_sparse(&identity, 2, 2).is_err());
    }
}
