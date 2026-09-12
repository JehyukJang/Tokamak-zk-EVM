//! Online-only U32--U35 verification. Circuit admission belongs to preprocess.
mod decode;
pub mod univariate_cli;

use ark_bls12_381::{Bls12_381, Fr, G1Affine, G1Projective};
use ark_ec::{pairing::Pairing, AffineRepr, CurveGroup};
use ark_ff::{batch_inversion, Field, One, PrimeField, Zero};
use backend_interface::{PreprocessBytes, ProofBytes};
use backend_univariate_crs_interface::{archive, VerifierKeysRkyv};
use libs::univariate_field::canonical_root;
use libs::univariate_transcript::{derive_binary_proof_challenges, UnivariateChallenges};

/// Library-owned geometry embedded at build time, never loaded online.
pub mod parameters {
    include!(concat!(env!("OUT_DIR"), "/verifier_parameters.rs"));
}

#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("invalid verifier input: {0}")]
    Invalid(String),
    #[error("{}: {source}", path.display())]
    Io {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    #[error("cannot write verification result: {reason}")]
    MachineResult { reason: String },
}
impl From<&str> for VerifyError {
    fn from(value: &str) -> Self {
        Self::Invalid(value.into())
    }
}
impl libs::cli::CliDiagnostic for VerifyError {
    fn hint(&self) -> &'static str {
        "Use current binary verifier keys, admitted preprocess and proof, with the matching library build and free public inputs."
    }
}

/// Decoded fixed operands for repeated online verification. Construction only
/// checks encodings; it does not perform circuit or ceremony admission.
pub struct Verifier {
    one: G1Affine,
    xi: G1Affine,
    psi: G1Affine,
    g2: [<Bls12_381 as Pairing>::G2Prepared; 5],
    s_c: G1Affine,
    c_fix: G1Affine,
    connection_root: Fr,
    public_roots: Vec<Fr>,
}

impl Verifier {
    pub fn from_bytes(keys: &[u8], preprocess: &[u8]) -> Result<Self, VerifyError> {
        let keys = archive::from_bytes::<VerifierKeysRkyv, archive::rancor::Error>(keys)
            .map_err(|e| VerifyError::Invalid(format!("verifier keys archive: {e}")))?;
        if keys.schema_id != libs::univariate_crs::UNIVARIATE_CRS_SCHEMA_ID {
            return Err("unsupported verifier CRS schema".into());
        }
        let preprocess = PreprocessBytes::decode(preprocess)?;
        let one = decode::key_g1(&keys.one_g1)?;
        let one_g2 = decode::key_g2(&keys.one_g2)?;
        // Setup samples independent source-group generators; they are not
        // required to equal arkworks' conventional curve generators.
        if one.is_zero() || one_g2.is_zero() {
            return Err("CRS source-group generators must be nonzero".into());
        }
        let root =
            canonical_root(parameters::L_FREE as usize).expect("build-checked public domain");
        let mut power = Fr::one();
        let public_roots = (0..parameters::L_FREE)
            .map(|_| {
                let value = power;
                power *= root;
                value
            })
            .collect();
        Ok(Self {
            one,
            xi: decode::key_g1(&keys.xi_g1)?,
            psi: decode::key_g1(&keys.psi_g1)?,
            g2: [
                one_g2,
                decode::key_g2(&keys.tau_g2)?,
                decode::key_g2(&keys.tau_k_g2)?,
                decode::key_g2(&keys.delta_g2)?,
                decode::g2(&preprocess.e_kappa)?,
            ]
            .map(Into::into),
            s_c: decode::g1(&preprocess.s_c)?,
            c_fix: decode::g1(&preprocess.c_fix)?,
            connection_root: canonical_root(parameters::N_C as usize)
                .expect("build-checked connection domain"),
            public_roots,
        })
    }

    /// Accept exactly the free-public vector. Fixed public values are already
    /// represented by C_fix and never enter the Fiat--Shamir statement.
    pub fn verify(&self, public_inputs: &[Fr], bytes: &[u8]) -> Result<bool, VerifyError> {
        if public_inputs.len() != parameters::L_FREE as usize {
            return Err("free public input length does not match the built library".into());
        }
        let proof = ProofBytes::decode(bytes)?;
        let points = [
            proof.c_l,
            proof.c_h,
            proof.c_o,
            proof.d_q,
            proof.d_q_k,
            proof.c_d,
            proof.c_r,
            proof.c_q,
            proof.pi_chi,
            proof.pi_plus,
        ];
        let mut decoded = [G1Affine::identity(); 10];
        for (out, bytes) in decoded.iter_mut().zip(points) {
            *out = decode::g1(&bytes)?;
        }
        let [c_l, c_h, c_o, d_q, d_q_k, c_d, c_r, c_q, pi_chi, pi_plus] = decoded;
        let [s_c, u, v, w, b, r, r_plus] = [
            proof.s_c,
            proof.u,
            proof.v,
            proof.w,
            proof.b,
            proof.r,
            proof.r_plus,
        ]
        .map(|bytes| Fr::from_le_bytes_mod_order(&bytes));
        let ch = derive_binary_proof_challenges(
            public_inputs,
            &proof,
            parameters::N_A as usize,
            parameters::N_C as usize,
        );
        let q = quotient_at_challenge(
            &ch,
            [s_c, u, v, w, b, r, r_plus],
            parameters::N_A,
            parameters::N_C,
        );
        let a = evaluate_public(public_inputs, &self.public_roots, ch.chi);
        let varpi2 = ch.varpi.square();
        let varpi3 = varpi2 * ch.varpi;
        let varpi4 = varpi2.square();
        let mu2 = ch.mu.square();
        let mu3 = mu2 * ch.mu;
        let mu4 = mu2.square();
        // U34: A_free is evaluated in the field; fixed inputs have no MSM here.
        let a_chi = c_l + c_h * ch.varpi + c_r * varpi2 + c_q * varpi3 + self.s_c * varpi4
            - self.one * (a + varpi2 * r + varpi3 * q + varpi4 * s_c)
            - self.xi * (u + ch.varpi * v)
            - self.psi * (w + ch.varpi * b);
        let a_plus = c_r - self.one * r_plus;
        let c_e = c_l + c_h * ch.upsilon;
        // U35 with the approved free/fixed-public specialization: subtract
        // C_fix exactly once in the first operand, not in the opening equation.
        let first = c_l - c_d * ch.mu
            + (a_chi + pi_chi * ch.chi) * mu2
            + (a_plus + pi_plus * (self.connection_root * ch.chi)) * mu3
            - d_q_k * mu4
            - self.c_fix;
        let operands = [
            first,
            -(pi_chi * mu2 + pi_plus * mu3),
            c_h + c_e * ch.mu + d_q * mu4,
            -G1Projective::from(c_o),
            G1Projective::from(d_q_k),
        ];
        let affine = G1Projective::normalize_batch(&operands);
        Ok(Bls12_381::multi_pairing(affine, self.g2.clone()).is_zero())
    }
}

fn quotient_at_challenge(ch: &UnivariateChallenges<Fr>, values: [Fr; 7], na: u64, nc: u64) -> Fr {
    let [s_c, u, v, w, b, r, r_plus] = values;
    // Both domains are nested radix-two subgroups with the same canonical root.
    let za = ch.chi.pow([na]) - Fr::one();
    let zc = ch.chi.pow([nc]) - Fr::one();
    let zg = ch.chi.pow([na.min(nc)]) - Fr::one();
    let ma = zc / zg;
    let mc = za / zg;
    let l0 = zc / (Fr::from(nc) * (ch.chi - Fr::one()));
    (ma * (u * v - w)
        + ch.theta * mc * (r - Fr::one()) * l0
        + ch.theta.square()
            * mc
            * (r_plus * (b + ch.beta * ch.chi + ch.gamma_c) - r * (b + ch.beta * s_c + ch.gamma_c)))
        / (za * zc / zg)
}

fn evaluate_public(values: &[Fr], roots: &[Fr], chi: Fr) -> Fr {
    if let Some(index) = roots.iter().position(|root| *root == chi) {
        return values[index];
    }
    let mut denominators: Vec<_> = roots.iter().map(|root| chi - root).collect();
    batch_inversion(&mut denominators);
    let sum: Fr = values
        .iter()
        .zip(roots)
        .zip(denominators)
        .map(|((value, root), inverse)| *value * root * inverse)
        .sum();
    (chi.pow([values.len() as u64]) - Fr::one()) / Fr::from(values.len() as u64) * sum
}

#[cfg(test)]
mod tests;
