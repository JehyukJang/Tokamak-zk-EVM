use std::io;
use std::path::Path;

use icicle_bls12_381::curve::G1Affine;
use libs::bivariate_polynomial::DensePolynomialExt;
use libs::group_structures::G1serde;
use libs::iotools::public_wire_layout::PublicWireLayout;
use libs::iotools::{
    ArchivedSigma1Rkyv, ArchivedSigmaRkyv, HexString, PlacementVariables, SetupParams, SigmaRkyv,
    SubcircuitInfo,
};
use memmap2::Mmap;
use std::fs::File;
#[cfg(feature = "timing")]
use std::time::Instant;

pub struct SigmaHolder {
    inner: SigmaZeroCopy,
    decoded_xy_powers: Box<[G1Affine]>,
}

pub struct SigmaZeroCopy {
    mmap: Mmap,
}

impl SigmaZeroCopy {
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let file = File::open(path)?;
        let mmap = unsafe { Mmap::map(&file)? };
        rkyv::check_archived_root::<SigmaRkyv>(&mmap).map_err(|err| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Invalid sigma archive: {err:?}"),
            )
        })?;
        Ok(Self { mmap })
    }

    pub fn sigma(&self) -> &ArchivedSigmaRkyv {
        // Safe because we validated the archive on load and the mmap lives with self.
        unsafe { rkyv::archived_root::<SigmaRkyv>(&self.mmap) }
    }
}

impl SigmaHolder {
    pub fn load(path: &Path) -> std::io::Result<Self> {
        let inner = SigmaZeroCopy::load(path)?;
        #[cfg(feature = "timing")]
        let decode_start = Instant::now();
        let decoded_xy_powers = inner.sigma().sigma_1.decode_xy_powers();
        #[cfg(feature = "timing")]
        libs::timing::record(
            "sigma.full_grid_decode",
            "encode_cache_build",
            decode_start.elapsed(),
            vec![libs::timing::SizeInfo {
                label: "points",
                dims: vec![decoded_xy_powers.len()],
            }],
        );
        Ok(Self {
            inner,
            decoded_xy_powers,
        })
    }

    pub fn sigma1(&self) -> Sigma1Handle<'_> {
        Sigma1Handle {
            archived: &self.inner.sigma().sigma_1,
            decoded_xy_powers: &self.decoded_xy_powers,
        }
    }
}

pub struct Sigma1Handle<'a> {
    archived: &'a ArchivedSigma1Rkyv,
    decoded_xy_powers: &'a [G1Affine],
}

impl<'a> Sigma1Handle<'a> {
    pub fn encode_poly(&self, poly: &mut DensePolynomialExt, params: &SetupParams) -> G1serde {
        self.archived
            .encode_poly_with_decoded_xy_powers(poly, params, self.decoded_xy_powers)
    }

    pub fn encode_poly_timed(
        &self,
        poly: &mut DensePolynomialExt,
        params: &SetupParams,
        timing_name: &'static str,
    ) -> G1serde {
        self.archived.encode_poly_timed_with_decoded_xy_powers(
            poly,
            params,
            self.decoded_xy_powers,
            timing_name,
        )
    }

    pub fn encode_O_pub_free(
        &self,
        placement_variables: &[PlacementVariables],
        public_wire_layout: &PublicWireLayout,
    ) -> G1serde {
        self.archived
            .encode_O_pub_free(placement_variables, public_wire_layout)
    }

    pub fn encode_O_pub_fix(
        &self,
        a_pub_function: &[HexString],
        setup_params: &SetupParams,
    ) -> G1serde {
        self.archived.encode_O_pub_fix(a_pub_function, setup_params)
    }

    pub fn encode_O_mid_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        self.archived
            .encode_O_mid_no_zk(placement_variables, subcircuit_infos, setup_params)
    }

    pub fn encode_O_prv_no_zk(
        &self,
        placement_variables: &[PlacementVariables],
        subcircuit_infos: &[SubcircuitInfo],
        setup_params: &SetupParams,
    ) -> G1serde {
        self.archived
            .encode_O_prv_no_zk(placement_variables, subcircuit_infos, setup_params)
    }

    pub fn delta(&self) -> G1serde {
        self.archived.delta()
    }

    pub fn eta(&self) -> G1serde {
        self.archived.eta()
    }

    pub fn delta_inv_alphak_xh_tx(&self, k: usize, h: usize) -> G1serde {
        self.archived.delta_inv_alphak_xh_tx(k, h)
    }

    pub fn delta_inv_alpha4_xj_tx(&self, j: usize) -> G1serde {
        self.archived.delta_inv_alpha4_xj_tx(j)
    }

    pub fn delta_inv_alphak_yi_ty(&self, k: usize, i: usize) -> G1serde {
        self.archived.delta_inv_alphak_yi_ty(k, i)
    }
}
