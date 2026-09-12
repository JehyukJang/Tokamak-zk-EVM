//! Pinned Filecoin challenge_19 adapter. The source is hashed in full, but only
//! the requested ranges are retained. No secret tau or tag is generated here.

use ark_bls12_381::{Bls12_381, Fq, Fq2, Fr, G1Affine, G1Projective, G2Affine, G2Projective};
use ark_ec::{pairing::Pairing, AffineRepr, CurveGroup, VariableBaseMSM};
use ark_ff::{BigInteger, PrimeField, UniformRand, Zero};
use backend_univariate_crs_interface::{
    archive, TauSequenceRkyv, UnivariateG1Rkyv, UnivariateG2Rkyv,
};
use blake2::{Blake2b, Digest as BlakeDigest};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    ops::Range,
    path::Path,
    time::Duration,
};

pub const SOURCE_URL: &str = "https://trusted-setup.filecoin.io/phase1/challenge_19";
const SOURCE_REVISION: &str = "2bd49903bac07485fe23e5ef1a2d5fa19561977b";
const SOURCE_LENGTH: u64 = 1 << 27;
const SOURCE_DIGEST: &str = "5a26015ba27d8164152407da8f9b87e47593f17ae4c260e467bac2ba9dda6f66c15fa352487604d1350ef33a3bfedb0d99e37b619161e27545017366274df76b";
const PREVIOUS_RESPONSE: &str = "6e3f4b98e6c205d0efa5abc917dd03e28864016df380936fa4e9865595c5d69863eff93e8badf8e6b8c8cbfd5ab3a415ef7ba50b86e124bd9bfcd3f9aab67124";
const READ_CHUNK: usize = 1024 * 1024;
const RELATION_CHUNK: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("{0}")]
    Invalid(String),
    #[error("phase 1 I/O: {0}")]
    Io(#[from] io::Error),
    #[error("Filecoin download: {0}")]
    Download(#[from] reqwest::Error),
}
type Result<T> = std::result::Result<T, ImportError>;

fn invalid(message: impl Into<String>) -> ImportError {
    ImportError::Invalid(message.into())
}

// The source pin is not configurable through either public import entry point.
// Private smaller pins are used only by tests of the identical stream parser.
struct SourcePin<'a> {
    length: u64,
    digest: &'a str,
    previous_response: &'a str,
}
const FILECOIN: SourcePin<'static> = SourcePin {
    length: SOURCE_LENGTH,
    digest: SOURCE_DIGEST,
    previous_response: PREVIOUS_RESPONSE,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportReceipt {
    pub source_url: String,
    pub source_revision: String,
    pub source_blake2b512: String,
    pub capacity: usize,
    pub tau_sequence_sha256: String,
    // These checks concern the imported ranges, not every upstream contribution.
    pub verification: Vec<String>,
}

impl SourcePin<'_> {
    fn byte_len(&self) -> u64 {
        576 * self.length + 160
    }

    fn ranges(&self, p: usize) -> Result<[Range<u64>; 5]> {
        if p == 0 || p as u64 >= self.length {
            return Err(invalid(format!(
                "capacity P must be between 1 and {}",
                self.length - 1
            )));
        }
        let p = p as u64;
        let g2 = 64 + (2 * self.length - 1) * 96;
        let alpha = g2 + self.length * 192;
        let beta = alpha + self.length * 96;
        let beta2 = beta + self.length * 96;
        Ok([
            64..64 + (2 * p + 1) * 96,
            g2..g2 + (p + 1) * 192,
            alpha..alpha + (p + 1) * 96,
            beta..beta + (p + 1) * 96,
            beta2..beta2 + 192,
        ])
    }
}

fn check_output(output: &Path) -> Result<()> {
    if output.try_exists()? || fs::symlink_metadata(output).is_ok() {
        return Err(invalid(
            "output already exists; phase 1 never overwrites an import",
        ));
    }
    Ok(())
}

pub fn import_local(source: &Path, p: usize, output: &Path) -> Result<ImportReceipt> {
    FILECOIN.ranges(p)?;
    check_output(output)?;
    let file = File::open(source)?;
    if file.metadata()?.len() != FILECOIN.byte_len() {
        return Err(invalid("Filecoin source has the wrong byte length"));
    }
    import_stream(file, p, output, &FILECOIN)
}

pub fn import_download(p: usize, output: &Path) -> Result<ImportReceipt> {
    FILECOIN.ranges(p)?;
    check_output(output)?;
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(30))
        .timeout(None)
        .build()?;
    let response = client
        .get(SOURCE_URL)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()?
        .error_for_status()?;
    if response.status() != reqwest::StatusCode::OK
        || response
            .content_length()
            .is_some_and(|n| n != FILECOIN.byte_len())
        || response
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .is_some_and(|v| v != "identity")
    {
        return Err(invalid(
            "Filecoin server returned an unexpected length, status or encoding",
        ));
    }
    import_stream(response, p, output, &FILECOIN)
}

fn import_stream(
    reader: impl Read,
    p: usize,
    output: &Path,
    pin: &SourcePin<'_>,
) -> Result<ImportReceipt> {
    check_output(output)?;
    eprintln!(
        "Phase 1: hashing {} source bytes; retaining only capacity P={p}",
        pin.byte_len()
    );
    let selected = collect_ranges(reader, p, pin)?;
    eprintln!("Phase 1: validating imported point encodings and power relations");
    let tau = decode_and_verify(selected)?;
    let bytes = archive::to_bytes::<archive::rancor::Error>(&tau)
        .map_err(|e| invalid(format!("tau archive serialization failed: {e}")))?;
    let receipt = ImportReceipt {
        source_url: SOURCE_URL.into(),
        source_revision: SOURCE_REVISION.into(),
        source_blake2b512: pin.digest.into(),
        capacity: p,
        tau_sequence_sha256: hex::encode(Sha256::digest(bytes.as_ref())),
        verification: vec![
            "full-source-blake2b512".into(),
            "preceding-response-header".into(),
            "selected-point-encoding-and-subgroup".into(),
            "selected-generators".into(),
            "selected-randomized-power-relations".into(),
            "selected-beta-cross-group".into(),
        ],
    };
    publish(output, bytes.as_ref(), &receipt)?;
    Ok(receipt)
}

// Hash and retain in the same read pass: the decoded bytes cannot be changed
// between source authentication and conversion by modifying a local file.
fn collect_ranges(mut reader: impl Read, p: usize, pin: &SourcePin<'_>) -> Result<[Vec<u8>; 5]> {
    let ranges = pin.ranges(p)?;
    let mut selected: [Vec<u8>; 5] = std::array::from_fn(|_| Vec::new());
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut header = Vec::with_capacity(64);
    let mut hasher = Blake2b::new();
    let mut offset = 0u64;
    while offset < pin.byte_len() {
        let limit = (pin.byte_len() - offset).min(buffer.len() as u64) as usize;
        let n = match reader.read(&mut buffer[..limit]) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if n == 0 {
            return Err(invalid("truncated Filecoin source"));
        }
        hasher.input(&buffer[..n]);
        if offset < 64 {
            header.extend_from_slice(&buffer[..n.min((64 - offset) as usize)]);
        }
        for (range, retained) in ranges.iter().zip(&mut selected) {
            let start = offset.max(range.start);
            let end = (offset + n as u64).min(range.end);
            if start < end {
                retained
                    .extend_from_slice(&buffer[(start - offset) as usize..(end - offset) as usize]);
            }
        }
        offset += n as u64;
    }
    if reader.read(&mut buffer[..1])? != 0 {
        return Err(invalid("trailing Filecoin source bytes"));
    }
    if hex::encode(header) != pin.previous_response {
        return Err(invalid("preceding response hash mismatch"));
    }
    if hex::encode(hasher.result()) != pin.digest {
        return Err(invalid("Filecoin source BLAKE2b-512 mismatch"));
    }
    Ok(selected)
}

fn fq(bytes: &[u8]) -> Result<Fq> {
    let value = Fq::from_be_bytes_mod_order(bytes);
    if value.into_bigint().to_bytes_be() != bytes {
        return Err(invalid("noncanonical Filecoin field coordinate"));
    }
    Ok(value)
}

fn decode_g1(bytes: &[u8]) -> Result<G1Affine> {
    if bytes.len() != 96 || bytes[0] & 0xe0 != 0 {
        return Err(invalid(
            "invalid Filecoin uncompressed G1 flags/length (infinity forbidden)",
        ));
    }
    let p = G1Affine::new_unchecked(fq(&bytes[..48])?, fq(&bytes[48..])?);
    if p.is_zero() || !p.is_on_curve() || !p.is_in_correct_subgroup_assuming_on_curve() {
        return Err(invalid("Filecoin G1 is not a nonzero subgroup point"));
    }
    Ok(p)
}

fn decode_g2(bytes: &[u8]) -> Result<G2Affine> {
    if bytes.len() != 192 || bytes[0] & 0xe0 != 0 {
        return Err(invalid(
            "invalid Filecoin uncompressed G2 flags/length (infinity forbidden)",
        ));
    }
    // Upstream pairing c2af46ca serializes x.c1, x.c0, y.c1, y.c0 in big endian.
    let p = G2Affine::new_unchecked(
        Fq2::new(fq(&bytes[48..96])?, fq(&bytes[..48])?),
        Fq2::new(fq(&bytes[144..])?, fq(&bytes[96..144])?),
    );
    if p.is_zero() || !p.is_on_curve() || !p.is_in_correct_subgroup_assuming_on_curve() {
        return Err(invalid("Filecoin G2 is not a nonzero subgroup point"));
    }
    Ok(p)
}

fn pairing_equal(a: G1Affine, b: G2Affine, c: G1Affine, d: G2Affine) -> bool {
    Bls12_381::pairing(a, b) == Bls12_381::pairing(c, d)
}

fn random_coefficients(n: usize) -> Vec<Fr> {
    let mut rng = rand::rngs::OsRng;
    (0..n)
        .map(|_| loop {
            let r = Fr::rand(&mut rng);
            if !r.is_zero() {
                break r;
            }
        })
        .collect()
}

// Random coefficients are sampled after the complete pinned source is captured.
// Every adjacent pair is included, including pairs crossing chunk boundaries.
fn verify_g1_powers(points: &[G1Affine], tau_g2: G2Affine) -> Result<()> {
    (0..points.len() - 1)
        .step_by(RELATION_CHUNK)
        .collect::<Vec<_>>()
        .into_par_iter()
        .try_for_each(|start| {
            let n = RELATION_CHUNK.min(points.len() - 1 - start);
            let r = random_coefficients(n);
            let left = G1Projective::msm_unchecked(&points[start..start + n], &r).into_affine();
            let right =
                G1Projective::msm_unchecked(&points[start + 1..start + n + 1], &r).into_affine();
            if !pairing_equal(left, tau_g2, right, G2Affine::generator()) {
                return Err(invalid("inconsistent Filecoin G1 power sequence"));
            }
            Ok(())
        })
}

fn decode_and_verify(selected: [Vec<u8>; 5]) -> Result<TauSequenceRkyv> {
    let [ordinary, ordinary2, alpha, beta, beta2] = selected;
    let g1 = |bytes: &[u8]| {
        bytes
            .par_chunks(96)
            .map(decode_g1)
            .collect::<Result<Vec<_>>>()
    };
    let a = g1(&ordinary)?;
    let b = ordinary2
        .par_chunks(192)
        .map(decode_g2)
        .collect::<Result<Vec<_>>>()?;
    let xi = g1(&alpha)?;
    let psi = g1(&beta)?;
    let psi2 = decode_g2(&beta2)?;
    if a.len() < 3
        || b.len() < 2
        || xi.len() != b.len()
        || psi.len() != b.len()
        || a.len() != 2 * b.len() - 1
    {
        return Err(invalid("invalid selected family cardinalities"));
    }
    if a[0] != G1Affine::generator() || b[0] != G2Affine::generator() {
        return Err(invalid("Filecoin generator mismatch"));
    }
    for family in [&a, &xi, &psi] {
        verify_g1_powers(family, b[1])?;
    }
    (0..b.len() - 1)
        .step_by(RELATION_CHUNK)
        .collect::<Vec<_>>()
        .into_par_iter()
        .try_for_each(|start| {
            let n = RELATION_CHUNK.min(b.len() - 1 - start);
            let r = random_coefficients(n);
            let left = G2Projective::msm_unchecked(&b[start..start + n], &r).into_affine();
            let right = G2Projective::msm_unchecked(&b[start + 1..start + n + 1], &r).into_affine();
            if !pairing_equal(a[1], left, a[0], right) {
                return Err(invalid("inconsistent Filecoin G2 power sequence"));
            }
            Ok(())
        })?;
    if !pairing_equal(psi[0], b[0], a[0], psi2) {
        return Err(invalid("Filecoin beta tag mismatch"));
    }
    let encode1 = |p: &G1Affine| UnivariateG1Rkyv {
        x: p.x.into_bigint().to_bytes_le().try_into().unwrap(),
        y: p.y.into_bigint().to_bytes_le().try_into().unwrap(),
    };
    let coordinate2 = |q: Fq2| {
        let mut bytes = [0; 96];
        bytes[..48].copy_from_slice(&q.c0.into_bigint().to_bytes_le());
        bytes[48..].copy_from_slice(&q.c1.into_bigint().to_bytes_le());
        bytes
    };
    let encode2 = |p: &G2Affine| UnivariateG2Rkyv {
        x: coordinate2(p.x),
        y: coordinate2(p.y),
    };
    Ok(TauSequenceRkyv {
        schema_id: libs::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID.into(),
        s0_g1: a.par_iter().map(encode1).collect(),
        sxi_g1: xi.par_iter().map(encode1).collect(),
        spsi_g1: psi.par_iter().map(encode1).collect(),
        tau_powers_g2: b.par_iter().map(encode2).collect(),
        psi_g2: encode2(&psi2),
    })
}

fn publish(output: &Path, bytes: &[u8], receipt: &ImportReceipt) -> Result<()> {
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let stage = tempfile::Builder::new()
        .prefix(".filecoin-phase1-")
        .tempdir_in(parent)?;
    let mut payload = File::create(stage.path().join("tau_sequence.rkyv"))?;
    payload.write_all(bytes)?;
    payload.sync_all()?;
    let mut manifest = File::create(stage.path().join("import_receipt.json"))?;
    serde_json::to_writer_pretty(&mut manifest, receipt).map_err(io::Error::other)?;
    manifest.write_all(b"\n")?;
    manifest.sync_all()?;
    check_output(output)?;
    fs::rename(stage.path(), output)?;
    Ok(())
}

#[cfg(test)]
#[path = "filecoin_phase1_tests.rs"]
mod tests;
