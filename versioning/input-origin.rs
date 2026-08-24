//! Repository-owned contract for subcircuit-library input origins.
//!
//! The serialized values are part of CRS provenance. This module deliberately
//! has no crate dependencies so Cargo build scripts and backend runtime code
//! share the same definition.

use std::fmt;
use std::str::FromStr;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubcircuitLibraryOrigin {
    NpmSnapshot,
    LocalQapCompiler,
}

impl SubcircuitLibraryOrigin {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NpmSnapshot => "npmSnapshot",
            Self::LocalQapCompiler => "localQapCompiler",
        }
    }
}

impl fmt::Display for SubcircuitLibraryOrigin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for SubcircuitLibraryOrigin {
    type Err = InputOriginContractError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "npmSnapshot" => Ok(Self::NpmSnapshot),
            "localQapCompiler" => Ok(Self::LocalQapCompiler),
            _ => Err(InputOriginContractError {
                value: value.to_string(),
            }),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InputOriginContractError {
    value: String,
}

impl fmt::Display for InputOriginContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "unsupported subcircuit-library input origin {:?}; expected npmSnapshot or localQapCompiler",
            self.value
        )
    }
}

impl std::error::Error for InputOriginContractError {}

#[cfg(test)]
mod tests {
    use super::SubcircuitLibraryOrigin;
    use serde::Deserialize;
    use std::str::FromStr;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contract {
        subcircuit_library_origins: Vec<OriginCase>,
    }

    #[derive(Deserialize)]
    struct OriginCase {
        input: String,
        canonical: Option<String>,
    }

    #[test]
    fn conforms_to_the_repository_input_origin_contract() {
        let contract: Contract = serde_json::from_str(include_str!("input-origin-contract.json"))
            .expect("repository input-origin contract must be valid JSON");

        for case in contract.subcircuit_library_origins {
            match case.canonical {
                Some(expected) => assert_eq!(
                    SubcircuitLibraryOrigin::from_str(&case.input)
                        .expect("accepted input origin must parse")
                        .as_str(),
                    expected,
                    "input origin {:?}",
                    case.input,
                ),
                None => assert!(
                    SubcircuitLibraryOrigin::from_str(&case.input).is_err(),
                    "input origin {:?} must be rejected",
                    case.input,
                ),
            }
        }
    }
}
