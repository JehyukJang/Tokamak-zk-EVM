use crate::sigma::{FinalCrsProvenance, Phase1SourceProvenance, SubcircuitLibraryOrigin};
use crate::versioning::compatible_backend_version;
use google_drive3::api::{File, Permission, Scope};
use google_drive3::hyper::client::HttpConnector;
use google_drive3::hyper::Client;
use google_drive3::hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use google_drive3::{oauth2, DriveHub};
use libs::compatibility::{compatibility_from_package_version, parse_compatible_backend_version};
use libs::crs_artifacts::{verify_final_crs_artifact_digests, FinalCrsDigests};
use oauth2::authenticator_delegate::{DefaultInstalledFlowDelegate, InstalledFlowDelegate};
use serde_json::from_slice;
use std::env;
use std::fs;
use std::fs::File as StdFile;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use thiserror::Error;
use zip::write::{ExtendedFileOptions, FileOptions};

const DRIVE_FOLDER_MIME_TYPE: &str = "application/vnd.google-apps.folder";
const PROVENANCE_FILE_NAME: &str = "crs_provenance.json";
const FINAL_OUTPUT_FILES: [&str; 4] = [
    "combined_sigma.rkyv",
    "sigma_preprocess.rkyv",
    "sigma_verify.json",
    PROVENANCE_FILE_NAME,
];
const DRIVE_FOLDER_ID_ENV: &str = "TOKAMAK_MPC_DRIVE_FOLDER_ID";
const DRIVE_OAUTH_CLIENT_PATH_ENV: &str = "TOKAMAK_MPC_DRIVE_OAUTH_CLIENT_JSON_PATH";
const DRIVE_OAUTH_TOKEN_PATH_ENV: &str = "TOKAMAK_MPC_DRIVE_OAUTH_TOKEN_PATH";

#[derive(Debug, Clone)]
pub struct DriveUploadConfig {
    pub folder_id: String,
    pub folder_url: String,
    pub oauth_client_json_path: PathBuf,
    pub oauth_token_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DriveUploadResult {
    pub folder_url: String,
    pub archive_name: String,
    pub crs_download_url: String,
}

#[derive(Debug, Error)]
pub enum DriveUploadError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error("drive api error: {0}")]
    DriveApi(#[from] google_drive3::Error),
}

pub fn preflight_drive_upload() -> Result<DriveUploadConfig, DriveUploadError> {
    ensure_release_publish_supported()?;
    let _ = dotenvy::dotenv();
    let config = read_drive_upload_config()?;
    let runtime = new_runtime()?;
    runtime.block_on(validate_drive_folder(&config))?;
    Ok(config)
}

pub fn publish_output_archive(
    config: &DriveUploadConfig,
    intermediate_dir: &str,
    output_dir: &str,
) -> Result<DriveUploadResult, DriveUploadError> {
    ensure_release_publish_supported()?;
    let publisher = GoogleDriveArchivePublisher;
    publish_output_archive_with_publisher(config, intermediate_dir, output_dir, &publisher)
}

trait CrsArchivePublisher {
    fn upload_archive(
        &self,
        config: &DriveUploadConfig,
        archive_path: &Path,
        archive_name: &str,
    ) -> Result<DriveUploadResult, DriveUploadError>;
}

struct GoogleDriveArchivePublisher;

impl CrsArchivePublisher for GoogleDriveArchivePublisher {
    fn upload_archive(
        &self,
        config: &DriveUploadConfig,
        archive_path: &Path,
        archive_name: &str,
    ) -> Result<DriveUploadResult, DriveUploadError> {
        let runtime = new_runtime()?;
        runtime.block_on(upload_archive(config, archive_path, archive_name))
    }
}

fn publish_output_archive_with_publisher<P: CrsArchivePublisher>(
    config: &DriveUploadConfig,
    intermediate_dir: &str,
    output_dir: &str,
    publisher: &P,
) -> Result<DriveUploadResult, DriveUploadError> {
    let output_path = fs::canonicalize(output_dir).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("cannot resolve output directory {output_dir}: {err}"),
        )
    })?;
    let intermediate_path = fs::canonicalize(intermediate_dir).map_err(|err| {
        io::Error::new(
            err.kind(),
            format!("cannot resolve intermediate directory {intermediate_dir}: {err}"),
        )
    })?;

    let mut provenance = read_provenance(&output_path)?;
    let original_provenance = provenance.clone();
    validate_publication_provenance(&provenance)?;
    let provenance_compatible_version = canonical_compatible_version(
        &provenance.compatible_backend_version,
        "crs_provenance.json compatibleBackendVersion",
    )?;
    if provenance_compatible_version != compatible_backend_version() {
        return Err(DriveUploadError::Message(format!(
            "crs_provenance.json compatibleBackendVersion {} does not match CLI compatible backend version {}",
            provenance_compatible_version,
            compatible_backend_version()
        )));
    }
    validate_provenance_subcircuit_library(&provenance, &provenance_compatible_version)?;
    verify_final_crs_artifact_digests(
        &output_path,
        &FinalCrsDigests {
            combined_sigma_sha256: provenance.combined_sigma_sha256.clone(),
            sigma_preprocess_sha256: provenance.sigma_preprocess_sha256.clone(),
            sigma_verify_sha256: provenance.sigma_verify_sha256.clone(),
        },
    )
    .map_err(|error| {
        DriveUploadError::Message(format!(
            "cannot publish CRS whose artifacts fail provenance digest validation: {error}"
        ))
    })?;
    let archive_name = build_archive_name(&provenance)?;
    provenance.published_folder_url = Some(config.folder_url.clone());
    provenance.published_archive_name = Some(archive_name.clone());
    provenance.crs_download_url = None;
    write_provenance(&output_path, &provenance)?;

    let archive_path = intermediate_path.join(&archive_name);
    if let Err(err) = create_output_archive(&output_path, &archive_path) {
        let _ = write_provenance(&output_path, &original_provenance);
        return Err(err.into());
    }

    let upload_result = match publisher.upload_archive(config, &archive_path, &archive_name) {
        Ok(upload_result) => upload_result,
        Err(err) => {
            let _ = write_provenance(&output_path, &original_provenance);
            return Err(err);
        }
    };
    provenance.crs_download_url = Some(upload_result.crs_download_url.clone());
    if let Err(err) = write_provenance(&output_path, &provenance) {
        let _ = write_provenance(&output_path, &original_provenance);
        return Err(err.into());
    }

    Ok(DriveUploadResult {
        folder_url: config.folder_url.clone(),
        archive_name,
        crs_download_url: upload_result.crs_download_url,
    })
}

fn validate_publication_provenance(
    provenance: &FinalCrsProvenance,
) -> Result<(), DriveUploadError> {
    if !provenance.release_eligible {
        return Err(DriveUploadError::Message(
            "only release-eligible CRS artifacts may be published".to_string(),
        ));
    }
    if !matches!(
        provenance.phase1_source_provenance,
        Some(Phase1SourceProvenance::DuskGroth16(_))
    ) {
        return Err(DriveUploadError::Message(
            "only Dusk-backed CRS artifacts may be published".to_string(),
        ));
    }
    if provenance.subcircuit_library.origin != SubcircuitLibraryOrigin::NpmSnapshot {
        return Err(DriveUploadError::Message(
            "only CRS artifacts generated from an npm subcircuit-library snapshot may be published"
                .to_string(),
        ));
    }
    Ok(())
}

fn read_drive_upload_config() -> Result<DriveUploadConfig, DriveUploadError> {
    let folder_id = read_required_env(DRIVE_FOLDER_ID_ENV)?;
    let oauth_client_json_path = PathBuf::from(read_required_env(DRIVE_OAUTH_CLIENT_PATH_ENV)?);
    let oauth_token_path = PathBuf::from(read_required_env(DRIVE_OAUTH_TOKEN_PATH_ENV)?);

    if !oauth_client_json_path.exists() {
        return Err(DriveUploadError::Message(format!(
            "{} points to a missing file: {}",
            DRIVE_OAUTH_CLIENT_PATH_ENV,
            oauth_client_json_path.display()
        )));
    }

    if let Some(parent) = oauth_token_path.parent() {
        fs::create_dir_all(parent)?;
    }

    Ok(DriveUploadConfig {
        folder_url: drive_folder_url(&folder_id),
        folder_id,
        oauth_client_json_path,
        oauth_token_path,
    })
}

fn drive_folder_url(folder_id: &str) -> String {
    format!("https://drive.google.com/drive/folders/{folder_id}")
}

fn read_required_env(key: &str) -> Result<String, DriveUploadError> {
    let value = env::var(key).map_err(|_| {
        DriveUploadError::Message(format!(
            "missing required environment variable {key}; load it through .env before running dusk_backed_mpc_setup"
        ))
    })?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DriveUploadError::Message(format!(
            "environment variable {key} must not be empty"
        )));
    }
    Ok(trimmed.to_string())
}

fn read_provenance(output_path: &Path) -> Result<FinalCrsProvenance, DriveUploadError> {
    let bytes = fs::read(output_path.join(PROVENANCE_FILE_NAME))?;
    Ok(from_slice(&bytes)?)
}

fn write_provenance(
    output_path: &Path,
    provenance: &FinalCrsProvenance,
) -> Result<(), DriveUploadError> {
    let bytes = serde_json::to_vec_pretty(provenance)?;
    fs::write(output_path.join(PROVENANCE_FILE_NAME), bytes)?;
    Ok(())
}

fn build_archive_name(provenance: &FinalCrsProvenance) -> Result<String, DriveUploadError> {
    canonical_compatible_version(
        &provenance.compatible_backend_version,
        "crs_provenance.json compatibleBackendVersion",
    )?;
    let generated_at =
        chrono::DateTime::parse_from_rfc3339(&provenance.generated_at_utc).map_err(|err| {
            DriveUploadError::Message(format!("invalid generated_at_utc in provenance: {err}"))
        })?;
    Ok(format!(
        "tokamak-backend-crs-v{}-{}.zip",
        provenance.compatible_backend_version,
        generated_at.format("%Y%m%dT%H%M%SZ")
    ))
}

fn create_output_archive(output_path: &Path, archive_path: &Path) -> Result<(), DriveUploadError> {
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let archive_file = StdFile::create(archive_path)?;
    let mut archive = zip::ZipWriter::new(archive_file);
    let options = FileOptions::<ExtendedFileOptions>::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for file_name in FINAL_OUTPUT_FILES {
        let file_path = output_path.join(file_name);
        add_file_to_archive(&mut archive, file_name, &file_path, options.clone())?;
    }

    archive.finish()?;
    Ok(())
}

fn add_file_to_archive(
    archive: &mut zip::ZipWriter<StdFile>,
    archive_name: &str,
    source_path: &Path,
    options: FileOptions<'_, ExtendedFileOptions>,
) -> Result<(), DriveUploadError> {
    let mut source = StdFile::open(source_path)?;
    archive.start_file(archive_name, options)?;
    io::copy(&mut source, archive)?;
    Ok(())
}

fn validate_provenance_subcircuit_library(
    provenance: &FinalCrsProvenance,
    compatible_version: &str,
) -> Result<(), DriveUploadError> {
    if provenance.subcircuit_library.package_name
        != env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME")
    {
        return Err(DriveUploadError::Message(format!(
            "crs_provenance.json subcircuitLibrary packageName {} does not match the MPC build package {}",
            provenance.subcircuit_library.package_name,
            env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME")
        )));
    }
    if provenance.subcircuit_library.package_version
        != env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION")
    {
        return Err(DriveUploadError::Message(format!(
            "crs_provenance.json subcircuitLibrary packageVersion {} does not match the MPC build package version {}",
            provenance.subcircuit_library.package_version,
            env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION")
        )));
    }
    if package_compatible_version(
        &provenance.subcircuit_library.package_version,
        "crs_provenance.json subcircuitLibrary packageVersion",
    )? != compatible_version
    {
        return Err(DriveUploadError::Message(format!(
            "crs_provenance.json subcircuitLibrary packageVersion {} is outside compatibility class {}",
            provenance.subcircuit_library.package_version, compatible_version
        )));
    }
    Ok(())
}

fn package_compatible_version(value: &str, label: &str) -> Result<String, DriveUploadError> {
    compatibility_from_package_version(value)
        .map(|version| version.to_string())
        .map_err(|error| DriveUploadError::Message(format!("{label} {error}")))
}

fn canonical_compatible_version(value: &str, label: &str) -> Result<String, DriveUploadError> {
    parse_compatible_backend_version(value)
        .map(|version| version.to_string())
        .map_err(|error| DriveUploadError::Message(format!("{label} {error}")))
}

#[cfg(tokamak_release_profile)]
fn ensure_release_publish_supported() -> Result<(), DriveUploadError> {
    Ok(())
}

#[cfg(not(tokamak_release_profile))]
fn ensure_release_publish_supported() -> Result<(), DriveUploadError> {
    Err(DriveUploadError::Message(
        "dusk-backed Google Drive publication is only supported in release builds".to_string(),
    ))
}

async fn validate_drive_folder(config: &DriveUploadConfig) -> Result<(), DriveUploadError> {
    let hub = build_drive_hub(config).await?;
    let (_, folder) = hub
        .files()
        .get(&config.folder_id)
        .param("fields", "id,mimeType,capabilities(canAddChildren)")
        .supports_all_drives(true)
        .add_scope(Scope::Full)
        .doit()
        .await?;

    if folder.mime_type.as_deref() != Some(DRIVE_FOLDER_MIME_TYPE) {
        return Err(DriveUploadError::Message(format!(
            "drive folder id {} does not resolve to a Google Drive folder",
            config.folder_id
        )));
    }

    let can_add_children = folder
        .capabilities
        .as_ref()
        .and_then(|capabilities| capabilities.can_add_children)
        .unwrap_or(false);
    if !can_add_children {
        return Err(DriveUploadError::Message(format!(
            "authenticated Google Drive user cannot upload into drive folder {}",
            config.folder_id
        )));
    }

    let archive_prefix = archive_version_prefix();
    let list_query = format!(
        "'{}' in parents and trashed = false and mimeType = 'application/zip'",
        config.folder_id
    );
    let (_, listing) = hub
        .files()
        .list()
        .q(&list_query)
        .param("fields", "files(id,name)")
        .page_size(10)
        .supports_all_drives(true)
        .include_items_from_all_drives(true)
        .add_scope(Scope::Full)
        .doit()
        .await?;
    if let Some(existing_files) = listing.files {
        let existing_names = existing_files
            .into_iter()
            .filter_map(|file| file.name)
            .filter(|name| name.starts_with(&archive_prefix))
            .collect::<Vec<_>>();
        if !existing_names.is_empty() {
            return Err(DriveUploadError::Message(format!(
                "drive folder {} already contains CRS archive(s) for backend compatibility version {}: {}; bump the backend compatible version before publishing again",
                config.folder_id,
                compatible_backend_version(),
                existing_names.join(", ")
            )));
        }
    }

    Ok(())
}

fn archive_version_prefix() -> String {
    format!("tokamak-backend-crs-v{}-", compatible_backend_version())
}

fn new_runtime() -> Result<tokio::runtime::Runtime, DriveUploadError> {
    tokio::runtime::Runtime::new()
        .map_err(|err| DriveUploadError::Message(format!("cannot create tokio runtime: {err}")))
}

async fn upload_archive(
    config: &DriveUploadConfig,
    archive_path: &Path,
    archive_name: &str,
) -> Result<DriveUploadResult, DriveUploadError> {
    let hub = build_drive_hub(config).await?;
    let metadata = File {
        name: Some(archive_name.to_string()),
        mime_type: Some("application/zip".to_string()),
        parents: Some(vec![config.folder_id.clone()]),
        ..Default::default()
    };
    let file = StdFile::open(archive_path)?;
    let (_, uploaded_file) = hub
        .files()
        .create(metadata)
        .supports_all_drives(true)
        .add_scope(Scope::Full)
        .upload(
            file,
            "application/zip".parse().expect("zip mime type must parse"),
        )
        .await?;
    let file_id = uploaded_file.id.ok_or_else(|| {
        DriveUploadError::Message(format!(
            "drive upload for {archive_name} succeeded without returning a file id"
        ))
    })?;
    configure_public_archive_access(&hub, &file_id, archive_name).await?;
    Ok(DriveUploadResult {
        folder_url: config.folder_url.clone(),
        archive_name: archive_name.to_string(),
        crs_download_url: drive_file_download_url(&file_id),
    })
}

fn drive_file_download_url(file_id: &str) -> String {
    format!("https://drive.google.com/uc?id={file_id}&export=download")
}

async fn configure_public_archive_access(
    hub: &DriveHub<HttpsConnector<HttpConnector>>,
    file_id: &str,
    archive_name: &str,
) -> Result<(), DriveUploadError> {
    let permission = Permission {
        type_: Some("anyone".to_string()),
        role: Some("reader".to_string()),
        allow_file_discovery: Some(false),
        ..Default::default()
    };
    hub.permissions()
        .create(permission, file_id)
        .supports_all_drives(true)
        .add_scope(Scope::Full)
        .doit()
        .await
        .map_err(|err| {
            DriveUploadError::Message(format!(
                "uploaded archive {archive_name} but failed to grant anyone-with-link viewer access: {err}"
            ))
        })?;

    let file_metadata = File {
        copy_requires_writer_permission: Some(false),
        ..Default::default()
    };
    hub.files()
        .update(file_metadata, file_id)
        .supports_all_drives(true)
        .add_scope(Scope::Full)
        .doit_without_upload()
        .await
        .map_err(|err| {
            DriveUploadError::Message(format!(
                "uploaded archive {archive_name} but failed to allow viewers to download, print, and copy it: {err}"
            ))
        })?;

    Ok(())
}

#[derive(Copy, Clone)]
struct DriveOauthBrowserDelegate;

impl InstalledFlowDelegate for DriveOauthBrowserDelegate {
    fn present_user_url<'a>(
        &'a self,
        url: &'a str,
        need_code: bool,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            if webbrowser::open(url).is_ok() {
                println!("Opened a browser window for Google Drive login.");
            }
            let delegate = DefaultInstalledFlowDelegate;
            delegate.present_user_url(url, need_code).await
        })
    }
}

async fn build_drive_hub(
    config: &DriveUploadConfig,
) -> Result<DriveHub<HttpsConnector<HttpConnector>>, DriveUploadError> {
    let app_secret = oauth2::read_application_secret(&config.oauth_client_json_path)
        .await
        .map_err(|err| {
            DriveUploadError::Message(format!(
                "cannot read OAuth client JSON from {}: {err}",
                config.oauth_client_json_path.display()
            ))
        })?;
    let auth = oauth2::InstalledFlowAuthenticator::builder(
        app_secret,
        oauth2::InstalledFlowReturnMethod::HTTPRedirect,
    )
    .persist_tokens_to_disk(&config.oauth_token_path)
    .flow_delegate(Box::new(DriveOauthBrowserDelegate))
    .build()
    .await
    .map_err(|err| {
        DriveUploadError::Message(format!(
            "cannot build Google Drive OAuth authenticator: {err}"
        ))
    })?;
    let https = HttpsConnectorBuilder::new()
        .with_native_roots()
        .map_err(|err| {
            DriveUploadError::Message(format!("cannot load native root certificates: {err}"))
        })?
        .https_or_http()
        .enable_http1()
        .build();
    let client = Client::builder().build(https);
    Ok(DriveHub::new(client, auth))
}

#[cfg(test)]
mod tests {
    use super::{
        archive_version_prefix, publish_output_archive_with_publisher, CrsArchivePublisher,
        DriveUploadConfig, DriveUploadError, DriveUploadResult, FINAL_OUTPUT_FILES,
        PROVENANCE_FILE_NAME,
    };
    use crate::sigma::{
        DuskSourceProvenance, FinalCrsProvenance, Phase1SourceProvenance, SubcircuitLibraryOrigin,
        SubcircuitLibraryProvenance,
    };
    use crate::versioning::compatible_backend_version;
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;
    use std::fs;
    use std::fs::File as StdFile;
    use std::path::{Path, PathBuf};
    use zip::ZipArchive;

    struct MockArchivePublisher {
        result: Result<DriveUploadResult, String>,
        uploads: RefCell<Vec<(PathBuf, String)>>,
    }

    impl MockArchivePublisher {
        fn succeeds() -> Self {
            Self {
                result: Ok(DriveUploadResult {
                    folder_url: "https://drive.example.test/folders/folder-id".to_string(),
                    archive_name: "ignored-by-mock".to_string(),
                    crs_download_url: "https://drive.example.test/download/file-id".to_string(),
                }),
                uploads: RefCell::new(Vec::new()),
            }
        }

        fn fails() -> Self {
            Self {
                result: Err("mock upload failure".to_string()),
                uploads: RefCell::new(Vec::new()),
            }
        }
    }

    impl CrsArchivePublisher for MockArchivePublisher {
        fn upload_archive(
            &self,
            _config: &DriveUploadConfig,
            archive_path: &Path,
            archive_name: &str,
        ) -> Result<DriveUploadResult, DriveUploadError> {
            self.uploads
                .borrow_mut()
                .push((archive_path.to_path_buf(), archive_name.to_string()));
            self.result.clone().map_err(DriveUploadError::Message)
        }
    }

    fn sha256(value: impl AsRef<[u8]>) -> String {
        hex::encode(Sha256::digest(value.as_ref()))
    }

    fn fixture() -> (tempfile::TempDir, DriveUploadConfig, PathBuf, PathBuf) {
        let workspace = tempfile::tempdir().expect("must create temporary workspace");
        let output = workspace.path().join("output");
        let intermediate = workspace.path().join("intermediate");
        fs::create_dir_all(&output).expect("must create output directory");
        fs::create_dir_all(&intermediate).expect("must create intermediate directory");
        for file_name in FINAL_OUTPUT_FILES[..3].iter() {
            fs::write(output.join(file_name), file_name).expect("must write final CRS file");
        }

        let provenance = FinalCrsProvenance {
            release_eligible: true,
            generated_at_utc: "2026-08-23T12:34:56Z".to_string(),
            compatible_backend_version: compatible_backend_version().to_string(),
            subcircuit_library: SubcircuitLibraryProvenance {
                package_name: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_NAME").to_string(),
                package_version: env!("TOKAMAK_ZKEVM_SUBCIRCUIT_LIBRARY_PACKAGE_VERSION")
                    .to_string(),
                origin: SubcircuitLibraryOrigin::NpmSnapshot,
            },
            phase1_source_provenance: Some(Phase1SourceProvenance::DuskGroth16(
                DuskSourceProvenance {
                    source_url: "https://example.invalid/dusk.response".to_string(),
                    source_size_bytes: 0,
                    raw_encoding: "test".to_string(),
                    pinned_contribution: "test".to_string(),
                    pinned_readme_url: "https://example.invalid/readme".to_string(),
                    pinned_drive_file_id: "test".to_string(),
                    expected_source_sha256: "test".to_string(),
                    actual_source_sha256: "test".to_string(),
                    auto_downloaded: false,
                    downloaded_contribution: None,
                    downloaded_readme_url: None,
                    downloaded_drive_file_id: None,
                    max_g1_exp_used: 0,
                    max_g2_exp_used: 0,
                    transcript_consistency_verified: true,
                },
            )),
            combined_sigma_sha256: sha256("combined_sigma.rkyv"),
            sigma_preprocess_sha256: sha256("sigma_preprocess.rkyv"),
            sigma_verify_sha256: sha256("sigma_verify.json"),
            published_folder_url: None,
            published_archive_name: None,
            crs_download_url: None,
        };
        fs::write(
            output.join(PROVENANCE_FILE_NAME),
            serde_json::to_vec_pretty(&provenance).expect("must serialize provenance"),
        )
        .expect("must write provenance");

        let config = DriveUploadConfig {
            folder_id: "folder-id".to_string(),
            folder_url: "https://drive.example.test/folders/folder-id".to_string(),
            oauth_client_json_path: workspace.path().join("unused-oauth.json"),
            oauth_token_path: workspace.path().join("unused-token.json"),
        };
        (workspace, config, output, intermediate)
    }

    fn read_fixture_provenance(output: &Path) -> FinalCrsProvenance {
        serde_json::from_slice(
            &fs::read(output.join(PROVENANCE_FILE_NAME)).expect("must read provenance"),
        )
        .expect("must parse provenance")
    }

    #[test]
    fn rejects_publication_of_a_development_only_crs() {
        let (_workspace, config, output, intermediate) = fixture();
        let mut provenance = read_fixture_provenance(&output);
        provenance.release_eligible = false;
        fs::write(
            output.join(PROVENANCE_FILE_NAME),
            serde_json::to_vec_pretty(&provenance).expect("must serialize provenance"),
        )
        .expect("must write provenance");
        let publisher = MockArchivePublisher::succeeds();

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("development-only CRS must not be published");

        assert!(error
            .to_string()
            .contains("only release-eligible CRS artifacts may be published"));
        assert!(publisher.uploads.borrow().is_empty());
    }

    #[test]
    fn rejects_publication_of_a_local_qap_crs() {
        let (_workspace, config, output, intermediate) = fixture();
        let mut provenance = read_fixture_provenance(&output);
        provenance.subcircuit_library.origin = SubcircuitLibraryOrigin::LocalQapCompiler;
        fs::write(
            output.join(PROVENANCE_FILE_NAME),
            serde_json::to_vec_pretty(&provenance).expect("must serialize provenance"),
        )
        .expect("must write provenance");
        let publisher = MockArchivePublisher::succeeds();

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("local QAP CRS must not be published");

        assert!(error
            .to_string()
            .contains("npm subcircuit-library snapshot"));
        assert!(publisher.uploads.borrow().is_empty());
    }

    #[test]
    fn rejects_publication_without_dusk_source_provenance() {
        let (_workspace, config, output, intermediate) = fixture();
        let mut provenance = read_fixture_provenance(&output);
        provenance.phase1_source_provenance = Some(Phase1SourceProvenance::Native);
        fs::write(
            output.join(PROVENANCE_FILE_NAME),
            serde_json::to_vec_pretty(&provenance).expect("must serialize provenance"),
        )
        .expect("must write provenance");
        let publisher = MockArchivePublisher::succeeds();

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("non-Dusk CRS must not be published");

        assert!(error.to_string().contains("only Dusk-backed CRS artifacts"));
        assert!(publisher.uploads.borrow().is_empty());
    }

    #[test]
    fn rejects_publication_with_missing_library_origin() {
        let (_workspace, config, output, intermediate) = fixture();
        let mut provenance: serde_json::Value = serde_json::from_slice(
            &fs::read(output.join(PROVENANCE_FILE_NAME)).expect("must read provenance"),
        )
        .expect("must parse fixture provenance");
        provenance["subcircuitLibrary"]
            .as_object_mut()
            .expect("fixture library provenance must be an object")
            .remove("origin");
        fs::write(
            output.join(PROVENANCE_FILE_NAME),
            serde_json::to_vec_pretty(&provenance).expect("must serialize provenance"),
        )
        .expect("must write provenance");
        let publisher = MockArchivePublisher::succeeds();

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("CRS without a library origin must not be published");

        assert!(matches!(error, DriveUploadError::Json(_)));
        assert!(publisher.uploads.borrow().is_empty());
    }

    #[test]
    fn rejects_publication_when_any_final_crs_artifact_does_not_match_provenance() {
        for file_name in FINAL_OUTPUT_FILES[..3].iter() {
            let (_workspace, config, output, intermediate) = fixture();
            let publisher = MockArchivePublisher::succeeds();
            fs::write(output.join(file_name), "tampered CRS artifact")
                .expect("must modify CRS artifact after provenance generation");

            let error = publish_output_archive_with_publisher(
                &config,
                &intermediate.to_string_lossy(),
                &output.to_string_lossy(),
                &publisher,
            )
            .expect_err("tampered CRS artifact must not be published");

            assert!(error.to_string().contains(file_name));
            assert!(error
                .to_string()
                .contains("fail provenance digest validation"));
            assert!(publisher.uploads.borrow().is_empty());
        }
    }

    #[test]
    fn rejects_publication_with_a_noncanonical_compatibility_version() {
        let (_workspace, config, output, intermediate) = fixture();
        let mut provenance = read_fixture_provenance(&output);
        provenance.compatible_backend_version = "02.01".to_string();
        fs::write(
            output.join(PROVENANCE_FILE_NAME),
            serde_json::to_vec_pretty(&provenance).expect("must serialize provenance"),
        )
        .expect("must write provenance");
        let publisher = MockArchivePublisher::succeeds();

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("noncanonical compatibility version must not be published");

        assert!(error
            .to_string()
            .contains("leading zeroes are not canonical"));
        assert!(publisher.uploads.borrow().is_empty());
    }

    #[test]
    fn publication_archives_and_records_a_finalized_crs() {
        let (_workspace, config, output, intermediate) = fixture();
        let publisher = MockArchivePublisher::succeeds();

        let result = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect("finalized CRS publication must succeed");

        let uploads = publisher.uploads.borrow();
        assert_eq!(uploads.len(), 1);
        assert!(uploads[0].1.starts_with(&archive_version_prefix()));
        assert_eq!(result.archive_name, uploads[0].1);
        let mut archive = ZipArchive::new(
            StdFile::open(&uploads[0].0).expect("mocked upload archive must exist"),
        )
        .expect("archive must be valid");
        for file_name in FINAL_OUTPUT_FILES {
            assert!(
                archive.by_name(file_name).is_ok(),
                "archive missing {file_name}"
            );
        }
        assert!(archive.by_name("build-metadata-mpc-setup.json").is_err());

        let provenance = read_fixture_provenance(&output);
        assert_eq!(provenance.published_folder_url, Some(config.folder_url));
        assert_eq!(provenance.published_archive_name, Some(result.archive_name));
        assert_eq!(
            provenance.crs_download_url,
            Some("https://drive.example.test/download/file-id".to_string())
        );
    }

    #[test]
    fn failed_publication_restores_local_provenance() {
        let (_workspace, config, output, intermediate) = fixture();
        let original_provenance = read_fixture_provenance(&output);
        let publisher = MockArchivePublisher::fails();

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("mock upload failure must be returned");

        assert!(error.to_string().contains("mock upload failure"));
        assert_eq!(publisher.uploads.borrow().len(), 1);
        assert_eq!(read_fixture_provenance(&output), original_provenance);
    }

    #[test]
    fn archive_construction_failure_restores_local_provenance() {
        let (_workspace, config, output, intermediate) = fixture();
        let original_provenance = read_fixture_provenance(&output);
        let publisher = MockArchivePublisher::succeeds();
        fs::create_dir(
            intermediate.join(format!("{}20260823T123456Z.zip", archive_version_prefix())),
        )
        .expect("must reserve archive path with a directory to make archive construction fail");

        let error = publish_output_archive_with_publisher(
            &config,
            &intermediate.to_string_lossy(),
            &output.to_string_lossy(),
            &publisher,
        )
        .expect_err("archive construction failure must be returned");

        assert!(matches!(error, DriveUploadError::Io(_)));
        assert!(publisher.uploads.borrow().is_empty());
        assert_eq!(read_fixture_provenance(&output), original_provenance);
    }
}
