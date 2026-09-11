//! Release-only A/B storage experiment against a preserved dense P3 archive.
//! Usage: crs_storage_benchmark DENSE_DIRECTORY LIBRARY OUTPUT_DIRECTORY [CANDIDATE_DIRECTORY]
use backend_univariate_crs_interface::{archive, ArchivedProverKeysRkyv, NonpublicQueryLayout};
use icicle_bls12_381::curve::{BaseField, G1Affine, G1Projective, ScalarField};
use icicle_core::{
    msm::{msm, MSMConfig},
    traits::FieldImpl,
};
use icicle_runtime::memory::HostSlice;
use libs::frontend_artifacts::{SetupParams, SubcircuitInfo};
use memmap2::Mmap;
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    path::Path,
    time::Instant,
};

fn map(path: &Path) -> Mmap {
    let file = File::open(path).unwrap();
    // SAFETY: benchmark inputs are immutable for the lifetime of each mapping.
    unsafe { Mmap::map(&file).unwrap() }
}

fn identity_stats<'a>(
    points: impl Iterator<Item = (&'a [u8], &'a [u8])>,
    identity: (&[u8], &[u8]),
) -> serde_json::Value {
    let (mut count, mut identities, mut longest, mut run) = (0, 0, 0, 0);
    for (x, y) in points {
        count += 1;
        if x == identity.0 && y == identity.1 {
            identities += 1;
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    serde_json::json!({"points":count,"identities":identities,"longestRun":longest})
}

fn measure(bytes: &[u8], indices: &[usize], rounds: usize) -> serde_json::Value {
    let scalars = (0..indices.len())
        .map(|j| ScalarField::from_u32((j % 101) as u32))
        .collect::<Vec<_>>();
    let mut samples = Vec::new();
    for _ in 0..rounds {
        let start = Instant::now();
        let points = indices
            .iter()
            .map(|index| {
                let record = &bytes[index * 96..(index + 1) * 96];
                G1Affine::from_limbs(
                    BaseField::from_bytes_le(&record[..48]).into(),
                    BaseField::from_bytes_le(&record[48..]).into(),
                )
            })
            .collect::<Vec<_>>();
        let read_ms = start.elapsed().as_secs_f64() * 1000.;
        let start = Instant::now();
        let mut out = [G1Projective::zero()];
        if !points.is_empty() {
            msm(
                HostSlice::from_slice(&scalars),
                HostSlice::from_slice(&points),
                &MSMConfig::default(),
                HostSlice::from_mut_slice(&mut out),
            )
            .unwrap();
        }
        let result = G1Affine::from(out[0]);
        samples.push(serde_json::json!({"prepareMs":read_ms,"msmMs":start.elapsed().as_secs_f64()*1000.,"resultX":hex::encode(result.x.to_bytes_le()),"resultY":hex::encode(result.y.to_bytes_le())}));
    }
    serde_json::json!({"selectedPoints":indices.len(),"samples":samples})
}

#[cfg(target_os = "macos")]
fn range_io(path: &Path, indices: &[usize], uncached: bool) -> (f64, Vec<u8>) {
    use std::{
        io::{Read, Seek, SeekFrom},
        os::fd::AsRawFd,
    };
    let mut file = File::open(path).unwrap();
    // SAFETY: this live descriptor accepts the integer F_NOCACHE flag. This
    // affects only this benchmark handle, not system-wide caches or other files.
    assert_eq!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_NOCACHE, i32::from(uncached)) },
        0
    );
    let mut bytes = vec![0; indices.len() * 96];
    let start = Instant::now();
    let mut first = 0;
    while first < indices.len() {
        let mut end = first + 1;
        while end < indices.len() && indices[end] == indices[end - 1] + 1 {
            end += 1;
        }
        file.seek(SeekFrom::Start((indices[first] * 96) as u64))
            .unwrap();
        file.read_exact(&mut bytes[first * 96..end * 96]).unwrap();
        first = end;
    }
    (start.elapsed().as_secs_f64() * 1000., bytes)
}

fn main() {
    assert!(
        !cfg!(debug_assertions),
        "run this experiment with --release"
    );
    libs::utils::try_check_device().unwrap();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    assert!(args.len() == 3 || args.len() == 4);
    let library = Path::new(&args[1]);
    let setup = SetupParams::read_from_json(library.join("setupParams.json")).unwrap();
    let infos = SubcircuitInfo::read_box_from_json(library.join("subcircuitInfo.json")).unwrap();
    let maps = infos
        .iter()
        .map(|v| v.flattenMap.as_ref())
        .collect::<Vec<_>>();
    let layout = NonpublicQueryLayout::new(setup.s_max, setup.m, setup.l, &maps).unwrap();
    let dense = map(&Path::new(&args[0]).join("prover_keys.rkyv"));
    let source = archive::access::<ArchivedProverKeysRkyv, archive::rancor::Error>(&dense).unwrap();
    let public_count = maps
        .iter()
        .flat_map(|m| m.iter())
        .filter(|g| **g < setup.l)
        .count();
    let dense_stride = setup.t * setup.m - public_count;
    assert_eq!(source.nonpublic_queries.len(), setup.s_max * dense_stride);
    if let Some(candidate) = args.get(3) {
        let bytes = map(&Path::new(candidate).join("prover_keys.rkyv"));
        let actual =
            archive::access::<ArchivedProverKeysRkyv, archive::rancor::Error>(&bytes).unwrap();
        let placeholders = actual.nonpublic_queries.len() == source.nonpublic_queries.len();
        assert!(placeholders || actual.nonpublic_queries.len() == layout.len());
        let identity = G1Affine::zero();
        let mut dense_index = 0;
        let mut retained_index = 0;
        for i in 0..setup.s_max {
            for k in 0..setup.t {
                if k < setup.s_D && !placeholders {
                    assert_eq!(
                        actual.nonpublic_block(&layout, i, k).unwrap().len(),
                        layout.local_wires(k).unwrap().len()
                    );
                }
                for j in 0..setup.m {
                    let global = maps.get(k).and_then(|m| m.get(j));
                    if global.is_some_and(|g| *g < setup.l) {
                        continue;
                    }
                    if global.is_some() {
                        let expected = &source.nonpublic_queries[dense_index];
                        let retained = &actual.nonpublic_queries[if placeholders {
                            dense_index
                        } else {
                            retained_index
                        }];
                        assert_eq!(expected.x, retained.x);
                        assert_eq!(expected.y, retained.y);
                        retained_index += 1;
                    } else if placeholders {
                        let omitted = &actual.nonpublic_queries[dense_index];
                        assert_eq!(omitted.x.as_slice(), identity.x.to_bytes_le());
                        assert_eq!(omitted.y.as_slice(), identity.y.to_bytes_le());
                    }
                    dense_index += 1;
                }
            }
        }
        assert_eq!(retained_index, layout.len());
        macro_rules! equal_field {
            ($field:ident) => {
                assert_eq!(source.$field.len(), actual.$field.len());
                for (a, b) in source.$field.iter().zip(actual.$field.iter()) {
                    assert_eq!(a.x, b.x);
                    assert_eq!(a.y, b.y);
                }
            };
        }
        equal_field!(weighted_g1);
        equal_field!(weighted_shifted_g1);
        equal_field!(free_public_queries);
        equal_field!(mask_u);
        equal_field!(mask_v);
        equal_field!(mask_w);
        equal_field!(mask_b);
        assert_eq!(source.mask_selection.x, actual.mask_selection.x);
        assert_eq!(source.mask_selection.y, actual.mask_selection.y);
        let mut residual = serde_json::Map::new();
        let identity_g2 = icicle_bls12_381::curve::G2Affine::zero();
        macro_rules! inspect {
            ($label:literal, $points:expr, $identity:expr) => {
                residual.insert(
                    $label.into(),
                    identity_stats(
                        $points.iter().map(|p| (p.x.as_slice(), p.y.as_slice())),
                        (&$identity.x.to_bytes_le(), &$identity.y.to_bytes_le()),
                    ),
                );
            };
        }
        inspect!("weighted_g1", actual.weighted_g1, identity);
        inspect!("weighted_shifted_g1", actual.weighted_shifted_g1, identity);
        inspect!("free_public_queries", actual.free_public_queries, identity);
        inspect!("nonpublic_queries", actual.nonpublic_queries, identity);
        inspect!("mask_u", actual.mask_u, identity);
        inspect!("mask_v", actual.mask_v, identity);
        inspect!("mask_w", actual.mask_w, identity);
        inspect!("mask_b", actual.mask_b, identity);
        inspect!("mask_selection", [&actual.mask_selection], identity);
        let tau_bytes = map(&Path::new(candidate).join("tau_sequence.rkyv"));
        let tau = archive::access::<
            backend_univariate_crs_interface::ArchivedTauSequenceRkyv,
            archive::rancor::Error,
        >(&tau_bytes)
        .unwrap();
        inspect!("s0_g1", tau.s0_g1, identity);
        inspect!("sxi_g1", tau.sxi_g1, identity);
        inspect!("spsi_g1", tau.spsi_g1, identity);
        inspect!("tau_powers_g2", tau.tau_powers_g2, identity_g2);
        inspect!("psi_g2", [&tau.psi_g2], identity_g2);
        let preprocess_bytes = map(&Path::new(candidate).join("preprocess_keys.rkyv"));
        let preprocess = archive::access::<
            backend_univariate_crs_interface::ArchivedPreprocessKeysRkyv,
            archive::rancor::Error,
        >(&preprocess_bytes)
        .unwrap();
        inspect!("sc_g1", preprocess.sc_g1, identity);
        inspect!("selection_g2", preprocess.selection_g2, identity_g2);
        inspect!(
            "fixed_public_queries",
            preprocess.fixed_public_queries,
            identity
        );
        let verifier_bytes = map(&Path::new(candidate).join("verifier_keys.rkyv"));
        let verifier = archive::access::<
            backend_univariate_crs_interface::ArchivedVerifierKeysRkyv,
            archive::rancor::Error,
        >(&verifier_bytes)
        .unwrap();
        inspect!(
            "verifier_g1",
            [&verifier.one_g1, &verifier.xi_g1, &verifier.psi_g1],
            identity
        );
        inspect!(
            "verifier_g2",
            [
                &verifier.one_g2,
                &verifier.tau_g2,
                &verifier.tau_k_g2,
                &verifier.delta_g2
            ],
            identity_g2
        );
        println!(
            "{}",
            serde_json::json!({"retainedPointsEqual":retained_index,"otherProverSectionsEqual":true,"placeholders":placeholders,"residual":residual})
        );
        return;
    }
    let out = Path::new(&args[2]);
    fs::create_dir(out).unwrap();
    let zero = G1Affine::zero();
    let mut identity = zero.x.to_bytes_le();
    identity.extend(zero.y.to_bytes_le());
    let mut retained_dense_indices = Vec::with_capacity(layout.len());
    let mut cursor = 0;
    let mut original_infinities = 0usize;
    let mut max_original_run = 0usize;
    let mut run = 0usize;
    let mut omitted_runs = 0usize;
    let mut was_omitted = false;
    for _i in 0..setup.s_max {
        for k in 0..setup.t {
            for j in 0..setup.m {
                let global = maps.get(k).and_then(|m| m.get(j));
                if global.is_some_and(|g| *g < setup.l) {
                    continue;
                }
                let point = &source.nonpublic_queries[cursor];
                let is_identity =
                    point.x.as_slice() == &identity[..48] && point.y.as_slice() == &identity[48..];
                if is_identity {
                    original_infinities += 1;
                    run += 1;
                    max_original_run = max_original_run.max(run);
                } else {
                    run = 0;
                }
                if global.is_some() {
                    retained_dense_indices.push(cursor);
                    was_omitted = false;
                } else {
                    if !was_omitted {
                        omitted_runs += 1;
                    }
                    was_omitted = true;
                }
                cursor += 1;
            }
        }
    }
    assert_eq!(retained_dense_indices.len(), layout.len());
    let mut files = Vec::new();
    for omit in [true, false] {
        let name = if omit { "a.bin" } else { "b.bin" };
        let start = Instant::now();
        let mut writer =
            BufWriter::with_capacity(1024 * 1024, File::create(out.join(name)).unwrap());
        let mut retained = retained_dense_indices.iter().copied().peekable();
        for (index, point) in source.nonpublic_queries.iter().enumerate() {
            if retained.peek() == Some(&index) {
                writer.write_all(point.x.as_slice()).unwrap();
                writer.write_all(point.y.as_slice()).unwrap();
                retained.next();
            } else if !omit {
                writer.write_all(&identity).unwrap();
            }
        }
        writer.flush().unwrap();
        writer.get_ref().sync_all().unwrap();
        files.push(serde_json::json!({"file":name,"bytes":fs::metadata(out.join(name)).unwrap().len(),"projectionWriteSeconds":start.elapsed().as_secs_f64()}));
    }
    let a = map(&out.join("a.bin"));
    let b = map(&out.join("b.bin"));
    let nonbuffers = infos
        .iter()
        .filter(|v| v.bufferDirection.is_none())
        .map(|v| v.id)
        .collect::<Vec<_>>();
    let mut workloads = Vec::new();
    for mode in ["full", "partial", "empty"] {
        let mut a_indices = Vec::new();
        for i in 0..setup.s_max {
            if mode == "empty" || (mode == "partial" && i >= setup.s_max / 2) {
                continue;
            }
            let k = if i < infos.len() && infos[i].bufferDirection.is_some() {
                i
            } else {
                nonbuffers[i % nonbuffers.len()]
            };
            a_indices.extend(layout.range(i, k).unwrap());
        }
        let b_indices = a_indices
            .iter()
            .map(|i| retained_dense_indices[*i])
            .collect::<Vec<_>>();
        let mut trials = Vec::new();
        // Alternate order; the first access is first-touch, not a purged cold-cache claim.
        for trial in 0..30 {
            let (ma, mb) = if trial % 2 == 0 {
                (measure(&a, &a_indices, 1), measure(&b, &b_indices, 1))
            } else {
                let mb = measure(&b, &b_indices, 1);
                (measure(&a, &a_indices, 1), mb)
            };
            assert_eq!(ma["samples"][0]["resultX"], mb["samples"][0]["resultX"]);
            assert_eq!(ma["samples"][0]["resultY"], mb["samples"][0]["resultY"]);
            trials.push(serde_json::json!({"a":ma,"b":mb}));
        }
        let mut range_reads = Vec::<serde_json::Value>::new();
        #[cfg(target_os = "macos")]
        for uncached in [true, false] {
            for trial in 0..6 {
                let (a_read, b_read) = if trial % 2 == 0 {
                    (
                        range_io(&out.join("a.bin"), &a_indices, uncached),
                        range_io(&out.join("b.bin"), &b_indices, uncached),
                    )
                } else {
                    let b_read = range_io(&out.join("b.bin"), &b_indices, uncached);
                    (range_io(&out.join("a.bin"), &a_indices, uncached), b_read)
                };
                assert_eq!(a_read.1, b_read.1);
                range_reads
                    .push(serde_json::json!({"uncached":uncached,"aMs":a_read.0,"bMs":b_read.0}));
            }
        }
        workloads.push(serde_json::json!({"mode":mode,"trials":trials,"rangeReads":range_reads}));
    }
    let summary = serde_json::json!({"denseQueries":cursor,"retainedQueries":layout.len(),"omittedQueries":cursor-layout.len(),"originalInfinityCount":original_infinities,"maxOriginalInfinityRun":max_original_run,"placeholderRuns":omitted_runs,"files":files,"workloads":workloads,"note":"Projection writes are not trusted-setup generation timings. First-touch is not an OS-cache-purged cold read. Binding microbenchmarks are not complete proof E2E."});
    fs::write(
        out.join("measurements.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
    println!("{}", summary);
}
