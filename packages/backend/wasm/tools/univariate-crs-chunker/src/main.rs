use backend_univariate_crs_interface::{
    archive, ArchivedUnivariateG1Rkyv, ArchivedUnivariateG2Rkyv, ArchivedUnivariateProverKeysRkyv,
    ArchivedUnivariatePublicQueryRkyv, ArchivedUnivariateTaggedQueryRkyv,
    ArchivedUnivariateTauSequenceRkyv, ArchivedUnivariateVerifierKeysRkyv,
};
use clap::Parser;
use memmap2::Mmap;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

const DEFAULT_CHUNK_BYTES: usize = 64 * 1024 * 1024;
const CANONICAL_MANIFEST_FILE: &str = "canonical-manifest.json";
const UNIVARIATE_CRS_SCHEMA_ID: &str = "tokamak-zk-evm-univariate";
const TAU_SEQUENCE_FILE: &str = "tau_sequence.rkyv";
const PROVER_KEYS_FILE: &str = "prover_keys.rkyv";
const VERIFIER_KEYS_FILE: &str = "verifier_keys.rkyv";

#[derive(Debug, Parser)]
struct Config {
    #[arg(long, value_name = "CRS_DIRECTORY")]
    input: PathBuf,
    #[arg(long, value_name = "DIRECTORY")]
    output: PathBuf,
    #[arg(long, default_value_t = DEFAULT_CHUNK_BYTES)]
    chunk_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalManifest {
    schema_id: &'static str,
    source_package_version: &'static str,
    source_rkyv_sha256: SourceRkyvDigests,
    declared_capacity: [u64; 3],
    k: u64,
    sections: Vec<CanonicalSection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceRkyvDigests {
    tau_sequence: String,
    prover_keys: String,
    verifier_keys: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSection {
    label: &'static str,
    encoding: &'static str,
    element_count: u64,
    element_byte_length: u16,
    chunks: Vec<CanonicalChunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalChunk {
    path: String,
    first_element: u64,
    element_count: u64,
    byte_length: u64,
    sha256: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    run(Config::parse())
}

fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    if config.chunk_bytes < 192 {
        return Err("--chunk-bytes must be at least one G2 element (192 bytes)".into());
    }
    if config.output.exists() {
        return Err(format!("output path already exists: {}", config.output.display()).into());
    }

    let tau_file = File::open(config.input.join(TAU_SEQUENCE_FILE))?;
    let prover_file = File::open(config.input.join(PROVER_KEYS_FILE))?;
    let verifier_file = File::open(config.input.join(VERIFIER_KEYS_FILE))?;
    // SAFETY: these mappings are read-only and each source file remains open
    // and unmodified for the lifetime of its mapping.
    let tau_bytes = unsafe { Mmap::map(&tau_file)? };
    let prover_bytes = unsafe { Mmap::map(&prover_file)? };
    let verifier_bytes = unsafe { Mmap::map(&verifier_file)? };
    let tau =
        archive::access::<ArchivedUnivariateTauSequenceRkyv, archive::rancor::Error>(&tau_bytes)
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid tau sequence archive: {error:?}"),
                )
            })?;
    let prover =
        archive::access::<ArchivedUnivariateProverKeysRkyv, archive::rancor::Error>(&prover_bytes)
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid prover keys archive: {error:?}"),
                )
            })?;
    let verifier = archive::access::<ArchivedUnivariateVerifierKeysRkyv, archive::rancor::Error>(
        &verifier_bytes,
    )
    .map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid verifier keys archive: {error:?}"),
        )
    })?;
    let tau_digest: [u8; 32] = Sha256::digest(tau_bytes.as_ref()).into();
    let tau_digest_hex = hex::encode(tau_digest);
    if prover.tau_sequence_sha256 != tau_digest || verifier.tau_sequence_sha256 != tau_digest {
        return Err("prover or verifier keys belong to a different tau sequence".into());
    }
    for schema_id in [&tau.schema_id, &prover.schema_id, &verifier.schema_id] {
        if schema_id.as_str() != UNIVARIATE_CRS_SCHEMA_ID {
            return Err(format!("unsupported univariate CRS schema: {schema_id}").into());
        }
    }
    if tau.s0_g1.is_empty() || tau.sxi_g1.is_empty() || tau.spsi_g1.is_empty() {
        return Err("univariate CRS source sequences must be non-empty".into());
    }
    validate_matching_archives(tau, prover, verifier)?;
    validate_browser_integer_ranges(prover, verifier)?;

    fs::create_dir_all(config.output.join("chunks"))?;
    let mut sections = Vec::new();
    sections.push(write_g1_section(
        &config.output,
        "crs.s0",
        tau.s0_g1.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_g1_section(
        &config.output,
        "crs.sxi",
        tau.sxi_g1.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_g1_section(
        &config.output,
        "crs.spsi",
        tau.spsi_g1.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_public_keys(
        &config.output,
        verifier.gamma_inv_public_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_public_points(
        &config.output,
        verifier.gamma_inv_public_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_tagged_keys(
        &config.output,
        "crs.interface-query-keys",
        prover.eta_inv_interface_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_tagged_points(
        &config.output,
        "crs.interface-queries",
        prover.eta_inv_interface_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_tagged_keys(
        &config.output,
        "crs.internal-query-keys",
        prover.delta_inv_internal_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_tagged_points(
        &config.output,
        "crs.internal-queries",
        prover.delta_inv_internal_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_g1_section(
        &config.output,
        "crs.mask-u",
        prover.delta_inv_u_masking_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_g1_section(
        &config.output,
        "crs.mask-v",
        prover.delta_inv_v_masking_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_g1_section(
        &config.output,
        "crs.mask-w",
        prover.delta_inv_w_masking_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_g1_section(
        &config.output,
        "crs.mask-b",
        prover.delta_inv_b_masking_queries.as_slice(),
        config.chunk_bytes,
    )?);
    sections.push(write_derived_g1_section(
        &config.output,
        "crs.binding-sources",
        [&prover.delta_g1, &prover.eta_g1],
        config.chunk_bytes,
    )?);
    sections.push(write_derived_g1_section(
        &config.output,
        "crs.g1-handles",
        [&verifier.one_g1, &verifier.xi_g1, &verifier.psi_g1],
        config.chunk_bytes,
    )?);
    sections.push(write_derived_g2_section(
        &config.output,
        "crs.g2",
        [
            &verifier.one_g2,
            &verifier.tau_g2,
            &verifier.tau_k_g2,
            &verifier.gamma_g2,
            &verifier.eta_g2,
            &verifier.delta_g2,
        ],
        config.chunk_bytes,
    )?);

    let manifest = CanonicalManifest {
        schema_id: UNIVARIATE_CRS_SCHEMA_ID,
        source_package_version: env!("CARGO_PKG_VERSION"),
        source_rkyv_sha256: SourceRkyvDigests {
            tau_sequence: tau_digest_hex,
            prover_keys: hex_digest(&prover_bytes),
            verifier_keys: hex_digest(&verifier_bytes),
        },
        declared_capacity: tau.shape.declared_capacity.map(Into::into),
        k: tau.shape.k.into(),
        sections,
    };
    fs::write(
        config.output.join(CANONICAL_MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    Ok(())
}

fn validate_matching_archives(
    tau: &ArchivedUnivariateTauSequenceRkyv,
    prover: &ArchivedUnivariateProverKeysRkyv,
    verifier: &ArchivedUnivariateVerifierKeysRkyv,
) -> io::Result<()> {
    let shape_matches =
        |other: &backend_univariate_crs_interface::ArchivedUnivariateCrsShapeRkyv| {
            other.subcircuit_capacity == tau.shape.subcircuit_capacity
                && other.arithmetic_domain_size == tau.shape.arithmetic_domain_size
                && other.connection_domain_size == tau.shape.connection_domain_size
                && other.intersection_domain_size == tau.shape.intersection_domain_size
                && other.union_domain_size == tau.shape.union_domain_size
                && other.minimum_capacity == tau.shape.minimum_capacity
                && other.declared_capacity == tau.shape.declared_capacity
                && other.k == tau.shape.k
        };
    if !shape_matches(&prover.shape) || !shape_matches(&verifier.shape) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "univariate CRS source archives have different shapes",
        ));
    }
    let g1_matches = |left: &ArchivedUnivariateG1Rkyv, right: &ArchivedUnivariateG1Rkyv| {
        left.x == right.x && left.y == right.y
    };
    let g2_matches = |left: &ArchivedUnivariateG2Rkyv, right: &ArchivedUnivariateG2Rkyv| {
        left.x == right.x && left.y == right.y
    };
    if !g1_matches(&tau.s0_g1[0], &verifier.one_g1)
        || !g1_matches(&tau.sxi_g1[0], &verifier.xi_g1)
        || !g1_matches(&tau.spsi_g1[0], &verifier.psi_g1)
        || !g2_matches(&tau.one_g2, &verifier.one_g2)
        || !g2_matches(&tau.tau_g2, &verifier.tau_g2)
        || !g2_matches(&tau.tau_k_g2, &verifier.tau_k_g2)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "univariate CRS verifier handles do not match the tau sequence",
        ));
    }
    Ok(())
}

fn validate_browser_integer_ranges(
    prover: &ArchivedUnivariateProverKeysRkyv,
    verifier: &ArchivedUnivariateVerifierKeysRkyv,
) -> io::Result<()> {
    let fits_u32 = |value: u64, label: &str| {
        u32::try_from(value).map(|_| ()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{label} exceeds the browser u32 range"),
            )
        })
    };
    for query in verifier.gamma_inv_public_queries.iter() {
        fits_u32(
            query.buffer_subcircuit_id.into(),
            "public query subcircuit ID",
        )?;
        fits_u32(
            query.local_public_wire_index.into(),
            "public query wire index",
        )?;
    }
    for (label, queries) in [
        (
            "interface query",
            prover.eta_inv_interface_queries.as_slice(),
        ),
        (
            "internal query",
            prover.delta_inv_internal_queries.as_slice(),
        ),
    ] {
        for query in queries {
            fits_u32(
                query.placement_index.into(),
                &format!("{label} placement index"),
            )?;
            fits_u32(
                query.subcircuit_id.into(),
                &format!("{label} subcircuit ID"),
            )?;
            fits_u32(
                query.local_wire_index.into(),
                &format!("{label} wire index"),
            )?;
        }
    }
    Ok(())
}

fn write_g1_section(
    output: &Path,
    label: &'static str,
    points: &[ArchivedUnivariateG1Rkyv],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        label,
        "canonical-g1-affine-le",
        points.len(),
        96,
        chunk_bytes,
        |index, bytes| {
            append_g1(bytes, &points[index]);
        },
    )
}

fn write_derived_g1_section<const N: usize>(
    output: &Path,
    label: &'static str,
    points: [&ArchivedUnivariateG1Rkyv; N],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        label,
        "canonical-g1-affine-le",
        N,
        96,
        chunk_bytes,
        |index, bytes| {
            append_g1(bytes, points[index]);
        },
    )
}

fn write_derived_g2_section<const N: usize>(
    output: &Path,
    label: &'static str,
    points: [&ArchivedUnivariateG2Rkyv; N],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        label,
        "canonical-g2-affine-le",
        N,
        192,
        chunk_bytes,
        |index, bytes| {
            append_g2(bytes, points[index]);
        },
    )
}

fn write_public_keys(
    output: &Path,
    queries: &[ArchivedUnivariatePublicQueryRkyv],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        "crs.public-query-keys",
        "u32-le",
        queries.len(),
        8,
        chunk_bytes,
        |index, bytes| {
            bytes.extend_from_slice(
                &(u64::from(queries[index].buffer_subcircuit_id) as u32).to_le_bytes(),
            );
            bytes.extend_from_slice(
                &(u64::from(queries[index].local_public_wire_index) as u32).to_le_bytes(),
            );
        },
    )
}

fn write_public_points(
    output: &Path,
    queries: &[ArchivedUnivariatePublicQueryRkyv],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        "crs.public-queries",
        "canonical-g1-affine-le",
        queries.len(),
        96,
        chunk_bytes,
        |index, bytes| {
            append_g1(bytes, &queries[index].point);
        },
    )
}

fn write_tagged_keys(
    output: &Path,
    label: &'static str,
    queries: &[ArchivedUnivariateTaggedQueryRkyv],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        label,
        "u32-le",
        queries.len(),
        12,
        chunk_bytes,
        |index, bytes| {
            bytes.extend_from_slice(
                &(u64::from(queries[index].placement_index) as u32).to_le_bytes(),
            );
            bytes
                .extend_from_slice(&(u64::from(queries[index].subcircuit_id) as u32).to_le_bytes());
            bytes.extend_from_slice(
                &(u64::from(queries[index].local_wire_index) as u32).to_le_bytes(),
            );
        },
    )
}

fn write_tagged_points(
    output: &Path,
    label: &'static str,
    queries: &[ArchivedUnivariateTaggedQueryRkyv],
    chunk_bytes: usize,
) -> io::Result<CanonicalSection> {
    write_section(
        output,
        label,
        "canonical-g1-affine-le",
        queries.len(),
        96,
        chunk_bytes,
        |index, bytes| {
            append_g1(bytes, &queries[index].point);
        },
    )
}

fn write_section(
    output: &Path,
    label: &'static str,
    encoding: &'static str,
    element_count: usize,
    element_byte_length: usize,
    chunk_bytes: usize,
    mut append_element: impl FnMut(usize, &mut Vec<u8>),
) -> io::Result<CanonicalSection> {
    let elements_per_chunk = (chunk_bytes / element_byte_length).max(1);
    let file_stem = label.replace('.', "-");
    let mut chunks = Vec::new();
    for (chunk_index, first_element) in (0..element_count).step_by(elements_per_chunk).enumerate() {
        let end = (first_element + elements_per_chunk).min(element_count);
        let mut bytes = Vec::with_capacity((end - first_element) * element_byte_length);
        for index in first_element..end {
            append_element(index, &mut bytes);
        }
        let relative_path = format!("chunks/{file_stem}-{chunk_index:06}.bin");
        fs::write(output.join(&relative_path), &bytes)?;
        chunks.push(CanonicalChunk {
            path: relative_path,
            first_element: first_element as u64,
            element_count: (end - first_element) as u64,
            byte_length: bytes.len() as u64,
            sha256: hex_digest(&bytes),
        });
    }
    Ok(CanonicalSection {
        label,
        encoding,
        element_count: element_count as u64,
        element_byte_length: element_byte_length as u16,
        chunks,
    })
}

fn append_g1(output: &mut Vec<u8>, point: &ArchivedUnivariateG1Rkyv) {
    output.extend_from_slice(&point.x);
    output.extend_from_slice(&point.y);
}

fn append_g2(output: &mut Vec<u8>, point: &ArchivedUnivariateG2Rkyv) {
    output.extend_from_slice(&point.x);
    output.extend_from_slice(&point.y);
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend_univariate_crs_interface::{
        UnivariateCrsShapeRkyv, UnivariateG1Rkyv, UnivariateG2Rkyv, UnivariateProverKeysRkyv,
        UnivariatePublicQueryRkyv, UnivariateTaggedQueryRkyv, UnivariateTauSequenceRkyv,
        UnivariateVerifierKeysRkyv,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn chunks_a_valid_archive_without_loading_it_as_json() {
        let root = std::env::temp_dir().join(format!(
            "tokamak-univariate-crs-chunker-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&root).unwrap();
        let input = root.join("crs");
        fs::create_dir_all(&input).unwrap();
        let output = root.join("browser-crs");
        let (tau, mut prover, mut verifier) = fixture();
        let tau_bytes = archive::to_bytes::<archive::rancor::Error>(&tau).unwrap();
        let tau_digest = Sha256::digest(tau_bytes.as_ref()).into();
        prover.tau_sequence_sha256 = tau_digest;
        verifier.tau_sequence_sha256 = tau_digest;
        for (file_name, bytes) in [
            (TAU_SEQUENCE_FILE, tau_bytes),
            (
                PROVER_KEYS_FILE,
                archive::to_bytes::<archive::rancor::Error>(&prover).unwrap(),
            ),
            (
                VERIFIER_KEYS_FILE,
                archive::to_bytes::<archive::rancor::Error>(&verifier).unwrap(),
            ),
        ] {
            fs::write(input.join(file_name), bytes).unwrap();
        }

        run(Config {
            input,
            output: output.clone(),
            chunk_bytes: 192,
        })
        .unwrap();

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(output.join(CANONICAL_MANIFEST_FILE)).unwrap())
                .unwrap();
        assert_eq!(manifest["schemaId"], UNIVARIATE_CRS_SCHEMA_ID);
        assert_eq!(manifest["declaredCapacity"], serde_json::json!([2, 1, 1]));
        let s0 = manifest["sections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|section| section["label"] == "crs.s0")
            .unwrap();
        assert_eq!(s0["chunks"].as_array().unwrap().len(), 2);
        assert_eq!(
            fs::read(output.join("chunks/crs-s0-000000.bin"))
                .unwrap()
                .len(),
            192
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn fixture() -> (
        UnivariateTauSequenceRkyv,
        UnivariateProverKeysRkyv,
        UnivariateVerifierKeysRkyv,
    ) {
        let g1 = UnivariateG1Rkyv {
            x: [0; 48],
            y: [0; 48],
        };
        let g2 = UnivariateG2Rkyv {
            x: [0; 96],
            y: [0; 96],
        };
        let tagged = UnivariateTaggedQueryRkyv {
            placement_index: 0,
            subcircuit_id: 0,
            local_wire_index: 2,
            point: g1,
        };
        let shape = || UnivariateCrsShapeRkyv {
            subcircuit_capacity: 1,
            arithmetic_domain_size: 1,
            connection_domain_size: 1,
            intersection_domain_size: 1,
            union_domain_size: 1,
            minimum_capacity: [1, 1, 1],
            declared_capacity: [2, 1, 1],
            k: 1,
        };
        let tau = UnivariateTauSequenceRkyv {
            schema_id: UNIVARIATE_CRS_SCHEMA_ID.to_owned(),
            shape: shape(),
            s0_g1: vec![g1; 3],
            sxi_g1: vec![g1; 2],
            spsi_g1: vec![g1; 2],
            one_g2: g2,
            tau_g2: g2,
            tau_k_g2: g2,
        };
        let prover = UnivariateProverKeysRkyv {
            schema_id: UNIVARIATE_CRS_SCHEMA_ID.to_owned(),
            shape: shape(),
            tau_sequence_sha256: [0; 32],
            eta_inv_interface_queries: vec![tagged],
            delta_inv_internal_queries: vec![tagged],
            delta_inv_u_masking_queries: vec![g1; 2],
            delta_inv_v_masking_queries: vec![g1; 2],
            delta_inv_w_masking_queries: vec![g1; 2],
            delta_inv_b_masking_queries: vec![g1; 2],
            delta_g1: g1,
            eta_g1: g1,
        };
        let verifier = UnivariateVerifierKeysRkyv {
            schema_id: UNIVARIATE_CRS_SCHEMA_ID.to_owned(),
            shape: shape(),
            tau_sequence_sha256: [0; 32],
            one_g1: g1,
            xi_g1: g1,
            psi_g1: g1,
            one_g2: g2,
            tau_g2: g2,
            tau_k_g2: g2,
            gamma_g2: g2,
            eta_g2: g2,
            delta_g2: g2,
            gamma_inv_public_queries: vec![UnivariatePublicQueryRkyv {
                buffer_subcircuit_id: 0,
                local_public_wire_index: 1,
                point: g1,
            }],
        };
        (tau, prover, verifier)
    }
}
