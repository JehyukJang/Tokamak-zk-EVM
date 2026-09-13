//! Publication remains closed while the Filecoin publication policy is deferred.
//! Algorithm consumers do not use this gate.
use crate::crs_provenance::{parse_crs_provenance, CrsProvenance, CRS_PROVENANCE_FILE_NAME};
use std::path::Path;

pub fn admit_final_crs_publication(output_directory: &Path) -> Result<CrsProvenance, String> {
    let bytes = std::fs::read(output_directory.join(CRS_PROVENANCE_FILE_NAME))
        .map_err(|e| e.to_string())?;
    parse_crs_provenance(&bytes)?;
    Err(
        "CRS publication is disabled: the Filecoin publication policy has not been authorized"
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_claim_of_release_eligibility_does_not_authorize_publication() {
        let mut value: serde_json::Value = serde_json::from_str(include_str!(
            "../../../common/contracts/fixtures/final-mpc-crs-provenance.json"
        ))
        .unwrap();
        let directory = tempfile::tempdir().unwrap();
        for eligible in [false, true] {
            value["releaseEligible"] = eligible.into();
            std::fs::write(
                directory.path().join(CRS_PROVENANCE_FILE_NAME),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
            assert!(admit_final_crs_publication(directory.path())
                .unwrap_err()
                .contains("publication is disabled"));
        }
    }
}
