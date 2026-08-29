use std::path::PathBuf;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSubcircuitLibrary {
    pub(crate) version: String,
    pub(crate) integrity: String,
    pub(crate) source_digest: String,
    pub(crate) snapshot_dir: PathBuf,
    pub(crate) release_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct LocalSubcircuitLibrary {
    pub(crate) version: String,
    pub(crate) library_dir: PathBuf,
}
